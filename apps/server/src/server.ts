import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import * as net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";

import {
  createSessionResponseSchema,
  deleteSessionResponseSchema,
  liveDesktopInputSchema,
  listMessagesResponseSchema,
  listSessionsResponseSchema,
  postMessageRequestSchema,
  sessionMutationResponseSchema,
} from "@vnc-cua/contracts";
import cors from "@fastify/cors";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import OpenAI from "openai";
import { SandboxClient } from "tensorlake";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import { createDatabase } from "./db/client.js";
import { loadEnv, type AppEnv } from "./env.js";
import { EventBus } from "./lib/event-bus.js";
import { SessionManager, type OpenAIClientLike, type SandboxClientLike } from "./services/session-manager.js";
import { SessionStore, toSessionSummary } from "./services/session-store.js";

export interface AppBundle {
  app: FastifyInstance;
  sessionManager: SessionManager;
  store: SessionStore;
}

export interface CreateAppOptions {
  env?: AppEnv;
  openai?: OpenAIClientLike;
  sandboxClient?: SandboxClientLike;
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

  const openai =
    options.openai ??
    new OpenAI({
      apiKey: env.OPENAI_KEY,
    });
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

  const sessionManager = new SessionManager({
    store,
    eventBus,
    openai,
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

  await app.register(cors, { origin: true });

  app.get("/api/events", async (_request, reply) => {
    reply.hijack();
    eventBus.subscribe(reply);
  });

  app.get("/api/sessions", async () => {
    return listSessionsResponseSchema.parse({
      sessions: store.listSessionRecords().map(toSessionSummary),
    });
  });

  app.post("/api/sessions", async (_request, reply) => {
    const session = await sessionManager.createSession();
    reply.status(201);
    return createSessionResponseSchema.parse({ session });
  });

  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const sessionId = (request.params as { id: string }).id;
    if (!store.getSessionRecord(sessionId)) {
      reply.status(404);
      return { message: `Session ${sessionId} was not found` };
    }

    return listMessagesResponseSchema.parse({
      messages: store.listMessages(sessionId),
    });
  });

  app.post("/api/sessions/:id/messages", async (request, reply) => {
    const sessionId = (request.params as { id: string }).id;
    const body = postMessageRequestSchema.parse(request.body);
    const session = sessionManager.sendUserMessage(sessionId, body.content);
    reply.status(202);
    return sessionMutationResponseSchema.parse({ session });
  });

  app.get("/api/sessions/:id/screenshot", async (request, reply) => {
    const sessionId = (request.params as { id: string }).id;
    const record = store.getSessionRecord(sessionId);
    if (!record?.lastScreenshotPath) {
      reply.status(404);
      return { message: `Screenshot for ${sessionId} was not found` };
    }

    const bytes = await fs.readFile(record.lastScreenshotPath);
    reply.type("image/png");
    return reply.send(bytes);
  });

  app.get("/api/sessions/:id/live", async (request, reply) => {
    const sessionId = (request.params as { id: string }).id;
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

  app.post("/api/sessions/:id/refresh", async (request) => {
    const sessionId = (request.params as { id: string }).id;
    const session = await sessionManager.refreshScreenshot(sessionId);
    return sessionMutationResponseSchema.parse({ session });
  });

  app.post("/api/sessions/:id/stop", async (request) => {
    const sessionId = (request.params as { id: string }).id;
    const session = sessionManager.stopRun(sessionId);
    return sessionMutationResponseSchema.parse({ session });
  });

  app.delete("/api/sessions/:id", async (request) => {
    const sessionId = (request.params as { id: string }).id;
    const session = await sessionManager.closeSession(sessionId);
    return sessionMutationResponseSchema.parse({ session });
  });

  app.delete("/api/sessions/:id/permanent", async (request) => {
    const sessionId = (request.params as { id: string }).id;
    const deleted = await sessionManager.deleteArchivedSession(sessionId);
    return deleteSessionResponseSchema.parse(deleted);
  });

  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    const vncMatch = /^\/api\/sessions\/([^/]+)\/vnc$/.exec(url.pathname);
    if (vncMatch) {
      const sessionId = decodeURIComponent(vncMatch[1] ?? "");

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
