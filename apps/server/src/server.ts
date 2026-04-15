import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import * as net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  createSessionResponseSchema,
  deleteSessionResponseSchema,
  liveDesktopInputSchema,
  listMessagesResponseSchema,
  listSessionsResponseSchema,
  postMessageRequestSchema,
  sessionMutationResponseSchema,
} from "@vnc-cua/contracts";
import fastifyCookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { SandboxClient } from "tensorlake";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import { createDatabase } from "./db/client.js";
import { loadEnv, type AppEnv } from "./env.js";
import { EventBus } from "./lib/event-bus.js";
import {
  SessionManager,
  type GeminiClientLike,
  type OpenAIClientLike,
  type SandboxClientLike,
} from "./services/session-manager.js";
import { SessionStore, toSessionSummary, type SessionProvider } from "./services/session-store.js";

export interface AppBundle {
  app: FastifyInstance;
  sessionManager: SessionManager;
  store: SessionStore;
}

export interface CreateAppOptions {
  env?: AppEnv;
  openai?: OpenAIClientLike;
  gemini?: GeminiClientLike;
  sandboxClient?: SandboxClientLike;
  preferredProvider?: SessionProvider;
  restoreOnStartup?: boolean;
  statusCheckIntervalMs?: number;
  screenshotDir?: string;
  logger?: FastifyBaseLogger | boolean;
}

export async function createApp(options: CreateAppOptions = {}): Promise<AppBundle> {
  const env = options.env ?? loadEnv();
  const { sqlite, db } = createDatabase(env.APP_DB_PATH);
  const store = new SessionStore(db);
  const eventBus = new EventBus();
  const webDistDir = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

  const openai =
    options.openai ??
    (env.OPENAI_KEY
      ? new OpenAI({
          apiKey: env.OPENAI_KEY,
        })
      : undefined);
  const gemini =
    options.gemini ??
    (env.GEMINI_KEY
      ? new GoogleGenAI({
          apiKey: env.GEMINI_KEY,
        })
      : undefined);
  const sandboxClient =
    options.sandboxClient ??
    SandboxClient.forCloud({
      apiKey: env.TENSORLAKE_API_KEY,
      organizationId: env.TENSORLAKE_ORG_ID,
      ...(env.TENSORLAKE_PROJECT_ID
        ? { projectId: env.TENSORLAKE_PROJECT_ID }
        : {}),
      ...(env.TENSORLAKE_API_URL ? { apiUrl: env.TENSORLAKE_API_URL } : {}),
    });
  const defaultProvider =
    options.preferredProvider ??
    (gemini ? "gemini" : "openai");

  const sessionManager = new SessionManager({
    store,
    eventBus,
    openai,
    gemini,
    defaultProvider,
    sandboxClient,
    screenshotDir:
      options.screenshotDir ??
      path.resolve(path.dirname(env.APP_DB_PATH), "screenshots"),
  });

  const app = Fastify({
    logger: options.logger ?? true,
  });
  const liveInputServer = new WebSocketServer({ noServer: true });
  const vncProxyServer = new WebSocketServer({ noServer: true });
  const statusCheckIntervalMs = options.statusCheckIntervalMs ?? 10_000;
  let statusCheckTimer: ReturnType<typeof setInterval> | null = null;

  await app.register(fastifyCookie);
  await app.register(cors, { origin: true });

  app.get("/api/events", async (request, reply) => {
    const visitorId = ensureVisitorId(request, reply);
    reply.hijack();
    eventBus.subscribe(reply, (event) => eventBelongsToVisitor(store, visitorId, event));
  });

  app.get("/api/sessions", async (request, reply) => {
    const visitorId = ensureVisitorId(request, reply);
    return listSessionsResponseSchema.parse({
      sessions: store.listSessionRecordsForVisitor(visitorId).map(toSessionSummary),
    });
  });

  app.post("/api/sessions", async (request, reply) => {
    const visitorId = ensureVisitorId(request, reply);
    const session = await sessionManager.createSession(visitorId);
    reply.status(201);
    return createSessionResponseSchema.parse({ session });
  });

  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const visitorId = ensureVisitorId(request, reply);
    const sessionId = (request.params as { id: string }).id;
    if (!store.getSessionRecordForVisitor(sessionId, visitorId)) {
      reply.status(404);
      return { message: `Session ${sessionId} was not found` };
    }

    return listMessagesResponseSchema.parse({
      messages: store.listMessages(sessionId),
    });
  });

  app.post("/api/sessions/:id/messages", async (request, reply) => {
    const visitorId = ensureVisitorId(request, reply);
    const sessionId = (request.params as { id: string }).id;
    requireOwnedSession(store, visitorId, sessionId);
    const body = postMessageRequestSchema.parse(request.body);
    const session = sessionManager.sendUserMessage(sessionId, body.content);
    reply.status(202);
    return sessionMutationResponseSchema.parse({ session });
  });

  app.get("/api/sessions/:id/screenshot", async (request, reply) => {
    const visitorId = ensureVisitorId(request, reply);
    const sessionId = (request.params as { id: string }).id;
    const record = store.getSessionRecordForVisitor(sessionId, visitorId);
    if (!record?.lastScreenshotPath) {
      reply.status(404);
      return { message: `Screenshot for ${sessionId} was not found` };
    }

    const bytes = await fs.readFile(record.lastScreenshotPath);
    reply.type("image/png");
    return reply.send(bytes);
  });

  app.get("/api/sessions/:id/live", async (request, reply) => {
    const visitorId = ensureVisitorId(request, reply);
    const sessionId = (request.params as { id: string }).id;
    requireOwnedSession(store, visitorId, sessionId);
    sessionManager.assertLiveDesktopStreamAvailable(sessionId);

    const abortController = new AbortController();
    const closeStream = () => {
      abortController.abort();
    };

    request.raw.on("close", closeStream);
    request.raw.on("error", closeStream);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      Pragma: "no-cache",
      "X-Accel-Buffering": "no",
    });

    try {
      await sessionManager.streamLiveFrames(sessionId, {
        signal: abortController.signal,
        onFrame: async (bytes) => {
          if (abortController.signal.aborted) {
            return;
          }

          reply.raw.write(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${bytes.byteLength}\r\n\r\n`);
          reply.raw.write(Buffer.from(bytes));
          reply.raw.write("\r\n");
        },
      });
    } catch (error) {
      if (!abortController.signal.aborted && app.log) {
        app.log.warn(
          { error, sessionId },
          "live desktop stream ended unexpectedly",
        );
      }
    } finally {
      request.raw.off("close", closeStream);
      request.raw.off("error", closeStream);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  app.post("/api/sessions/:id/refresh", async (request, reply) => {
    const visitorId = ensureVisitorId(request, reply);
    const sessionId = (request.params as { id: string }).id;
    requireOwnedSession(store, visitorId, sessionId);
    const session = await sessionManager.refreshScreenshot(sessionId);
    return sessionMutationResponseSchema.parse({ session });
  });

  app.post("/api/sessions/:id/stop", async (request, reply) => {
    const visitorId = ensureVisitorId(request, reply);
    const sessionId = (request.params as { id: string }).id;
    requireOwnedSession(store, visitorId, sessionId);
    const session = sessionManager.stopRun(sessionId);
    return sessionMutationResponseSchema.parse({ session });
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const visitorId = ensureVisitorId(request, reply);
    const sessionId = (request.params as { id: string }).id;
    requireOwnedSession(store, visitorId, sessionId);
    const session = await sessionManager.closeSession(sessionId);
    return sessionMutationResponseSchema.parse({ session });
  });

  app.delete("/api/sessions/:id/permanent", async (request, reply) => {
    const visitorId = ensureVisitorId(request, reply);
    const sessionId = (request.params as { id: string }).id;
    requireOwnedSession(store, visitorId, sessionId);
    const deleted = await sessionManager.deleteArchivedSession(sessionId);
    return deleteSessionResponseSchema.parse(deleted);
  });

  if (await directoryExists(webDistDir)) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/",
    });

    app.get("/", async (_request, reply) => {
      return reply.sendFile("index.html");
    });

    app.setNotFoundHandler(async (request, reply) => {
      const pathname = new URL(
        request.raw.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      ).pathname;

      if (pathname === "/api" || pathname.startsWith("/api/")) {
        reply.status(404);
        return {
          message: `Route ${pathname} was not found`,
        };
      }

      if (path.extname(pathname)) {
        reply.status(404);
        return {
          message: `Asset ${pathname} was not found`,
        };
      }

      return reply.sendFile("index.html");
    });
  }

  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    const vncMatch = /^\/api\/sessions\/([^/]+)\/vnc$/.exec(url.pathname);
    if (vncMatch) {
      const sessionId = decodeURIComponent(vncMatch[1] ?? "");
      const visitorId = getVisitorIdFromUpgradeRequest(request);
      if (!visitorId || !store.getSessionRecordForVisitor(sessionId, visitorId)) {
        writeUpgradeError(socket, 404, `Session ${sessionId} was not found`);
        return;
      }

      try {
        sessionManager.assertLiveDesktopStreamAvailable(sessionId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to open live VNC";
        writeUpgradeError(socket, statusCodeForMessage(message), message);
        return;
      }

      vncProxyServer.handleUpgrade(request, socket, head, (ws) => {
        bindVncProxySocket(ws, sessionId, sessionManager);
      });
      return;
    }

    const match = /^\/api\/sessions\/([^/]+)\/input$/.exec(url.pathname);
    if (!match) {
      return;
    }

    const sessionId = decodeURIComponent(match[1] ?? "");
    const visitorId = getVisitorIdFromUpgradeRequest(request);
    if (!visitorId || !store.getSessionRecordForVisitor(sessionId, visitorId)) {
      writeUpgradeError(socket, 404, `Session ${sessionId} was not found`);
      return;
    }

    try {
      sessionManager.assertLiveDesktopStreamAvailable(sessionId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to open live input";
      writeUpgradeError(socket, statusCodeForMessage(message), message);
      return;
    }

    liveInputServer.handleUpgrade(request, socket, head, (ws) => {
      bindLiveInputSocket(ws, request, sessionId, sessionManager);
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    const message =
      error instanceof Error ? error.message : "Unknown server error";
    const statusCode = statusCodeForMessage(message);

    reply.status(statusCode).send({
      message,
    });
  });

  app.addHook("onClose", async () => {
    if (statusCheckTimer) {
      clearInterval(statusCheckTimer);
      statusCheckTimer = null;
    }
    eventBus.close();
    for (const client of liveInputServer.clients) {
      client.close();
    }
    liveInputServer.close();
    for (const client of vncProxyServer.clients) {
      client.close();
    }
    vncProxyServer.close();
    await sessionManager.shutdown();
    sqlite.close();
  });

  if (options.restoreOnStartup !== false) {
    await sessionManager.restoreSessions();
  }

  if (statusCheckIntervalMs > 0) {
    statusCheckTimer = setInterval(() => {
      void sessionManager.reconcileSandboxStatuses().catch((error: unknown) => {
        if (app.log) {
          app.log.warn({ error }, "sandbox status reconciliation failed");
        }
      });
    }, statusCheckIntervalMs);
    statusCheckTimer.unref?.();
  }

  return { app, sessionManager, store };
}

const VISITOR_COOKIE_NAME = "vnc_cua_visitor";
const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 5;

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function ensureVisitorId(
  request: { cookies?: Record<string, string | undefined> },
  reply?: { setCookie: (name: string, value: string, options: Record<string, unknown>) => unknown },
): string {
  const existing = request.cookies?.[VISITOR_COOKIE_NAME];
  if (existing) {
    return existing;
  }

  const visitorId = crypto.randomUUID();
  reply?.setCookie(VISITOR_COOKIE_NAME, visitorId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: VISITOR_COOKIE_MAX_AGE_SECONDS,
  });
  return visitorId;
}

function requireOwnedSession(store: SessionStore, visitorId: string, sessionId: string) {
  return store.requireSessionRecordForVisitor(sessionId, visitorId);
}

function getVisitorIdFromUpgradeRequest(request: IncomingMessage): string | null {
  return parseCookieValue(request.headers.cookie, VISITOR_COOKIE_NAME);
}

function parseCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const fragment of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = fragment.trim().split("=");
    if (rawName !== name) {
      continue;
    }

    return decodeURIComponent(rawValue.join("="));
  }

  return null;
}

function eventBelongsToVisitor(
  store: SessionStore,
  visitorId: string,
  event: Parameters<EventBus["publish"]>[0],
): boolean {
  const sessionId =
    event.type === "session.upsert"
      ? event.session.id
      : event.type === "message.created"
        ? event.message.sessionId
        : event.type === "session.deleted" ||
            event.type === "session.terminated" ||
            event.type === "screenshot.updated" ||
            event.type === "run.state"
          ? event.sessionId
          : event.type === "error" && event.sessionId
            ? event.sessionId
            : null;

  if (!sessionId) {
    return false;
  }

  return store.getSessionRecordForVisitor(sessionId, visitorId) !== null;
}

function statusCodeForMessage(message: string): number {
  if (message.includes("not found")) {
    return 404;
  }

  if (
    message.includes("already running") ||
    message.includes("still booting") ||
    message.includes("archived") ||
    message.includes("terminated") ||
    message.includes("currently running")
  ) {
    return 409;
  }

  return 500;
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  const statusText = STATUS_TEXT[statusCode] ?? "Error";
  const body = JSON.stringify({ message });
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
}

const STATUS_TEXT: Record<number, string> = {
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
};

function bindLiveInputSocket(
  socket: WebSocket,
  _request: IncomingMessage,
  sessionId: string,
  sessionManager: SessionManager,
): void {
  let chain = Promise.resolve();

  socket.on("message", (raw: RawData, isBinary: boolean) => {
    if (isBinary) {
      return;
    }

    chain = chain.then(async () => {
      const payload = JSON.parse(raw.toString());
      const event = liveDesktopInputSchema.parse(payload);
      await sessionManager.handleLiveDesktopInput(sessionId, event);
    }).catch((error: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const message =
        error instanceof Error ? error.message : "Invalid live input event";
      socket.send(JSON.stringify({ type: "error", message }));
    });
  });
}

function bindVncProxySocket(
  socket: WebSocket,
  sessionId: string,
  sessionManager: SessionManager,
): void {
  let localSocket: net.Socket | null = null;
  let settled = false;
  const keepAliveInterval = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.ping();
    }
  }, 15_000);

  const finish = () => {
    if (settled) {
      return;
    }
    settled = true;
    clearInterval(keepAliveInterval);
    localSocket?.destroy();
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  };

  socket.on("close", finish);
  socket.on("error", finish);

  void sessionManager.openLiveDesktopVnc(sessionId).then(({ host, port }) => {
    if (settled || socket.readyState !== WebSocket.OPEN) {
      finish();
      return;
    }

    localSocket = net.createConnection({ host, port });
    localSocket.setNoDelay(true);
    localSocket.setKeepAlive(true, 15_000);

    localSocket.on("connect", () => {
      if (settled || socket.readyState !== WebSocket.OPEN) {
        finish();
      }
    });

    localSocket.on("data", (chunk) => {
      if (settled || socket.readyState !== WebSocket.OPEN) {
        finish();
        return;
      }

      socket.send(chunk, { binary: true }, (error?: Error) => {
        if (error) {
          finish();
        }
      });
    });

    localSocket.on("close", finish);
    localSocket.on("end", finish);
    localSocket.on("error", finish);

    socket.on("message", (raw: RawData, isBinary: boolean) => {
      if (!localSocket || settled || localSocket.destroyed) {
        return;
      }

      const payload = normalizeWebSocketData(raw);
      if (isBinary) {
        localSocket.write(payload);
        return;
      }

      localSocket.write(payload.toString("utf8"), "utf8");
    });
  }).catch((error: unknown) => {
    if (settled) {
      return;
    }

    const message = error instanceof Error ? error.message : "Unable to open live VNC";
    socket.close(1011, message.slice(0, 120));
    finish();
  });
}

function normalizeWebSocketData(message: RawData): Buffer {
  if (typeof message === "string") {
    return Buffer.from(message);
  }
  if (Buffer.isBuffer(message)) {
    return message;
  }
  if (Array.isArray(message)) {
    return Buffer.concat(message.map((part) => Buffer.from(part)));
  }
  return Buffer.from(message);
}
