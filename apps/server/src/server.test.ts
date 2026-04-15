import fs from "node:fs/promises";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import { createApp } from "./server.js";
import {
  FakeDesktop,
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
    expect(payload.session.runState).toBe("pending");
    expect(payload.session.lastScreenshotRevision).toBe(0);

    await sessionManager.waitForIdle(payload.session.id);

    const stored = store.requireSessionRecord(payload.session.id);

    const screenshot = await app.inject({
      method: "GET",
      url: `/api/sessions/${payload.session.id}/screenshot`,
    });

    expect(created.statusCode).toBe(201);
    expect(payload.session.sandboxId).toBe("sbx-api-create");
    expect(stored.lastScreenshotRevision).toBe(1);
    expect(await fs.readFile(stored.lastScreenshotPath ?? "")).toEqual(Buffer.from(tinyPngBytes()));
    expect(screenshot.statusCode).toBe(200);
    expect(screenshot.headers["content-type"]).toContain("image/png");
    expect(screenshot.rawPayload).toEqual(Buffer.from(tinyPngBytes()));
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
    const sessionId = (created.json() as { session: { id: string } }).session.id;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`,
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
    const sessionId = (created.json() as { session: { id: string } }).session.id;
    await sessionManager.waitForIdle(sessionId);

    const archived = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`,
    });
    const archivedSession = (archived.json() as { session: { lastScreenshotRevision: number } }).session;
    expect(archivedSession.lastScreenshotRevision).toBe(1);

    const recordBeforeDelete = store.requireSessionRecord(sessionId);
    const screenshotPath = recordBeforeDelete.lastScreenshotPath ?? "";

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}/permanent`,
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ sessionId });
    expect(store.getSessionRecord(sessionId)).toBeNull();
    expect(await fs.access(screenshotPath).then(() => true).catch(() => false)).toBe(false);
  });
});
