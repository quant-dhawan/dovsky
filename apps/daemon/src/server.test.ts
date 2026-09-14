import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RpcResponse } from "@dovsky/protocol";
import type { DovskyDaemon } from "./daemon.js";
import { RpcServer } from "./server.js";
import type { RpcOrigin } from "./rpc-origin.js";

async function fixture(call: DovskyDaemon["call"], origin?: RpcOrigin): Promise<{
  server: RpcServer;
  socketPath: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "dovsky-server-"));
  const socketPath = join(directory, "daemon.sock");
  const server = new RpcServer({ call } as DovskyDaemon, socketPath, origin);
  await server.listen();
  return {
    server,
    socketPath,
    cleanup: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function exchange(socketPath: string, chunks: Buffer[]): Promise<RpcResponse> {
  return new Promise<RpcResponse>((resolvePromise, reject) => {
    const socket = connect(socketPath);
    let response = "";
    socket.once("error", reject);
    socket.once("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolvePromise(JSON.parse(response.slice(0, newline)) as RpcResponse);
    });
  });
}

test("RPC rejects null and non-object request envelopes without calling the daemon", async () => {
  let calls = 0;
  const value = await fixture(async () => {
    calls += 1;
    return {};
  });
  try {
    for (const request of ["null\n", "[]\n", "42\n"]) {
      const response = await exchange(value.socketPath, [Buffer.from(request)]);
      assert.equal(response.ok, false);
      assert.equal(response.error?.code, "INVALID_REQUEST");
    }
    assert.equal(calls, 0);
  } finally {
    await value.cleanup();
  }
});

test('RPC origin is copied from the listener, never selected by request fields', async () => {
  const origin: { kind: 'job'; jobId: string } = {kind:'job',jobId:'bound-job'};
  let observed: RpcOrigin | undefined;
  const value = await fixture(async (_method,_params,_key,caller) => {observed=caller;return {};},origin);
  try {
    origin.jobId='forged-after-listen';
    const response=await exchange(value.socketPath,[Buffer.from(JSON.stringify({id:'request',method:'probe',origin:{kind:'operator'},params:{origin:{kind:'operator'}}})+'\n')]);
    assert.equal(response.ok,true);
    assert.deepEqual(observed,{kind:'job',jobId:'bound-job'});
    assert.ok(Object.isFrozen(observed));
  } finally {await value.cleanup();}
});

test("RPC incrementally decodes a UTF-8 request split inside a character", async () => {
  let observed: unknown;
  const value = await fixture(async (_method, params) => {
    observed = params;
    return { accepted: true };
  });
  try {
    const request = Buffer.from(`${JSON.stringify({ id: "utf8-request", method: "probe", params: { text: "漢字" } })}\n`);
    const character = request.indexOf(Buffer.from("漢"));
    assert(character >= 0);
    const response = await exchange(value.socketPath, [request.subarray(0, character + 1), request.subarray(character + 1)]);
    assert.equal(response.ok, true);
    assert.deepEqual(observed, { text: "漢字" });
  } finally {
    await value.cleanup();
  }
});

test("RPC request limits count raw bytes", async () => {
  let calls = 0;
  const value = await fixture(async () => {
    calls += 1;
    return {};
  });
  try {
    const request = Buffer.from(`${JSON.stringify({ id: "large-request", method: "probe", params: { text: "漢".repeat(350_000) } })}\n`);
    const response = await exchange(value.socketPath, [request]);
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, "REQUEST_TOO_LARGE");
    assert.equal(calls, 0);
  } finally {
    await value.cleanup();
  }
});

test("RPC close destroys an accepted idle client after a bounded grace period", async () => {
  const value = await fixture(async () => ({}));
  const socket = connect(value.socketPath);
  socket.on("error", () => undefined);
  await new Promise<void>((resolvePromise) => socket.once("connect", resolvePromise));
  const clientClosed = new Promise<void>((resolvePromise) => socket.once("close", () => resolvePromise()));
  const started = Date.now();
  try {
    await value.server.close();
    await clientClosed;
    assert(Date.now() - started < 1_000);
  } finally {
    socket.destroy();
    await value.cleanup();
  }
});

test("RPC half-close waits for asynchronous operation receipts before closing", async () => {
  const value = await fixture(async () => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    return { state: "verified", operationId: "fixture-only" };
  });
  try {
    const response = await new Promise<string>((resolvePromise, reject) => {
      const socket = connect(value.socketPath);
      let received = "";
      socket.setEncoding("utf8");
      socket.setTimeout(2_000, () => socket.destroy(new Error("Response timed out")));
      socket.once("connect", () => socket.end(`${JSON.stringify({ id: "test", method: "releases.operations.execute", params: { operationId: "fixture-only" } })}\n`));
      socket.on("data", (chunk: string) => { received += chunk; });
      socket.once("error", reject);
      socket.once("close", () => resolvePromise(received));
    });
    assert.deepEqual(JSON.parse(response).result, { state: "verified", operationId: "fixture-only" });
  } finally {
    await value.cleanup();
  }
});

test("disconnecting an RPC caller does not cancel or repeat a dispatched operation", async () => {
  let dispatched!: () => void;
  const started = new Promise<void>((resolvePromise) => { dispatched = resolvePromise; });
  let settle!: () => void;
  const released = new Promise<void>((resolvePromise) => { settle = resolvePromise; });
  let calls = 0;
  let completed = false;
  const value = await fixture(async () => {
    calls += 1;
    dispatched();
    await released;
    completed = true;
    return { state: "verified" };
  });
  const socket = connect(value.socketPath);
  socket.on("error", () => undefined);
  try {
    socket.once("connect", () => socket.end(`${JSON.stringify({ id: "test", method: "releases.operations.execute" })}\n`));
    await started;
    socket.destroy();
    settle();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    assert.equal(calls, 1);
    assert.equal(completed, true);
  } finally {
    settle();
    socket.destroy();
    await value.cleanup();
  }
});
