// Read-only smoke test against the real Amethyst backend.
// Usage: pnpm smoke
import { AmethystClient } from "../dist/amethyst.js";

const client = new AmethystClient();
try {
  const h = await client.handshake();
  console.log("app:", JSON.stringify(h.application), "protocol:", JSON.stringify(h.protocol));

  const games = await client.call("games.list", {});
  const list = Array.isArray(games) ? games : (games.games ?? games);
  console.log("games:", JSON.stringify(list).slice(0, 500));

  const profiles = await client.call("profiles.list", { game: "No_Man_s_Sky" });
  console.log("nms profiles:", JSON.stringify(profiles).slice(0, 1000));

  const mods = await client.call("mods.list", { game: "No_Man_s_Sky", profile: "default" });
  const summary = JSON.stringify(mods);
  console.log("nms mods.list bytes:", summary.length, "head:", summary.slice(0, 500));
} finally {
  client.close();
}
