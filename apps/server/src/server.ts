import fs from "node:fs/promises";
import path from "node:path";

import {
  createSessionResponseSchema,
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

  app.setErrorHandler((error, _request, reply) => {
    const message =
      error instanceof Error ? error.message : "Unknown server error";
    const statusCode =
      message.includes("not found")
        ? 404
        : message.includes("already running")
          ? 409
          : message.includes("still booting")
            ? 409
          : message.includes("terminated")
            ? 409
            : 500;

    reply.status(statusCode).send({
      message,
    });
  });

  app.addHook("onClose", async () => {
    eventBus.close();
    await sessionManager.shutdown();
    sqlite.close();
  });

  if (options.restoreOnStartup !== false) {
    await sessionManager.restoreSessions();
  }

  return { app, sessionManager, store };
}
