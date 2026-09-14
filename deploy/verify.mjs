#!/usr/bin/env node
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const busHome = process.env.DOVSKY_HOME ?? path.join(os.homedir(), ".dovsky");
const socketPath = process.env.DOVSKY_SOCKET ?? path.join(busHome, "run", "dovsky.sock");
const failures = [];
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedHeadProbe = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 });
const expectedHead = expectedHeadProbe.status === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\n?$/.test(expectedHeadProbe.stdout)
  ? expectedHeadProbe.stdout.trim() : null;

function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else {
    console.error(`FAIL ${message}`);
    failures.push(message);
  }
}

function rpc(method, params = {}, idempotencyKey) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = "";
    const timer = setTimeout(() => socket.destroy(new Error("RPC timeout")), 5_000);
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.end(`${JSON.stringify({ id: randomUUID(), method, params, ...(idempotencyKey ? { idempotencyKey } : {}) })}\n`),
    );
    socket.on("data", (chunk) => {
      body += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(body.trim()));
      } catch {
        reject(new Error("invalid daemon response"));
      }
    });
  });
}

let daemonHealthy = false;
try {
  const response = await rpc("health");
  daemonHealthy = response.ok === true && response.result?.ok === true;
  check(daemonHealthy, "daemon RPC is healthy");
} catch (error) {
  check(false, `daemon RPC is healthy (${error.message})`);
}

// The daemon resolves the provider binaries from its own PATH, not this shell's; a reboot can leave it without them.
let doctorChecks = 0;
if (daemonHealthy) {
  try {
    const response = await rpc("doctor");
    if (response.ok !== true || !response.result || typeof response.result !== "object") throw new Error(response.error?.message ?? "invalid doctor RPC envelope");
    const doctor = response.result;
    if (Array.isArray(doctor.checks)) {
      for (const item of doctor.checks) {
        doctorChecks += 1;
        check(item?.ok === true, `doctor ${typeof item?.name === "string" ? item.name : "invalid"}: ${typeof item?.detail === "string" ? item.detail : "missing detail"}`);
      }
    }
    check(doctor.ok === true, "doctor reports healthy");
    check(expectedHead !== null && doctor.source?.head === expectedHead, "daemon source matches checkout HEAD");
    check(doctor.source?.dirty === false, "daemon source checkout is clean");
    check(doctor.schema?.ok === true, "daemon schema is current");
    check(doctor.database?.writable === true, "daemon database is writable");
    check(doctor.sandbox?.available === true, "daemon sandbox is available");
  } catch (error) {
    check(false, `daemon doctor (${error.message})`);
  }
}
check(doctorChecks >= 5, `doctor executed at least 5 checks (observed ${doctorChecks})`);

if (failures.length > 0) {
  console.error(`Verification failed with ${failures.length} check(s).`);
  process.exitCode = 1;
} else {
  console.log("Verification passed.");
}
