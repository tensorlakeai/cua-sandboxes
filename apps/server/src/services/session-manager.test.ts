import fs from "node:fs/promises";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import { createDatabase } from "../db/client.js";
import { EventBus } from "../lib/event-bus.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import {
  FakeDesktop,
  FakeOpenAI,
  FakeSandbox,
  FakeSandboxClient,
  assistantResponse,
  cleanupWorkspace,
  computerCallResponse,
  createTempWorkspace,
  tinyPngBytes,
} from "../test/test-helpers.js";

async function createHarness() {
  const workspace = await createTempWorkspace("vnc-cua-session-manager-");
  const { sqlite, db } = createDatabase(workspace.dbPath);
  const store = new SessionStore(db);
  const eventBus = new EventBus();
  const openai = new FakeOpenAI();
  const sandboxClient = new FakeSandboxClient();
  const manager = new SessionManager({
    store,
    eventBus,
    openai,
    sandboxClient,
    screenshotDir: workspace.screenshotDir,
    desktopBootWaitMs: 0,
  });

  return {
    ...workspace,
    store,
    openai,
    sandboxClient,
    manager,
    async cleanup() {
      eventBus.close();
      await manager.shutdown();
      sqlite.close();
      await cleanupWorkspace(workspace.root);
    },
  };
}

describe("SessionManager", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it("creates sessions and persists their initial screenshot", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    const sandbox = new FakeSandbox("sbx-create", new FakeDesktop([tinyPngBytes()]));
    harness.sandboxClient.queueSandbox(sandbox);

    const session = await harness.manager.createSession();
    expect(session.runState).toBe("pending");
    expect(session.lastScreenshotRevision).toBe(0);

    await harness.manager.waitForIdle(session.id);

    const stored = harness.store.requireSessionRecord(session.id);
    const screenshotBytes = await fs.readFile(stored.lastScreenshotPath ?? "");

    expect(session.sandboxId).toBe("sbx-create");
    expect(stored.runState).toBe("ready");
    expect(stored.lastScreenshotRevision).toBe(1);
    expect(stored.terminatedAt).toBeNull();
    expect(screenshotBytes).toEqual(Buffer.from(tinyPngBytes()));
    expect(harness.sandboxClient.createAndConnect).toHaveBeenCalledWith({
      image: "tensorlake/ubuntu-vnc",
    });
    expect(sandbox.connectDesktop).toHaveBeenCalledWith({ password: "tensorlake" });
  });

  it("runs the OpenAI computer-use loop and stores assistant output", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    const desktop = new FakeDesktop([tinyPngBytes(), Uint8Array.from([1, 2, 3, 4])]);
    harness.sandboxClient.queueSandbox(new FakeSandbox("sbx-loop", desktop));
    const session = await harness.manager.createSession();
    await harness.manager.waitForIdle(session.id);

    harness.openai.enqueueResponse(
      computerCallResponse("resp-1", "call-1", [
        { type: "move", x: 140, y: 220 },
        { type: "click", x: 140, y: 220 },
      ]),
    );
    harness.openai.enqueueResponse(assistantResponse("resp-2", "Finished opening the window."));

    const running = harness.manager.sendUserMessage(session.id, "Open a window");
    await harness.manager.waitForIdle(session.id);

    const messages = harness.store.listMessages(session.id);
    const record = harness.store.requireSessionRecord(session.id);
    const secondCall = harness.openai.responses.create.mock.calls[1]?.[0] as {
      previous_response_id: string;
      input: Array<{
        type: string;
        call_id: string;
        output: { type: string; image_url: string; detail: string };
      }>;
    };

    expect(running.runState).toBe("running");
    expect(desktop.moveMouse).toHaveBeenCalledWith(140, 220);
    expect(desktop.click).toHaveBeenCalledWith({
      button: "left",
      x: 140,
      y: 220,
    });
    expect(messages.map((message) => [message.role, message.kind, message.content])).toEqual([
      ["user", "text", "Open a window"],
      ["assistant", "text", "Finished opening the window."],
    ]);
    expect(record.runState).toBe("ready");
    expect(record.openaiLastResponseId).toBe("resp-2");
    expect(record.lastScreenshotRevision).toBe(2);
    expect(secondCall.previous_response_id).toBe("resp-1");
    expect(secondCall.input[0]?.type).toBe("computer_call_output");
    expect(secondCall.input[0]?.call_id).toBe("call-1");
    expect(secondCall.input[0]?.output.type).toBe("computer_screenshot");
    expect(secondCall.input[0]?.output.detail).toBe("original");
    expect(secondCall.input[0]?.output.image_url.startsWith("data:image/png;base64,")).toBe(
      true,
    );
  });

  it("reconnects the desktop when the tunnel drops during a run", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    const desktop1 = new FakeDesktop();
    desktop1.screenshot
      .mockReset()
      .mockResolvedValueOnce(tinyPngBytes())
      .mockRejectedValueOnce(new Error("desktop tunnel closed unexpectedly"));
    const desktop2 = new FakeDesktop([Uint8Array.from([9, 8, 7, 6])]);

    const sandbox = new FakeSandbox("sbx-reconnect", desktop1);
    sandbox.connectDesktop.mockReset();
    sandbox.connectDesktop
      .mockImplementationOnce(async () => desktop1)
      .mockImplementationOnce(async () => desktop2);
    harness.sandboxClient.queueSandbox(sandbox);

    const session = await harness.manager.createSession();
    await harness.manager.waitForIdle(session.id);

    harness.openai.enqueueResponse(
      computerCallResponse("resp-r1", "call-r1", [
        { type: "move", x: 30, y: 40 },
      ]),
    );
    harness.openai.enqueueResponse(assistantResponse("resp-r2", "Recovered after reconnect."));

    harness.manager.sendUserMessage(session.id, "Move the mouse and continue");
    await harness.manager.waitForIdle(session.id);

    const record = harness.store.requireSessionRecord(session.id);
    const messages = harness.store.listMessages(session.id);

    expect(sandbox.connectDesktop).toHaveBeenCalledTimes(2);
    expect(desktop2.screenshot).toHaveBeenCalledTimes(1);
    expect(record.runState).toBe("ready");
    expect(record.lastScreenshotRevision).toBe(2);
    expect(messages.at(-1)?.content).toBe("Recovered after reconnect.");
  });

  it("restores running sessions and archives missing sandboxes", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    harness.store.createSession({
      id: "session-running",
      title: "Running",
      sandboxId: "sbx-running",
      sandboxStatus: "running",
      runState: "pending",
    });
    harness.store.createSession({
      id: "session-missing",
      title: "Missing",
      sandboxId: "sbx-missing",
      sandboxStatus: "running",
      runState: "pending",
    });

    harness.sandboxClient.registerSandbox(
      new FakeSandbox("sbx-running", new FakeDesktop([tinyPngBytes()])),
      "running",
    );
    harness.sandboxClient.setStatus("sbx-missing", "terminated");

    await harness.manager.restoreSessions();
    await harness.manager.waitForIdle("session-running");

    const restored = harness.store.requireSessionRecord("session-running");
    const missing = harness.store.requireSessionRecord("session-missing");

    expect(restored.runState).toBe("ready");
    expect(restored.terminatedAt).toBeNull();
    expect(restored.lastScreenshotRevision).toBe(1);
    expect(await fs.readFile(restored.lastScreenshotPath ?? "")).toEqual(Buffer.from(tinyPngBytes()));

    expect(missing.runState).toBe("terminated");
    expect(missing.sandboxStatus).toBe("terminated");
    expect(missing.terminatedAt).not.toBeNull();
  });

  it("stops in-flight runs cleanly and prevents overlapping turns", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    harness.sandboxClient.queueSandbox(new FakeSandbox("sbx-stop", new FakeDesktop([tinyPngBytes()])));
    const session = await harness.manager.createSession();
    await harness.manager.waitForIdle(session.id);

    harness.openai.enqueueHandler(
      async (_body, options) =>
        await new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );

    harness.manager.sendUserMessage(session.id, "Do something slow");

    expect(() => harness.manager.sendUserMessage(session.id, "second turn")).toThrow(
      "already running",
    );

    const stopping = harness.manager.stopRun(session.id);
    await harness.manager.waitForIdle(session.id);

    const messages = harness.store.listMessages(session.id);
    const kinds = messages.map((message) => [message.kind, message.content]);
    const record = harness.store.requireSessionRecord(session.id);

    expect(stopping.runState).toBe("stopping");
    expect(kinds).toEqual([
      ["text", "Do something slow"],
      ["status", "Run stopped."],
    ]);
    expect(record.runState).toBe("ready");
  });
});
