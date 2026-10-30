// Mutation path test: install a real dist zip into the scratch "Test"
// profile (staging only, game folder untouched), verify, remove it.
// Usage: node scripts/e2e-install.mjs
import { AmethystClient } from "../dist/amethyst.js";

const GAME = "No_Man_s_Sky";
const PROFILE = "Test";
const ZIP = "/home/savagecore/Modding/NMS/shutup-refiners/dist/Shut Up Refiners.zip";
const NAME = "_mcp_probe_shutup_refiners";

const client = new AmethystClient();
try {
  const started = await client.call("downloads.install.start", {
    game: GAME,
    profile: PROFILE,
    archive_path: ZIP,
    name: NAME,
    if_exists: "replace",
    installer_policy: "defaults",
  });
  console.log("start:", JSON.stringify(started).slice(0, 400));
  const final = await client.waitForJob(started.job.id, { timeoutMs: 240000 });
  console.log("final state:", final.state);
  console.log("result:", JSON.stringify(final.result).slice(0, 800));
  if (final.error) console.log("error:", JSON.stringify(final.error).slice(0, 1000));
  if (final.state !== "succeeded") process.exitCode = 1;

  const mods = await client.call("mods.list", { game: GAME, profile: PROFILE });
  const names = (mods.mods ?? []).map((m) => m.name ?? m);
  console.log("probe present:", names.includes(NAME));

  const rmStarted = await client.call("mods.remove.start", {
    game: GAME,
    profile: PROFILE,
    mods: [NAME],
    confirm: true,
  });
  const rmFinal = await client.waitForJob(rmStarted.job.id, { timeoutMs: 120000 });
  console.log("remove state:", rmFinal.state);

  const after = await client.call("mods.list", { game: GAME, profile: PROFILE });
  const afterNames = (after.mods ?? []).map((m) => m.name ?? m);
  console.log("probe cleaned up:", !afterNames.includes(NAME));
} finally {
  client.close();
}
