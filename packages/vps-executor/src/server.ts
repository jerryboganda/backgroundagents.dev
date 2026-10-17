import { timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { AdmissionError, parseAdmissionLease } from "./admission.ts";
import {
  ContainerNotFoundError,
  IsolationUnavailableError,
  SANDBOX_ID_PATTERN,
  type DockerRuntime,
} from "./docker.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_LENGTH = 256;

/** One sandbox this executor created. */
export interface SandboxRecord {
  sandboxId: string;
  providerObjectId: string;
  sessionId: string;
  createdAtMs: number;
}

export interface StateStore {
  get(sandboxId: string): SandboxRecord | undefined;
  findByProviderObjectId(providerObjectId: string): SandboxRecord | undefined;
  put(record: SandboxRecord): Promise<void>;
  remove(sandboxId: string): Promise<void>;
}

interface StateFile {
  version: 1;
  sandboxes: SandboxRecord[];
}

/*
 * JSON state file. Durability limits (skeleton):
 * - One executor process per file. Nothing stops a second process from writing it.
 * - Every change rewrites the whole file: temp file, fsync, rename. A crash leaves the old or the
 *   new file, never a torn one. The directory is not fsynced, so a power loss right after the
 *   rename can roll back the last change.
 * - Docker and this file are not transactional. A container started just before a failed write
 *   is orphaned. Containers carry open-inspect.managed labels for a future reconcile (not built).
 * - A corrupt file stops startup. It is never silently reset.
 * ponytail: whole-file rewrites and linear lookups; move to SQLite when the sandbox count grows.
 */
export async function openStateStore(path: string): Promise<StateStore> {
  await mkdir(dirname(path), { recursive: true });
  const records = new Map<string, SandboxRecord>();
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  });
  if (text !== undefined) {
    const state = JSON.parse(text) as Partial<StateFile>;
    if (state.version !== 1 || !Array.isArray(state.sandboxes))
      throw new Error("executor state file has an unsupported format");
    for (const record of state.sandboxes) records.set(record.sandboxId, record);
  }

  // Writes are queued so two changes never race on the temp file.
  let queue: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const snapshot: StateFile = { version: 1, sandboxes: [...records.values()] };
    const write = async (): Promise<void> => {
      const tmp = `${path}.tmp`;
      const handle = await open(tmp, "w");
      try {
        await handle.writeFile(JSON.stringify(snapshot));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
    };
    const written = queue.then(write);
    queue = written.catch(() => undefined);
    return written;
  };

  return {
    get: (sandboxId) => records.get(sandboxId),
    findByProviderObjectId: (providerObjectId) =>
      [...records.values()].find((record) => record.providerObjectId === providerObjectId),
    async put(record) {
      records.set(record.sandboxId, record);
      await persist();
    },
    async remove(sandboxId) {
      records.delete(sandboxId);
      await persist();
    },
  };
}

export interface ExecutorServerOptions {
  token: string;
  /** Shared with the control plane; verifies the signature on each admission lease. */
  admissionSecret: string;
  runtime: DockerRuntime;
  store: StateStore;
  now?: () => number;
}

/** HTTP API. Every endpoint except GET /v1/health requires the bearer token. */
export function createExecutorServer(options: ExecutorServerOptions): Server {
  const { token, admissionSecret, runtime, store } = options;
  const now = options.now ?? Date.now;
  // Sandbox ids with a create in flight, so two racing creates cannot both start a container.
  const creating = new Set<string>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "GET" && pathname === "/v1/health") {
      const ok = await runtime.checkIsolation().then(
        () => true,
        () => false
      );
      sendJson(res, ok ? 200 : 503, { ok });
      return;
    }
    if (!isAuthorized(req, token)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (method === "POST" && pathname === "/v1/sandboxes") return createSandbox(req, res);
    const resolveMatch = /^\/v1\/sandboxes\/([^/]+)$/.exec(pathname);
    if (method === "GET" && resolveMatch) return resolveSandbox(res, resolveMatch[1]);
    const stopMatch = /^\/v1\/sandboxes\/([^/]+)\/stop$/.exec(pathname);
    if (method === "POST" && stopMatch) return stopSandbox(req, res, stopMatch[1]);
    sendJson(res, 404, { error: "not_found" });
  }

  async function createSandbox(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req);
    const { sandboxId, sessionId } = body;
    if (typeof sandboxId !== "string" || !SANDBOX_ID_PATTERN.test(sandboxId))
      return sendJson(res, 400, { error: "invalid_sandbox_id" });
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > MAX_TEXT_LENGTH)
      return sendJson(res, 400, { error: "invalid_session_id" });
    try {
      parseAdmissionLease(body.admissionLease, {
        secret: admissionSecret,
        sessionId,
        sandboxId,
        nowMs: now(),
      });
    } catch (error) {
      if (error instanceof AdmissionError)
        return sendJson(res, 403, { error: `admission_${error.failure}` });
      throw error;
    }
    const existing = store.get(sandboxId);
    // Ids can repeat across sessions on one repo: never return another session's container.
    if (existing && existing.sessionId !== sessionId)
      return sendJson(res, 409, { error: "sandbox_id_conflict" });
    if (existing) return sendJson(res, 200, { providerObjectId: existing.providerObjectId });
    if (creating.has(sandboxId)) return sendJson(res, 409, { error: "create_in_progress" });

    creating.add(sandboxId);
    try {
      await startSandbox(res, sandboxId, sessionId);
    } finally {
      creating.delete(sandboxId);
    }
  }

  async function startSandbox(
    res: ServerResponse,
    sandboxId: string,
    sessionId: string
  ): Promise<void> {
    let providerObjectId: string;
    try {
      await runtime.checkIsolation();
      providerObjectId = await runtime.runSandbox(sandboxId);
    } catch (error) {
      if (error instanceof IsolationUnavailableError)
        return sendJson(res, 503, { error: "isolation_unavailable" });
      return sendJson(res, 502, { error: "create_failed" });
    }
    await store.put({ sandboxId, providerObjectId, sessionId, createdAtMs: now() });
    sendJson(res, 201, { providerObjectId });
  }

  function resolveSandbox(res: ServerResponse, sandboxId: string): void {
    const record = store.get(sandboxId);
    if (!record) return sendJson(res, 404, { error: "not_found" });
    sendJson(res, 200, { sandboxId: record.sandboxId, providerObjectId: record.providerObjectId });
  }

  async function stopSandbox(
    req: IncomingMessage,
    res: ServerResponse,
    providerObjectId: string
  ): Promise<void> {
    const body = await readJsonObject(req);
    if (typeof body.reason !== "string" || body.reason.length > MAX_TEXT_LENGTH)
      return sendJson(res, 400, { error: "invalid_reason" });
    const record = store.findByProviderObjectId(providerObjectId);
    if (!record) return sendJson(res, 404, { error: "not_found" });
    try {
      await runtime.removeSandbox(record.providerObjectId);
    } catch (error) {
      if (!(error instanceof ContainerNotFoundError))
        return sendJson(res, 502, { error: "stop_failed" });
      // Already gone: drop the record and answer 404, which the control plane treats as stopped.
      await store.remove(record.sandboxId);
      return sendJson(res, 404, { error: "not_found" });
    }
    await store.remove(record.sandboxId);
    sendJson(res, 200, { stopped: true });
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof RequestError) return sendJson(res, error.status, { error: error.code });
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(`vps-executor: request failed: ${reason}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  });
}

class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, "body_too_large");
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "invalid_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new RequestError(400, "invalid_json");
  return parsed as Record<string, unknown>;
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(req.headers.authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
