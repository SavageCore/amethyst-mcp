#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { AmethystClient } from "./amethyst.js";

const server = new McpServer({ name: "amethyst", version: "0.0.0" });
const client = new AmethystClient();

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] };
}

function errResult(err: unknown) {
  const e = err as { message?: string; code?: number; data?: unknown };
  return jsonResult({ error: e.message ?? String(err), code: e.code, details: e.data ?? null });
}

const NMS_GAME = "No_Man_s_Sky";
const gameParam = z.string().default(NMS_GAME).describe("Canonical Amethyst game ID");
const profileParam = z.string().default("default").describe("Profile name within the game");
const waitParam = z
  .boolean()
  .default(true)
  .describe("Wait for async jobs to reach a final state instead of returning the queued snapshot");
const timeoutParam = z
  .number()
  .int()
  .min(5000)
  .max(1200000)
  .default(300000)
  .describe("Maximum milliseconds to wait for job completion");

// --------------------------------------------------------------------- status

server.registerTool(
  "status",
  {
    title: "Amethyst status",
    description:
      "Handshake with the Amethyst headless service. Returns the manager version, protocol version, and capability summary. Call this first; it also (re)starts the backend.",
    inputSchema: {
      refresh: z.boolean().default(false).describe("Redo the handshake instead of using the cached one"),
      full: z
        .boolean()
        .default(false)
        .describe("Return the entire handshake document including all capabilities"),
    },
  },
  async ({ refresh, full }) => {
    try {
      const h = (await client.handshake(refresh)) as Record<string, unknown>;
      if (full) return jsonResult(h);
      const caps = (h.capabilities ?? {}) as Record<string, unknown>;
      return jsonResult({
        application: h.application,
        protocol: h.protocol,
        capability_keys: Object.keys(caps),
      });
    } catch (err) {
      return errResult(err);
    }
  },
);

// ------------------------------------------------------------------------ call

server.registerTool(
  "call",
  {
    title: "Call headless method",
    description:
      "Full passthrough to one Amethyst headless JSON-RPC method (see docs/headless.md in the Amethyst-Mod-Manager repo for the catalogue, or system.schema.get for JSON schemas). Sync reads (games.list, profiles.list, mods.list, downloads.list, mods.conflicts.*) return directly. For mods.list prefer the list_mods tool (summary by default, ~100KB verbatim otherwise). Job-producing *.start calls return the final job snapshot when wait is true. Only one job runs at a time; overlapping starts queue behind the active job.",
    inputSchema: {
      method: z.string().describe("Headless method name, e.g. mods.list, downloads.install.start, deploy.start"),
      params: z.record(z.string(), z.unknown()).default({}).describe("Method parameters object"),
      wait: waitParam,
      timeout_ms: timeoutParam,
    },
  },
  async ({ method, params, wait, timeout_ms }) => {
    try {
      const result = await client.callAndWait(method, params as Record<string, unknown>, {
        wait,
        timeoutMs: timeout_ms,
      });
      return jsonResult(result);
    } catch (err) {
      return errResult(err);
    }
  },
);

// ------------------------------------------------------------------------- job

server.registerTool(
  "job",
  {
    title: "Inspect and control jobs",
    description:
      "Read or control Amethyst jobs: get the latest snapshot, list jobs, long-poll events, cancel, pause, resume. Job states are queued, running, waiting_for_input, succeeded, failed, cancelled.",
    inputSchema: {
      action: z.enum(["get", "list", "events", "cancel", "pause", "resume"]),
      job_id: z.string().optional().describe("Job ID (required for everything except list)"),
      after: z.number().int().min(0).optional().describe("events: last processed sequence"),
      wait_ms: z.number().int().min(0).max(30000).default(0).describe("events: long-poll wait"),
      active_only: z.boolean().optional().describe("list: only non-final jobs"),
    },
  },
  async ({ action, job_id, after, wait_ms, active_only }) => {
    try {
      const params: Record<string, unknown> = {};
      if (job_id) params.job_id = job_id;
      if (after !== undefined) params.after = after;
      if (action === "events") params.wait_ms = wait_ms;
      if (action === "list" && active_only !== undefined) params.active_only = active_only;
      const method =
        action === "get" ? "jobs.get" : action === "list" ? "jobs.list" : `jobs.${action}`;
      return jsonResult(await client.call(method, params));
    } catch (err) {
      return errResult(err);
    }
  },
);

// ----------------------------------------------------------------- list_mods

interface ModEntry {
  kind?: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  index?: number;
}

server.registerTool(
  "list_mods",
  {
    title: "List profile mods",
    description:
      "List a profile's mods in priority order. Summary (default) returns counts plus one small entry per mod (index, kind, name, enabled, priority) and stays small even for large profiles. Use detail=full for the complete mods.list document, or the call tool for anything else. Prefer this over call with mods.list.",
    inputSchema: {
      game: gameParam,
      profile: profileParam,
      detail: z.enum(["summary", "full"]).default("summary"),
    },
  },
  async ({ game, profile, detail }) => {
    try {
      const full = (await client.call("mods.list", { game, profile }, 60000)) as Record<
        string,
        unknown
      >;
      if (detail === "full") return jsonResult(full);
      const entries = ((full.mods ?? []) as ModEntry[]).map((m) => ({
        index: m.index,
        kind: m.kind,
        name: m.name,
        enabled: m.enabled,
        priority: m.priority,
      }));
      return jsonResult({
        game: full.game,
        profile: (full.profile as { name?: string } | undefined)?.name ?? profile,
        order: full.order,
        counts: full.counts,
        revision: full.revision,
        mod_count: entries.length,
        enabled_count: entries.filter((e) => e.enabled).length,
        entries,
      });
    } catch (err) {
      return errResult(err);
    }
  },
);

// ----------------------------------------------------------------- install_mod

server.registerTool(
  "install_mod",
  {
    title: "Install a local mod archive",
    description:
      "Install a local mod ZIP (e.g. a freshly built dist/ archive) into an Amethyst profile via downloads.install.start with an absolute archive_path. Local archives do not need to be in a scanned download directory. Returns the final job snapshot. If the job waits for installer input, answer through the call tool (installers.requests.get/submit).",
    inputSchema: {
      archive_path: z.string().describe("Absolute path to the mod archive ZIP"),
      game: gameParam,
      profile: profileParam,
      name: z.string().optional().describe("Override the staged mod name"),
      if_exists: z.enum(["fail", "replace"]).default("replace"),
      installer_policy: z.enum(["reject", "defaults", "verbatim"]).default("defaults"),
      wait: waitParam,
      timeout_ms: timeoutParam,
    },
  },
  async ({ archive_path, game, profile, name, if_exists, installer_policy, wait, timeout_ms }) => {
    try {
      const abs = resolvePath(archive_path);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile()) return jsonResult({ error: `Not a file: ${abs}` });
      const params: Record<string, unknown> = {
        game,
        profile,
        archive_path: abs,
        if_exists,
        installer_policy,
      };
      if (name) params.name = name;
      const result = await client.callAndWait("downloads.install.start", params, {
        wait,
        timeoutMs: timeout_ms,
      });
      return jsonResult(result);
    } catch (err) {
      return errResult(err);
    }
  },
);

// ---------------------------------------------------------------------- deploy

server.registerTool(
  "deploy",
  {
    title: "Deploy profile",
    description:
      "Deploy a profile's mods to the game folder (deploy.start). Creates the normal profile backup first. Returns the final job snapshot.",
    inputSchema: {
      game: gameParam,
      profile: profileParam,
      wait: waitParam,
      timeout_ms: timeoutParam,
    },
  },
  async ({ game, profile, wait, timeout_ms }) => {
    try {
      return jsonResult(
        await client.callAndWait("deploy.start", { game, profile }, { wait, timeoutMs: timeout_ms }),
      );
    } catch (err) {
      return errResult(err);
    }
  },
);

// --------------------------------------------------------------------- restore

server.registerTool(
  "restore",
  {
    title: "Restore game folder",
    description:
      "Restore the game folder to vanilla for the last deployed profile (restore.start), then reload the given profile. Returns the final job snapshot.",
    inputSchema: {
      game: gameParam,
      profile: profileParam,
      wait: waitParam,
      timeout_ms: timeoutParam,
    },
  },
  async ({ game, profile, wait, timeout_ms }) => {
    try {
      const result = await client.callAndWait("restore.start", { game, profile }, {
        wait,
        timeoutMs: timeout_ms,
      });
      return jsonResult(result);
    } catch (err) {
      return errResult(err);
    }
  },
);

// ------------------------------------------------------------------------ main

process.on("SIGTERM", () => client.close());
process.on("SIGHUP", () => client.close());

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("amethyst-mcp ready (backend: Amethyst headless protocol v1)");
