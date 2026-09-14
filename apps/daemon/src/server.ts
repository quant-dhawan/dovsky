import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { RpcRequest, RpcResponse } from "@dovsky/protocol";
import { DaemonError } from "./config.js";
import type { DovskyDaemon } from "./daemon.js";
import { OPERATOR_ORIGIN, type RpcOrigin } from "./rpc-origin.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 250;

async function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => resolvePromise(false));
  });
}

function errorResponse(id: string, error: unknown): RpcResponse {
  const daemonError = error instanceof DaemonError ? error : null;
  return {
    id,
    ok: false,
    error: {
      code: daemonError?.code ?? "INTERNAL",
      message: daemonError?.message ?? (error instanceof Error ? error.message : "Internal daemon error"),
      retryable: daemonError?.retryable ?? false,
    },
  };
}

export class RpcServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    readonly daemon: DovskyDaemon,
    readonly socketPath: string,
    readonly origin: RpcOrigin = OPERATOR_ORIGIN,
  ) { this.origin = Object.freeze({ ...origin }); }

  async listen(): Promise<void> {
    if (this.server) throw new Error("RPC server is already listening");
    if (existsSync(this.socketPath)) {
      if (!lstatSync(this.socketPath).isSocket()) {
        throw new Error(`Refusing to replace non-socket path: ${this.socketPath}`);
      }
      if (await socketIsLive(this.socketPath)) throw new Error(`Another daemon is listening at ${this.socketPath}`);
      unlinkSync(this.socketPath);
    }
    const server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    chmodSync(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    if (!server.listening) return;
    const closed = new Promise<void>((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolvePromise) => {
        timer = setTimeout(resolvePromise, CLOSE_GRACE_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    for (const socket of this.sockets) socket.destroy();
    await closed;
    if (existsSync(this.socketPath) && lstatSync(this.socketPath).isSocket()) unlinkSync(this.socketPath);
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    let decoder = new StringDecoder("utf8");
    let pending = "";
    let inFlight = 0;
    let inputEnded = false;
    const finish = () => { if (inputEnded && inFlight === 0 && !socket.destroyed) socket.end(); };
    socket.on("end", () => { inputEnded = true; finish(); });
    let pendingBytes = 0;
    let terminal = false;
    socket.on("data", (chunkValue: Buffer | string) => {
      if (terminal) return;
      let chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      while (chunk.byteLength > 0) {
        const newline = chunk.indexOf(0x0a);
        const body = newline < 0 ? chunk : chunk.subarray(0, newline);
        pendingBytes += body.byteLength;
        if (pendingBytes > MAX_REQUEST_BYTES) {
          terminal = true;
          socket.end(`${JSON.stringify(errorResponse("unknown", new DaemonError("REQUEST_TOO_LARGE", "RPC request is too large")))}\n`);
          return;
        }
        pending += decoder.write(body);
        if (newline < 0) return;
        pending += decoder.end();
        const line = pending;
        pending = "";
        pendingBytes = 0;
        decoder = new StringDecoder("utf8");
        if (line.trim()) {
          inFlight += 1;
          void this.handleLine(socket, line).finally(() => { inFlight -= 1; finish(); });
        }
        chunk = chunk.subarray(newline + 1);
      }
    });
    socket.on("error", () => undefined);
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      socket.write(`${JSON.stringify(errorResponse("unknown", new DaemonError("INVALID_JSON", "Malformed JSON request")))}\n`);
      return;
    }
    const request = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Partial<RpcRequest>
      : null;
    const id = typeof request?.id === "string" ? request.id : "unknown";
    try {
      if (!request || typeof request.id !== "string" || !request.id || typeof request.method !== "string" || !request.method) {
        throw new DaemonError("INVALID_REQUEST", "RPC id and method are required strings");
      }
      if (request.idempotencyKey !== undefined && typeof request.idempotencyKey !== "string") {
        throw new DaemonError("INVALID_REQUEST", "RPC idempotencyKey must be a string");
      }
      const result = await this.daemon.call(request.method, request.params ?? {}, request.idempotencyKey, this.origin);
      const response: RpcResponse = { id, ok: true, result };
      socket.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify(errorResponse(id, error))}\n`);
    }
  }
}
