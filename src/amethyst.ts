// Persistent NDJSON bridge to Amethyst's headless JSON-RPC service.
// Protocol: one JSON value per stdin line, one response per stdout line,
// diagnostics on stderr. Job-producing `*.start` calls return immediately
// with a `job` snapshot; poll it with `jobs.get` until `state` is one of
// succeeded / failed / cancelled. Only one job may run per process.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface JobSnapshot {
  id: string;
  kind: string;
  state: string;
  waiting_for?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface RpcError extends Error {
  code?: number;
  data?: unknown;
}

const FINAL_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

function backendArgv(): string[] {
  const cli = process.env.AMETHYST_CLI?.trim();
  if (cli) return [cli, "headless", "--stdio"];
  return [
    "flatpak",
    "run",
    "--command=amethyst-mod-manager-cli",
    "io.github.Amethyst.ModManager",
    "headless",
    "--stdio",
  ];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class AmethystClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<string | number, Pending>();
  private sendQueue: Promise<void> = Promise.resolve();
  private nextId = 1;
  private handshakeResult: unknown = null;
  private activeJobId: string | null = null;

  private ensureStarted(): void {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return;
    const argv = backendArgv();
    const proc = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.handshakeResult = null;
    proc.on("error", (err) => this.failAll(err));
    proc.on("exit", (code, signal) => {
      this.proc = null;
      this.failAll(new Error(`amethyst headless exited (code=${code} signal=${signal})`));
    });
    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => this.onLine(line));
    proc.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[amethyst] ${chunk}`);
    });
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      console.error(`amethyst-mcp: unparsable stdout line: ${trimmed.slice(0, 200)}`);
      return;
    }
    const id = msg.id as string | number | undefined;
    if (id !== undefined && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) {
        const e = msg.error as { code?: number; message?: string; data?: unknown };
        const err = new Error(`amethyst: ${e.message ?? "request failed"}`) as RpcError;
        err.code = e.code;
        err.data = e.data;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
    } else {
      console.error(`amethyst-mcp: unsolicited message: ${trimmed.slice(0, 300)}`);
    }
  }

  /** Raw JSON-RPC call. Resolves with `result`, rejects with `error`. */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.sendQueue = this.sendQueue.then(() => {
        this.ensureStarted();
        const id = this.nextId++;
        const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`amethyst: timed out after ${timeoutMs}ms waiting for ${method}`));
        }, timeoutMs);
        // Clear timer when settled so a live process does not keep us alive.
        const wrappedResolve = (v: unknown) => {
          clearTimeout(timer);
          resolve(v);
        };
        const wrappedReject = (e: Error) => {
          clearTimeout(timer);
          reject(e);
        };
        this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, timer });
        this.proc!.stdin!.write(line + "\n", (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      });
    });
  }

  async handshake(refresh = false): Promise<unknown> {
    if (!refresh && this.handshakeResult) return this.handshakeResult;
    const result = await this.call("system.handshake", {
      protocol_version: 1,
      client: { name: "amethyst-mcp", version: "0.0.0" },
    });
    this.handshakeResult = result;
    return result;
  }

  private jobOf(result: unknown): JobSnapshot | null {
    if (result && typeof result === "object" && "job" in result) {
      const job = (result as { job: JobSnapshot }).job;
      if (job && typeof job.id === "string") return job;
    }
    return null;
  }

  private isLockBusy(snapshot: JobSnapshot): boolean {
    const err = snapshot.error as { name?: string; details?: { reason?: string } } | null;
    if (!err) return false;
    if (err.name === "operation_busy") return true;
    const reason = err.details?.reason ?? "";
    return (
      reason.includes("another Amethyst process") || reason.includes("filegraph library is busy")
    );
  }

  /**
   * Call a method; when the result carries a job snapshot and `wait` is set,
   * poll `jobs.get` until it reaches a final state and return that snapshot.
   * A job in `waiting_for_input` is returned immediately so the caller can
   * answer through `installers.requests.*` instead of blocking.
   * A `*.start` that fails only because the desktop GUI holds the library
   * lock is retried once after 15s; close the desktop manager if it persists.
   */
  async callAndWait(
    method: string,
    params: Record<string, unknown> = {},
    opts: { wait?: boolean; timeoutMs?: number; pollMs?: number; retries?: number } = {},
  ): Promise<unknown> {
    const { wait = true, timeoutMs = 300000, pollMs = 1500, retries = 1 } = opts;
    if (method.endsWith(".start") && !method.startsWith("jobs.")) {
      await this.awaitActiveJob(timeoutMs);
    }
    let attempt = 0;
    for (;;) {
      const result = await this.call(method, params, Math.min(timeoutMs, 120000));
      const job = this.jobOf(result);
      if (!job || !wait) {
        if (job) this.activeJobId = job.id;
        return result;
      }
      if (job.state === "waiting_for_input") return result;
      const final = await this.waitForJob(job.id, { timeoutMs, pollMs });
      if (final.state === "failed" && attempt < retries && this.isLockBusy(final)) {
        attempt++;
        console.error(
          `amethyst-mcp: library locked by another process, retrying ${method} in 15s (attempt ${attempt + 1})`,
        );
        await new Promise((r) => setTimeout(r, 15000));
        continue;
      }
      return final;
    }
  }

  private async awaitActiveJob(timeoutMs: number): Promise<void> {
    if (!this.activeJobId) return;
    try {
      await this.waitForJob(this.activeJobId, { timeoutMs, pollMs: 2000 });
    } finally {
      this.activeJobId = null;
    }
  }

  async waitForJob(
    jobId: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<JobSnapshot> {
    const { timeoutMs = 300000, pollMs = 1500 } = opts;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const raw = (await this.call("jobs.get", { job_id: jobId }, 60000)) as {
        job?: JobSnapshot;
      } & Partial<JobSnapshot>;
      // jobs.get wraps the snapshot as {job}; tolerate a bare snapshot too.
      const snapshot: JobSnapshot = (raw.job ?? raw) as JobSnapshot;
      if (snapshot.state === "waiting_for_input") return snapshot;
      if (FINAL_STATES.has(snapshot.state)) {
        if (this.activeJobId === jobId) this.activeJobId = null;
        if (snapshot.state === "interrupted") {
          throw new Error(
            `amethyst: job ${jobId} interrupted, outcome unknown; inspect manager state before retrying`,
          );
        }
        return snapshot;
      }
      if (Date.now() > deadline) {
        this.activeJobId = jobId;
        throw new Error(
          `amethyst: job ${jobId} still ${snapshot.state} after ${timeoutMs}ms; ` +
            `it keeps running server-side, re-poll with the job tool`,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  close(): void {
    // Closing stdin lets accepted jobs drain, then the service exits.
    try {
      this.proc?.stdin?.end();
    } catch {
      /* already gone */
    }
  }
}

export const FINAL_JOB_STATES = [...FINAL_STATES];
