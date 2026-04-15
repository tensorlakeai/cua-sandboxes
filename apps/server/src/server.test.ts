import fs from "node:fs/promises";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import type { LightMyRequestResponse } from "fastify";

import { createApp } from "./server.js";
import {
  FakeDesktop,
  FakeGemini,
  FakeOpenAI,
  FakeSandbox,
  FakeSandboxClient,
  cleanupWorkspace,
  createTempWorkspace,
  createTestEnv,
  tinyPngBytes,
} from "./test/test-helpers.js";

describe("server routes", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  function extractVisitorCookie(response: LightMyRequestResponse): string {
    const setCookieHeader = response.headers["set-cookie"];
    const cookie = Array.isArray(setCookieHeader)
      ? setCookieHeader[0]
      : setCookieHeader;

    if (typeof cookie !== "string") {
      throw new Error("Expected visitor cookie to be set");
    }

    const [cookiePair] = cookie.split(";");
    if (!cookiePair) {
      throw new Error("Expected visitor cookie pair");
    }

    return cookiePair;
  }

  it("creates sessions through the API and serves their screenshots", async () => {
    const workspace = await createTempWorkspace("vnc-cua-server-");
    const sandboxClient = new FakeSandboxClient();
    const openai = new FakeOpenAI();
    const desktop = new FakeDesktop([tinyPngBytes()]);
    sandboxClient.queueSandbox(new FakeSandbox("sbx-api-create", desktop));

    const { app, store, sessionManager } = await createApp({
      env: createTestEnv(workspace.root),
      openai,
      sandboxClient,
      screenshotDir: workspace.screenshotDir,
      restoreOnStartup: false,
      logger: false,
    });

    cleanups.push(async () => {
      await app.close();
      await cleanupWorkspace(workspace.root);
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const payload = created.json() as {
      session: {
        id: string;
        sandboxId: string;
        runState: string;
        lastScreenshotRevision: number;
      };
    };
    const visitorCookie = extractVisitorCookie(created);
    expect(payload.session.runState).toBe("pending");
    expect(payload.session.lastScreenshotRevision).toBe(0);

    await sessionManager.waitForIdle(payload.session.id);

    const stored = store.requireSessionRecord(payload.session.id);

    const screenshot = await app.inject({
      method: "GET",
      url: `/api/sessions/${payload.session.id}/screenshot`,
      headers: {
        cookie: visitorCookie,
      },
    });

    expect(created.statusCode).toBe(201);
    expect(payload.session.sandboxId).toBe("sbx-api-create");
    expect(stored.lastScreenshotRevision).toBe(1);
    expect(await fs.readFile(stored.lastScreenshotPath ?? "")).toEqual(Buffer.from(tinyPngBytes()));
    expect(screenshot.statusCode).toBe(200);
    expect(screenshot.headers["content-type"]).toContain("image/png");
    expect(screenshot.rawPayload).toEqual(Buffer.from(tinyPngBytes()));
  });

  it("prefers Gemini for new sessions when a Gemini key is configured", async () => {
    const workspace = await createTempWorkspace("vnc-cua-server-gemini-");
    const sandboxClient = new FakeSandboxClient();
    const openai = new FakeOpenAI();
    const gemini = new FakeGemini();
    const desktop = new FakeDesktop([tinyPngBytes()]);
    sandboxClient.queueSandbox(new FakeSandbox("sbx-api-gemini", desktop));

    const { app, store } = await createApp({
      env: createTestEnv(workspace.root, {
        GEMINI_KEY: "gemini_test_key",
      }),
      openai,
      gemini,
      sandboxClient,
      screenshotDir: workspace.screenshotDir,
      restoreOnStartup: false,
      logger: false,
    });

    cleanups.push(async () => {
      await app.close();
      await cleanupWorkspace(workspace.root);
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    expect(created.headers["set-cookie"]).toBeTruthy();
    const sessionId = (created.json() as { session: { id: string } }).session.id;
    const record = store.requireSessionRecord(sessionId);

    expect(record.provider).toBe("gemini");
  });

  it("terminates sandboxes when a tab is closed through the API", async () => {
    const workspace = await createTempWorkspace("vnc-cua-server-delete-");
    const sandboxClient = new FakeSandboxClient();
    const openai = new FakeOpenAI();
    const sandbox = new FakeSandbox("sbx-api-delete", new FakeDesktop([tinyPngBytes()]));
    sandboxClient.queueSandbox(sandbox);

    const { app, store } = await createApp({
      env: createTestEnv(workspace.root),
      openai,
      sandboxClient,
      screenshotDir: workspace.screenshotDir,
      restoreOnStartup: false,
      logger: false,
    });

    cleanups.push(async () => {
      await app.close();
      await cleanupWorkspace(workspace.root);
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const visitorCookie = extractVisitorCookie(created);
    const sessionId = (created.json() as { session: { id: string } }).session.id;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`,
      headers: {
        cookie: visitorCookie,
      },
    });
    const record = store.requireSessionRecord(sessionId);
    const body = deleted.json() as {
      session: { id: string; terminatedAt: string | null; runState: string };
    };

    expect(deleted.statusCode).toBe(200);
    expect(body.session.id).toBe(sessionId);
    expect(body.session.runState).toBe("terminated");
    expect(body.session.terminatedAt).not.toBeNull();
    expect(record.terminatedAt).not.toBeNull();
    expect(record.runState).toBe("terminated");
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
    expect(sandbox.desktop.close).toHaveBeenCalledTimes(1);
  });

  it("permanently deletes archived sessions through the API", async () => {
    const workspace = await createTempWorkspace("vnc-cua-server-purge-");
    const sandboxClient = new FakeSandboxClient();
    const openai = new FakeOpenAI();
    const sandbox = new FakeSandbox("sbx-api-purge", new FakeDesktop([tinyPngBytes()]));
    sandboxClient.queueSandbox(sandbox);

    const { app, store, sessionManager } = await createApp({
      env: createTestEnv(workspace.root),
      openai,
      sandboxClient,
      screenshotDir: workspace.screenshotDir,
      restoreOnStartup: false,
      logger: false,
    });

    cleanups.push(async () => {
      await app.close();
      await cleanupWorkspace(workspace.root);
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const visitorCookie = extractVisitorCookie(created);
    const sessionId = (created.json() as { session: { id: string } }).session.id;
    await sessionManager.waitForIdle(sessionId);

    const archived = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`,
      headers: {
        cookie: visitorCookie,
      },
    });
    const archivedSession = (archived.json() as { session: { lastScreenshotRevision: number } }).session;
    expect(archivedSession.lastScreenshotRevision).toBe(1);

    const recordBeforeDelete = store.requireSessionRecord(sessionId);
    const screenshotPath = recordBeforeDelete.lastScreenshotPath ?? "";

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}/permanent`,
      headers: {
        cookie: visitorCookie,
      },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ sessionId });
    expect(store.getSessionRecord(sessionId)).toBeNull();
    expect(await fs.access(screenshotPath).then(() => true).catch(() => false)).toBe(false);
  });

  it("scopes session APIs to the visitor cookie", async () => {
    const workspace = await createTempWorkspace("vnc-cua-server-visitors-");
    const sandboxClient = new FakeSandboxClient();
    const openai = new FakeOpenAI();
    sandboxClient.queueSandbox(new FakeSandbox("sbx-api-visitor-a", new FakeDesktop([tinyPngBytes()])));

    const { app, sessionManager } = await createApp({
      env: createTestEnv(workspace.root),
      openai,
      sandboxClient,
      screenshotDir: workspace.screenshotDir,
      restoreOnStartup: false,
      logger: false,
    });

    cleanups.push(async () => {
      await app.close();
      await cleanupWorkspace(workspace.root);
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const visitorACookie = extractVisitorCookie(created);
    const sessionId = (created.json() as { session: { id: string } }).session.id;
    await sessionManager.waitForIdle(sessionId);

    const visitorAList = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: {
        cookie: visitorACookie,
      },
    });
    const visitorBList = await app.inject({
      method: "GET",
      url: "/api/sessions",
    });
    const visitorBCookie = extractVisitorCookie(visitorBList);
    const visitorBMessages = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/messages`,
      headers: {
        cookie: visitorBCookie,
      },
    });

    expect((visitorAList.json() as { sessions: Array<{ id: string }> }).sessions).toHaveLength(1);
    expect((visitorAList.json() as { sessions: Array<{ id: string }> }).sessions[0]?.id).toBe(sessionId);
    expect((visitorBList.json() as { sessions: Array<{ id: string }> }).sessions).toEqual([]);
    expect(visitorBMessages.statusCode).toBe(404);
  });
});
