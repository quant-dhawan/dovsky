#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import type { RpcRequest, RpcResponse } from "@dovsky/protocol";
import { scanLegacySpool } from "./index.js";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function rpc(socketPath: string, request: RpcRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    const timer = setTimeout(() => socket.destroy(new Error("daemon RPC timed out")), 15_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.length > 16 * 1024 * 1024) socket.destroy(new Error("daemon response too large"));
    });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      if (!data.trim()) return reject(new Error("daemon returned an empty response"));
      try {
        const response = JSON.parse(data.trim()) as RpcResponse;
        if (!response.ok) return reject(new Error(response.error?.message ?? "legacy import failed"));
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

const dovskyHome = process.env.DOVSKY_HOME ?? path.join(os.homedir(), ".dovsky");
// The predecessor spool remains explicit read-only migration input.
const spool = option("--source") ?? option("--spool") ?? path.join(os.homedir(), ".agentbus", "jobs");
const socketPath = option("--socket") ?? path.join(dovskyHome, "run", "dovsky.sock");
const apply = process.argv.includes("--apply");
const scan = await scanLegacySpool(spool);
const spoolKey = createHash("sha256")
  .update(path.resolve(spool))
  .update("\0")
  .update(JSON.stringify(scan.jobs))
  .digest("hex")
  .slice(0, 40);

if (!apply) {
  console.log(
    JSON.stringify(
      {
        ...scan,
        jobs: scan.jobs.map((job) => ({
          sourceJobId: job.sourceJobId,
          provider: job.provider,
          state: job.state,
          createdAt: job.createdAt,
          warnings: job.warnings,
        })),
      },
      null,
      2,
    ),
  );
  console.error("Dry run only. Pass --apply to import through the daemon; legacy files are never modified.");
} else {
  const result = await rpc(socketPath, {
    id: randomUUID(),
    method: "legacy.import",
    params: { jobs: scan.jobs },
    idempotencyKey: `legacy-import:${spoolKey}`,
  });
  console.log(
    JSON.stringify(
      {
        scan: {
          scanned: scan.scanned,
          eligible: scan.eligible,
          skipped: scan.skipped,
          warnings: scan.warnings,
        },
        result,
      },
      null,
      2,
    ),
  );
}
