/**
 * End-to-end smoke test for the installable hand.
 *
 * Starts a hub, spawns `bin/mir-endpoint.js` as a real subprocess (exactly what
 * an operator installs), waits for it to register, runs one allowed command and
 * one denied one, then tears everything down.
 *
 *   npm run smoke:hands
 *
 * This is the check that the packaged artifact works — unit tests exercise the
 * classes, this exercises the thing you actually install.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { MirStore } from "../src/store.ts";
import { HandsHub } from "../src/hands/hub.ts";
import { HandsServer } from "../src/hands/server.ts";
import { HandsClient } from "../src/hands/client.ts";
import { hashToken } from "../src/hands/protocol.ts";
import { createLogger } from "../src/telemetry.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mir-smoke-"));
const log = createLogger({ level: "info", format: "text" });
const store = MirStore.open(dir);
const token = "smoke-token-0123456789abcdef";
store.createEndpoint({ id: "smoke", name: "Smoke Box", tokenHash: hashToken(token) });

const hub = new HandsHub({ store, log, heartbeatMs: 500, offlineGraceMs: 5000 });
hub.start();
const server = new HandsServer({
  hub, store, log, host: "127.0.0.1", port: 0, enabled: true,
  socketPath: path.join(dir, "hands.sock"),
});
await server.start();
console.log("hub listening on", server.port);

const child = spawn(process.execPath, [
  path.resolve("bin/mir-endpoint.js"),
  "--hub", `127.0.0.1:${server.port}`,
  "--id", "smoke",
  "--token", token,
  "--name", "Smoke Box",
  "--root", dir,
  "--allow", "echo,ls,cat,node",
  "--fs", "rw",
  "--heartbeat", "500",
], { stdio: ["ignore", "inherit", "inherit"] });

const client = new HandsClient({ socketPath: path.join(dir, "hands.sock"), agent: "smoke" });
await client.connect();

for (let i = 0; i < 60; i++) {
  const hands = hub.listHands();
  if (hands.some((h) => h.endpointId === "smoke" && h.connected)) break;
  await new Promise((r) => setTimeout(r, 100));
}
const hands = hub.listHands();
console.log("hands:", hands.map((h) => `${h.endpointId}(${h.kind})`).join(","));
if (!hands.some((h) => h.endpointId === "smoke")) { console.error("FAIL: endpoint never registered"); process.exit(1); }

const res = await client.call({ op: "exec", input: { argv: ["echo", "hello-from-the-installed-bin"] }, endpointId: "smoke" });
console.log("exec:", JSON.stringify({ ok: res.ok, stdout: res.stdout?.trim(), endpoint: res.endpointId }));
// The allowlist: `rm` was never granted, so it must be refused.
const denied = await client.call({ op: "exec", input: { argv: ["rm", "-rf", dir] }, endpointId: "smoke" });
console.log("denied:", denied.ok, denied.error);

// Sandbox: inside the root works, outside is blocked by the OS (srt).
const insideWrite = await client.call({
  op: "writeFile", input: { path: "inside.txt", content: "ok" }, endpointId: "smoke",
});
// Outside must be somewhere the user cares about; temp dirs are scratch space.
const escapePath = path.join(os.homedir(), ".mir-smoke-escape.txt");
const outsideWrite = await client.call({
  op: "exec",
  input: { argv: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(escapePath)},'x')`] },
  endpointId: "smoke",
});
fs.rmSync(escapePath, { force: true });
console.log("sandboxed writes:", { inside: insideWrite.ok, outside: outsideWrite.ok, blocked: outsideWrite.blocked });

const ok =
  res.ok &&
  res.stdout?.includes("hello-from-the-installed-bin") &&
  denied.ok === false &&
  insideWrite.ok === true &&
  outsideWrite.ok === false &&
  outsideWrite.blocked === true;
console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");

child.kill("SIGTERM");
client.close();
await server.stop();
hub.dispose();
store.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
