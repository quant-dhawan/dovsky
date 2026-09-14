#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigPath, loadConfig, runtimePathDefaults } from "./config.js";
import { DovskyDaemon } from "./daemon.js";
import { RpcServer } from "./server.js";
import { loadRuntimeSourceMetadata } from "./build-provenance.js";

const retiredEnvironment = ["AGENTBUS_HOME", "AGENTBUS_CONFIG", "AGENTBUS_SOCKET"].filter((name) => process.env[name] !== undefined);
if (retiredEnvironment.length) {
  process.stderr.write(`Refusing retired ${retiredEnvironment.join(", ")}; use DOVSKY_HOME, DOVSKY_CONFIG, or DOVSKY_SOCKET.\n`);
  process.exit(2);
}

function configArgument(argv: string[]): string {
  const index = argv.indexOf("--config");
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value) throw new Error("--config requires a path");
    return resolve(value);
  }
  const fromEnvironment = process.env.DOVSKY_CONFIG;
  if (fromEnvironment) return resolve(fromEnvironment);
  return defaultConfigPath();
}

process.umask(0o077);
const config = loadConfig(configArgument(process.argv.slice(2)), runtimePathDefaults());
const daemon = new DovskyDaemon(config, undefined, loadRuntimeSourceMetadata(
  fileURLToPath(import.meta.url), fileURLToPath(new URL("./build-provenance.json", import.meta.url)),
));
try { await daemon.assertSandboxAvailable(); }
catch (error) { daemon.close(); throw error; }
const server = new RpcServer(daemon, config.socketPath);
let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.all([server.close(), daemon.stop()]);
  daemon.close();
}

await server.listen();
daemon.start();
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.stdout.write(`${JSON.stringify({ event: "dovskyd.ready", socketPath: config.socketPath })}\n`);
// After a reboot the unit's PATH decides whether the providers exist; say so in the journal before the first job fails.
const doctor = (await daemon.call("doctor", {})) as { checks: Array<{ name: string; ok: boolean; detail: string }> };
for (const check of doctor.checks) {
  if (!check.ok) process.stderr.write(`${JSON.stringify({ event: "dovskyd.doctor", check: check.name, detail: check.detail })}\n`);
}
