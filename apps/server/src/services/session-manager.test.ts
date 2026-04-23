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
import { SessionStore, type SessionProvider } from "./session-store.js";
import {
  FakeDesktop,
  FakeGemini,
  FakeOpenAI,
  FakeSandbox,
  FakeSandboxClient,
  assistantResponse,
  cleanupWorkspace,
  computerCallResponse,
  createTempWorkspace,
  geminiTextResponse,
  tinyPngBytes,
} from "../test/test-helpers.js";

async function createHarness(options: { provider?: SessionProvider } = {}) {
  const workspace = await createTempWorkspace("vnc-cua-session-manager-");
  const { sqlite, db } = createDatabase(workspace.dbPath);
  const store = new SessionStore(db);
  const eventBus = new EventBus();
  const provider = options.provider ?? "openai";
  const openai = new FakeOpenAI();
  const gemini = new FakeGemini();
  const sandboxClient = new FakeSandboxClient();
  const manager = new SessionManager({
    store,
    eventBus,
    openai,
    gemini,
    defaultProvider: provider,
    sandboxClient,
    screenshotDir: workspace.screenshotDir,
    desktopBootWaitMs: 0,
  });

  return {
    ...workspace,
    store,
    openai,
    gemini,
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

const TEST_VISITOR_ID = "visitor_test";

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

    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    expect(session.runState).toBe("pending");
    expect(session.lastScreenshotRevision).toBe(0);
    expect(session.title).toBe("New sandbox");

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
    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    await harness.manager.waitForIdle(session.id);

    harness.openai.enqueueResponse(assistantResponse("title-1", "Open Window"));
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
    const secondCall = harness.openai.responses.create.mock.calls[2]?.[0] as {
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
    expect(desktop.screenshotAfter).toHaveBeenCalledWith(1, 0.75);
    expect(messages.map((message) => [message.role, message.kind, message.content])).toEqual([
      ["user", "text", "Open a window"],
      ["system", "status", "Agent actions:\n1. Move mouse to (140, 220)\n2. Click left at (140, 220)"],
      ["system", "status", "Capturing screenshot..."],
      ["assistant", "text", "Finished opening the window."],
    ]);
    expect(record.title).toBe("Open Window");
    expect(record.runState).toBe("ready");
    expect(record.providerState).toBe("resp-2");
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

  it("runs the Gemini computer-use loop with screenshot feedback", async () => {
    const harness = await createHarness({ provider: "gemini" });
    cleanups.push(harness.cleanup);

    const desktop = new FakeDesktop([tinyPngBytes(), tinyPngBytes()]);
    harness.sandboxClient.queueSandbox(new FakeSandbox("sbx-gemini-loop", desktop));
    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    await harness.manager.waitForIdle(session.id);

    harness.gemini?.enqueueResponse(geminiTextResponse("Open Firefox"));
    harness.gemini?.enqueueResponse(
      geminiTextResponse("I'll click Firefox.", {
        functionCalls: [
          {
            id: "call-g1",
            name: "click_at",
            args: { x: 500, y: 400 },
          },
        ],
      }),
    );
    harness.gemini?.enqueueResponse(geminiTextResponse("Firefox opened."));

    harness.manager.sendUserMessage(session.id, "Open Firefox");
    await harness.manager.waitForIdle(session.id);

    const messages = harness.store.listMessages(session.id);
    const record = harness.store.requireSessionRecord(session.id);
    const secondCall = harness.gemini?.models.generateContent.mock.calls[1]?.[0] as {
      model: string;
      config: { tools: Array<{ computerUse: { excludedPredefinedFunctions: string[] } }> };
      contents: Array<{
        role: string;
        parts: Array<{ text?: string; inlineData?: { mimeType?: string } }>;
      }>;
    };
    expect(record.provider).toBe("gemini");
    expect(record.title).toBe("Open Firefox");
    expect(record.runState).toBe("ready");
    expect(record.providerState).toBeNull();
    expect(desktop.click).toHaveBeenCalledWith({
      button: "left",
      x: 500,
      y: 400,
    });
    expect(messages.map((message) => [message.role, message.kind, message.content])).toEqual([
      ["user", "text", "Open Firefox"],
      ["system", "status", "Capturing screenshot..."],
      ["assistant", "text", "I'll click Firefox."],
      ["system", "status", "Agent actions:\n1. Click left at (500, 400)"],
      ["system", "status", "Capturing screenshot..."],
      ["assistant", "text", "Firefox opened."],
    ]);
    expect(secondCall.model).toBe("gemini-3-flash-preview");
    expect(
      secondCall.config.tools[0]?.computerUse.excludedPredefinedFunctions,
    ).toEqual(["open_web_browser", "search", "navigate", "go_back", "go_forward"]);
    expect(harness.gemini?.models.generateContent).toHaveBeenCalledTimes(3);
  });

  it("reconnects the desktop when the tunnel drops during a run", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    const desktop1 = new FakeDesktop();
    desktop1.screenshotAfter
      .mockReset()
      .mockRejectedValueOnce(new Error("desktop tunnel closed unexpectedly"));
    const desktop2 = new FakeDesktop([Uint8Array.from([9, 8, 7, 6])]);

    const sandbox = new FakeSandbox("sbx-reconnect", desktop1);
    sandbox.connectDesktop.mockReset();
    sandbox.connectDesktop
      .mockImplementationOnce(async () => desktop1)
      .mockImplementationOnce(async () => desktop2);
    harness.sandboxClient.queueSandbox(sandbox);

    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    await harness.manager.waitForIdle(session.id);

    harness.openai.enqueueResponse(assistantResponse("title-r1", "Move Mouse"));
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
    expect(desktop2.screenshotAfter).not.toHaveBeenCalled();
    expect(record.title).toBe("Move Mouse");
    expect(record.runState).toBe("ready");
    expect(record.lastScreenshotRevision).toBe(2);
    expect(messages.at(-1)?.content).toBe("Recovered after reconnect.");
  });

  it("retries desktop reconnects when the first reconnect attempt times out", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    const desktop1 = new FakeDesktop([tinyPngBytes()]);
    desktop1.click.mockRejectedValueOnce(new Error("desktop tunnel closed unexpectedly"));
    const desktop2 = new FakeDesktop([Uint8Array.from([9, 8, 7, 6])]);

    const sandbox = new FakeSandbox("sbx-reconnect-timeout", desktop1);
    sandbox.connectDesktop.mockReset();
    sandbox.connectDesktop
      .mockImplementationOnce(async () => desktop1)
      .mockRejectedValueOnce(
        new Error("timed out while connecting desktop session after 4.00s"),
      )
      .mockImplementationOnce(async () => desktop2);
    harness.sandboxClient.queueSandbox(sandbox);

    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    await harness.manager.waitForIdle(session.id);

    harness.openai.enqueueResponse(assistantResponse("title-reconnect-timeout", "Open Terminal"));
    harness.openai.enqueueResponse(
      computerCallResponse("resp-reconnect-timeout-1", "call-reconnect-timeout-1", [
        { type: "click", x: 567, y: 774 },
      ]),
    );
    harness.openai.enqueueResponse(
      assistantResponse("resp-reconnect-timeout-2", "Terminal opened."),
    );

    harness.manager.sendUserMessage(session.id, "Start a terminal");
    await harness.manager.waitForIdle(session.id);

    const record = harness.store.requireSessionRecord(session.id);
    const messages = harness.store.listMessages(session.id);

    expect(sandbox.connectDesktop).toHaveBeenCalledTimes(3);
    expect(sandbox.connectDesktop).toHaveBeenNthCalledWith(1, {
      password: "tensorlake",
    });
    expect(sandbox.connectDesktop).toHaveBeenNthCalledWith(2, {
      password: "tensorlake",
      connectTimeout: 4,
    });
    expect(sandbox.connectDesktop).toHaveBeenNthCalledWith(3, {
      password: "tensorlake",
      connectTimeout: 4,
    });
    expect(record.runState).toBe("ready");
    expect(record.title).toBe("Open Terminal");
    expect(record.lastScreenshotRevision).toBe(2);
    expect(desktop2.screenshot).toHaveBeenCalledTimes(1);
    expect(messages.map((message) => [message.kind, message.content])).toEqual([
      ["text", "Start a terminal"],
      ["status", "Agent actions:\n1. Click left at (567, 774)"],
      ["status", "Desktop control connection dropped. Reconnecting..."],
      ["status", "Capturing screenshot..."],
      ["text", "Terminal opened."],
    ]);
  });

  it("returns failed turns to ready so manual desktop control still works", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    const desktop = new FakeDesktop([tinyPngBytes()]);
    desktop.press.mockRejectedValueOnce(new Error("unsupported desktop key `esc`"));

    harness.sandboxClient.queueSandbox(new FakeSandbox("sbx-turn-error", desktop));
    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    await harness.manager.waitForIdle(session.id);

    harness.openai.enqueueResponse(assistantResponse("title-turn-error", "Press Escape"));
    harness.openai.enqueueResponse(
      computerCallResponse("resp-turn-error-1", "call-turn-error-1", [
        { type: "keypress", keys: ["esc"] },
      ]),
    );

    harness.manager.sendUserMessage(session.id, "Press escape");
    await harness.manager.waitForIdle(session.id);

    const record = harness.store.requireSessionRecord(session.id);
    const messages = harness.store.listMessages(session.id);

    expect(record.runState).toBe("ready");
    expect(record.title).toBe("Press Escape");
    expect(messages.at(-1)?.kind).toBe("error");
    expect(messages.at(-1)?.content).toBe("unsupported desktop key `esc`");

    await harness.manager.handleLiveDesktopInput(session.id, {
      type: "click",
      x: 24,
      y: 32,
      button: "left",
      clickCount: 1,
    });

    expect(desktop.click).toHaveBeenCalledWith({
      button: "left",
      x: 24,
      y: 32,
    });
  });

  it("falls back to the cached frame when no fresher frame arrives in time", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    const desktop1 = new FakeDesktop();
    desktop1.screenshotAfter.mockRejectedValueOnce(
      new Error("timed out waiting for a fresher desktop framebuffer after 0.75s"),
    );
    desktop1.screenshot.mockResolvedValueOnce(tinyPngBytes());

    const sandbox = new FakeSandbox("sbx-timeout", desktop1);
    harness.sandboxClient.queueSandbox(sandbox);

    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    await harness.manager.waitForIdle(session.id);

    harness.openai.enqueueResponse(assistantResponse("title-timeout", "Open App"));
    harness.openai.enqueueResponse(
      computerCallResponse("resp-timeout-1", "call-timeout-1", [
        { type: "click", x: 20, y: 30 },
      ]),
    );
    harness.openai.enqueueResponse(assistantResponse("resp-timeout-2", "Completed after retry."));

    harness.manager.sendUserMessage(session.id, "Open the app");
    await harness.manager.waitForIdle(session.id);

    const messages = harness.store.listMessages(session.id);
    const record = harness.store.requireSessionRecord(session.id);

    expect(sandbox.connectDesktop).toHaveBeenCalledTimes(1);
    expect(record.runState).toBe("ready");
    expect(record.lastScreenshotRevision).toBe(2);
    expect(desktop1.screenshotAfter).toHaveBeenCalledWith(0, 0.75);
    expect(desktop1.screenshot).toHaveBeenCalledTimes(2);
    expect(messages.map((message) => [message.kind, message.content])).toEqual([
      ["text", "Open the app"],
      ["status", "Agent actions:\n1. Click left at (20, 30)"],
      ["status", "Capturing screenshot..."],
      ["text", "Completed after retry."],
    ]);
  });

  it("handles live desktop input events for manual control", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    const desktop = new FakeDesktop([tinyPngBytes()]);
    harness.sandboxClient.queueSandbox(new FakeSandbox("sbx-live-input", desktop));
    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    await harness.manager.waitForIdle(session.id);

    await harness.manager.handleLiveDesktopInput(session.id, {
      type: "pointer_move",
      x: 42,
      y: 64,
    });
    await harness.manager.handleLiveDesktopInput(session.id, {
      type: "click",
      x: 42,
      y: 64,
      button: "left",
      clickCount: 1,
    });
    await harness.manager.handleLiveDesktopInput(session.id, {
      type: "scroll",
      x: 42,
      y: 64,
      deltaY: 180,
    });
    await harness.manager.handleLiveDesktopInput(session.id, {
      type: "text",
      text: "hello world",
    });
    await harness.manager.handleLiveDesktopInput(session.id, {
      type: "key_press",
      key: "L",
      modifiers: ["Control"],
    });

    expect(desktop.moveMouse).toHaveBeenCalledWith(42, 64);
    expect(desktop.click).toHaveBeenCalledWith({
      button: "left",
      x: 42,
      y: 64,
    });
    expect(desktop.scrollDown).toHaveBeenCalledWith(2, 42, 64);
    expect(desktop.typeText).toHaveBeenCalledWith("hello world");
    expect(desktop.press).toHaveBeenCalledWith(["ctrl", "l"]);
  });

  it("reuses a dedicated VNC tunnel for low-latency live desktop access", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    const sandbox = new FakeSandbox("sbx-live-vnc", new FakeDesktop([tinyPngBytes()]));
    harness.sandboxClient.queueSandbox(sandbox);
    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    await harness.manager.waitForIdle(session.id);

    const first = await harness.manager.openLiveDesktopVnc(session.id);
    const second = await harness.manager.openLiveDesktopVnc(session.id);

    expect(first).toEqual({ host: "127.0.0.1", port: 5901 });
    expect(second).toEqual(first);
    expect(sandbox.createTunnel).toHaveBeenCalledTimes(1);
    expect(sandbox.createTunnel).toHaveBeenCalledWith(5901, { localPort: 0 });
  });

  it("restores running sessions and archives missing sandboxes", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    harness.store.createSession({
      id: "session-running",
      title: "Running",
      visitorId: TEST_VISITOR_ID,
      provider: "openai",
      sandboxId: "sbx-running",
      sandboxStatus: "running",
      runState: "pending",
    });
    harness.store.createSession({
      id: "session-missing",
      title: "Missing",
      visitorId: TEST_VISITOR_ID,
      provider: "openai",
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

  it("archives sessions when their sandbox is terminated externally", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    const sandbox = new FakeSandbox("sbx-external-termination", new FakeDesktop([tinyPngBytes()]));
    harness.sandboxClient.queueSandbox(sandbox);
    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    await harness.manager.waitForIdle(session.id);

    harness.sandboxClient.setStatus("sbx-external-termination", "terminated");
    await harness.manager.reconcileSandboxStatuses();

    const record = harness.store.requireSessionRecord(session.id);

    expect(record.runState).toBe("terminated");
    expect(record.sandboxStatus).toBe("terminated");
    expect(record.terminatedAt).not.toBeNull();
    expect(sandbox.desktop.close).toHaveBeenCalledTimes(1);
  });

  it("rechecks sandbox status after a timeout instead of archiving immediately", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    const sandbox = new FakeSandbox("sbx-status-timeout", new FakeDesktop([tinyPngBytes()]));
    harness.sandboxClient.queueSandbox(sandbox);
    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    await harness.manager.waitForIdle(session.id);

    harness.sandboxClient.setStatus("sbx-status-timeout", "terminated");
    harness.sandboxClient.get.mockRejectedValueOnce(
      new Error("timed out while checking sandbox status"),
    );

    await harness.manager.reconcileSandboxStatuses();

    const afterTimeout = harness.store.requireSessionRecord(session.id);
    expect(afterTimeout.runState).toBe("ready");
    expect(afterTimeout.terminatedAt).toBeNull();

    await harness.manager.reconcileSandboxStatuses();

    const afterRetry = harness.store.requireSessionRecord(session.id);
    expect(afterRetry.runState).toBe("terminated");
    expect(afterRetry.sandboxStatus).toBe("terminated");
    expect(afterRetry.terminatedAt).not.toBeNull();
  });

  it("stops in-flight runs cleanly and prevents overlapping turns", async () => {
    const harness = await createHarness();
    cleanups.push(harness.cleanup);

    harness.sandboxClient.queueSandbox(new FakeSandbox("sbx-stop", new FakeDesktop([tinyPngBytes()])));
    const session = await harness.manager.createSession(TEST_VISITOR_ID);
    await harness.manager.waitForIdle(session.id);

    harness.openai.enqueueResponse(assistantResponse("title-stop", "Slow Task"));
    harness.openai.enqueueHandler(
      async (_body, options) =>
        await new Promise((_, reject) => {
          const abort = () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          };

          options?.signal?.addEventListener("abort", abort);
          if (options?.signal?.aborted) {
            abort();
          }
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
    expect(record.title).toBe("Slow Task");
    expect(record.runState).toBe("ready");
  });
});
