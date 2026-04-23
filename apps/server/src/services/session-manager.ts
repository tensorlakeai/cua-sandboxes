import fs from "node:fs/promises";
import path from "node:path";

import {
  type ChatMessage,
  type LiveDesktopInputEvent,
  type SessionSummary,
} from "@vnc-cua/contracts";
import {
  Environment,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";

import {
  type ComputerAction,
  type DesktopLike,
  executeComputerActions,
  normalizeKeyName,
  scrollStepsFromDelta,
} from "./action-executor.js";
import {
  SessionStore,
  toSessionSummary,
  type SessionProvider,
  type SessionRecord,
} from "./session-store.js";
import { EventBus } from "../lib/event-bus.js";
import { sleep } from "../lib/time.js";
import { writeScreenshot } from "../lib/screenshot.js";

export interface DesktopSessionLike extends DesktopLike {
  screenshot(timeoutSeconds?: number): Promise<Uint8Array>;
  getFrameVersion?(): number;
  screenshotAfter?(
    frameVersion: number,
    timeoutSeconds?: number,
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface SandboxTunnelLike {
  address(): { host: string; port: number };
  close(): Promise<void>;
}

export interface SandboxLike {
  sandboxId: string;
  connectDesktop(options?: {
    password?: string;
    connectTimeout?: number;
  }): Promise<DesktopSessionLike>;
  createTunnel?(
    remotePort: number,
    options?: { localPort?: number },
  ): Promise<SandboxTunnelLike>;
  terminate(): Promise<void>;
  close?(): void;
}

export interface SandboxClientLike {
  createAndConnect(options?: { image?: string }): Promise<SandboxLike>;
  connect(sandboxId: string): SandboxLike;
  get(sandboxId: string): Promise<{ status?: string }>;
  close?(): void;
}

export interface OpenAIResponseLike {
  id: string;
  output?: unknown[];
  output_text?: string;
}

export interface OpenAIClientLike {
  responses: {
    create(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<OpenAIResponseLike>;
  };
}

export interface GeminiFunctionCallLike {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

export interface GeminiContentLike {
  role?: string;
  parts?: Array<{
    text?: string;
    functionCall?: GeminiFunctionCallLike;
    functionResponse?: {
      id?: string;
      name?: string;
      response?: Record<string, unknown>;
      parts?: Array<{
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
      }>;
    };
    inlineData?: {
      mimeType?: string;
      data?: string;
    };
  }>;
}

export interface SimpleGeminiGenerateContentResponseLike {
  text?: string;
  functionCalls?: GeminiFunctionCallLike[];
  candidates?: Array<{
    content?: GeminiContentLike;
  }>;
}

export type GeminiGenerateContentResponseLike =
  | GenerateContentResponse
  | SimpleGeminiGenerateContentResponseLike;

export interface GeminiClientLike {
  models: {
    generateContent(
      body: GenerateContentParameters,
    ): Promise<GeminiGenerateContentResponseLike>;
  };
}

interface ActiveRuntime {
  sandbox: SandboxLike;
  desktop: DesktopSessionLike | null;
  vncTunnel: SandboxTunnelLike | null;
  vncTunnelPromise: Promise<SandboxTunnelLike> | null;
  bootPromise: Promise<void> | null;
  bootAbortController: AbortController | null;
  currentRunPromise: Promise<void> | null;
  abortController: AbortController | null;
  stopRequested: boolean;
}

class RunAbortedError extends Error {
  constructor() {
    super("Run aborted");
    this.name = "RunAbortedError";
  }
}

const OPENAI_MODEL = "gpt-5.4";
const GEMINI_MODEL = "gemini-3-flash-preview";
const UNTITLED_SESSION_TITLE = "New sandbox";
const MAX_SESSION_TITLE_LENGTH = 48;
const LIVE_STREAM_FRAME_DELAY_MS = 120;
const LIVE_FRAME_SCREENSHOT_TIMEOUT_SECONDS = 2;
const RUNTIME_SCREENSHOT_TIMEOUT_SECONDS = 5;
const FRESH_FRAME_WAIT_TIMEOUT_SECONDS = 0.75;
const DESKTOP_RECONNECT_TIMEOUT_SECONDS = 4;
const SYSTEM_PROMPT = `You are a computer-use agent operating a Linux desktop inside a sandbox.
Use the built-in computer tool for UI work. Be concise and helpful.
Do not send, submit, post, delete, purchase, or transmit sensitive data or irreversible changes without explicit user confirmation.
If a task would require risky external side effects, stop and ask the user in normal assistant text instead of taking that step.`;
const SESSION_TITLE_PROMPT = `Generate a short descriptive title for this computer-use session.
Return only the title, with no quotes, markdown, or explanation.
Keep it concise and specific, usually 2 to 5 words.`;

export class SessionManager {
  private readonly runtimes = new Map<string, ActiveRuntime>();
  private statusSweepPromise: Promise<void> | null = null;

  constructor(private readonly options: {
    store: SessionStore;
    eventBus: EventBus;
    defaultProvider: SessionProvider;
    openai: OpenAIClientLike | undefined;
    gemini: GeminiClientLike | undefined;
    sandboxClient: SandboxClientLike;
    screenshotDir: string;
    desktopBootWaitMs?: number;
    desktopConnectAttempts?: number;
    desktopConnectRetryMs?: number;
    desktopReconnectTimeoutSeconds?: number;
  }) {}

  async restoreSessions(): Promise<void> {
    for (const record of this.options.store.listActiveSessionRecords()) {
      await this.reconcileSessionRecord(record.id, {
        allowRuntimeRecovery: true,
      });
    }
  }

  async reconcileSandboxStatuses(): Promise<void> {
    if (this.statusSweepPromise) {
      return this.statusSweepPromise;
    }

    this.statusSweepPromise = (async () => {
      for (const record of this.options.store.listActiveSessionRecords()) {
        await this.reconcileSessionRecord(record.id, {
          allowRuntimeRecovery: true,
        });
      }
    })().finally(() => {
      this.statusSweepPromise = null;
    });

    return this.statusSweepPromise;
  }

  async createSession(visitorId: string): Promise<SessionSummary> {
    const sandbox = await this.options.sandboxClient.createAndConnect({
      image: "tensorlake/ubuntu-vnc",
    });

    try {
      const sessionId = `session_${crypto.randomUUID()}`;
      const session = this.options.store.createSession({
        id: sessionId,
        title: UNTITLED_SESSION_TITLE,
        visitorId,
        provider: this.options.defaultProvider,
        sandboxId: sandbox.sandboxId,
        sandboxStatus: "running",
        runState: "pending",
      });

      const runtime: ActiveRuntime = {
        sandbox,
        desktop: null,
        vncTunnel: null,
        vncTunnelPromise: null,
        bootPromise: null,
        bootAbortController: new AbortController(),
        currentRunPromise: null,
        abortController: null,
        stopRequested: false,
      };
      this.runtimes.set(session.id, runtime);

      this.publishSession(session);
      this.publishRunState(session.id, "pending");

      runtime.bootPromise = this.bootstrapSession(session.id, runtime).finally(() => {
        runtime.bootPromise = null;
        runtime.bootAbortController = null;
      });

      return toSessionSummary(session);
    } catch (error) {
      await sandbox.terminate().catch(() => {});
      throw error;
    }
  }

  sendUserMessage(sessionId: string, content: string): SessionSummary {
    const record = this.options.store.requireSessionRecord(sessionId);
    if (record.terminatedAt) {
      throw new Error(`Session ${sessionId} is terminated`);
    }

    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      throw new Error(`Session ${sessionId} is not connected`);
    }
    if (!runtime.desktop || runtime.bootPromise) {
      throw new Error(`Session ${sessionId} is still booting`);
    }
    if (runtime.currentRunPromise) {
      throw new Error(`Session ${sessionId} is already running`);
    }

    const userMessage = this.options.store.createMessage({
      sessionId,
      role: "user",
      kind: "text",
      content,
    });
    this.options.eventBus.publish({
      type: "message.created",
      message: userMessage,
    });

    const updated = this.options.store.updateSession(sessionId, {
      runState: "running",
    });
    this.publishRunState(updated.id, "running");
    this.publishSession(updated);

    runtime.stopRequested = false;
    runtime.abortController = new AbortController();
    runtime.currentRunPromise = this.runUserTurn(sessionId, content, runtime).finally(() => {
      runtime.currentRunPromise = null;
      runtime.abortController = null;
      runtime.stopRequested = false;
    });
    void runtime.currentRunPromise;

    return toSessionSummary(updated);
  }

  async refreshScreenshot(sessionId: string): Promise<SessionSummary> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      throw new Error(`Session ${sessionId} is not connected`);
    }
    if (!runtime.desktop) {
      throw new Error(`Session ${sessionId} is still booting`);
    }

    const result = await this.captureRuntimeScreenshot(sessionId, runtime);
    return result.session;
  }

  stopRun(sessionId: string): SessionSummary {
    const runtime = this.runtimes.get(sessionId);
    const record = this.options.store.requireSessionRecord(sessionId);

    if (!runtime?.currentRunPromise) {
      return toSessionSummary(record);
    }

    runtime.stopRequested = true;
    runtime.abortController?.abort();

    const updated = this.options.store.updateSession(sessionId, {
      runState: "stopping",
    });
    this.publishRunState(sessionId, "stopping");
    this.publishSession(updated);
    return toSessionSummary(updated);
  }

  async closeSession(sessionId: string): Promise<SessionSummary> {
    const runtime = this.runtimes.get(sessionId);

    if (runtime) {
      await this.disposeRuntime(runtime, { terminateSandbox: true });
      this.runtimes.delete(sessionId);
    }

    const terminated = this.options.store.terminateSession(sessionId);
    this.publishSession(terminated);
    this.publishRunState(sessionId, "terminated");
    this.options.eventBus.publish({
      type: "session.terminated",
      sessionId,
    });

    return toSessionSummary(terminated);
  }

  async deleteArchivedSession(sessionId: string): Promise<{ sessionId: string }> {
    const record = this.options.store.requireSessionRecord(sessionId);
    if (!record.terminatedAt) {
      throw new Error(`Session ${sessionId} must be archived before it can be deleted`);
    }

    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      await this.disposeRuntime(runtime, { terminateSandbox: false });
      this.runtimes.delete(sessionId);
    }

    if (record.lastScreenshotPath) {
      await fs.rm(record.lastScreenshotPath, { force: true }).catch(() => {});
    }

    this.options.eventBus.publish({
      type: "session.deleted",
      sessionId,
    });
    this.options.store.deleteSession(sessionId);

    return { sessionId };
  }

  assertLiveDesktopStreamAvailable(sessionId: string): SessionSummary {
    const { record } = this.requireLiveRuntime(sessionId, {
      allowRunning: true,
    });
    return toSessionSummary(record);
  }

  async openLiveDesktopVnc(sessionId: string): Promise<{ host: string; port: number }> {
    const { runtime } = this.requireLiveRuntime(sessionId, {
      allowRunning: true,
    });

    if (runtime.vncTunnel) {
      return runtime.vncTunnel.address();
    }

    if (runtime.vncTunnelPromise) {
      const tunnel = await runtime.vncTunnelPromise;
      return tunnel.address();
    }

    if (!runtime.sandbox.createTunnel) {
      throw new Error(`Session ${sessionId} does not support live VNC access`);
    }

    runtime.vncTunnelPromise = runtime.sandbox
      .createTunnel(5901, { localPort: 0 })
      .then((tunnel) => {
        runtime.vncTunnel = tunnel;
        return tunnel;
      })
      .finally(() => {
        runtime.vncTunnelPromise = null;
      });

    const tunnel = await runtime.vncTunnelPromise;
    return tunnel.address();
  }

  async streamLiveFrames(
    sessionId: string,
    options: {
      onFrame: (bytes: Uint8Array) => Promise<void> | void;
      signal?: AbortSignal;
      frameDelayMs?: number;
    },
  ): Promise<void> {
    const { runtime } = this.requireLiveRuntime(sessionId, {
      allowRunning: true,
    });

    while (!options.signal?.aborted) {
      const bytes = await this.captureLiveFrame(
        sessionId,
        runtime,
        options.signal,
      );
      await options.onFrame(bytes);
      await sleepWithAbort(
        options.frameDelayMs ?? LIVE_STREAM_FRAME_DELAY_MS,
        options.signal,
      );
    }
  }

  async handleLiveDesktopInput(
    sessionId: string,
    event: LiveDesktopInputEvent,
  ): Promise<void> {
    const { desktop } = this.requireLiveRuntime(sessionId, {
      allowRunning: false,
    });

    switch (event.type) {
      case "pointer_move":
        await desktop.moveMouse(event.x, event.y);
        return;
      case "click":
        if (event.clickCount === 2) {
          await desktop.doubleClick({
            button: event.button,
            x: event.x,
            y: event.y,
          });
          return;
        }

        await desktop.click({
          button: event.button,
          x: event.x,
          y: event.y,
        });
        return;
      case "scroll": {
        await desktop.moveMouse(event.x, event.y);
        const steps = scrollStepsFromDelta(event.deltaY);
        if (steps === 0) {
          return;
        }

        if (event.deltaY < 0) {
          await desktop.scrollUp(steps, event.x, event.y);
          return;
        }

        await desktop.scrollDown(steps, event.x, event.y);
        return;
      }
      case "text":
        await desktop.typeText(event.text);
        return;
      case "key_press": {
        const keys = [
          ...event.modifiers.map((modifier) => normalizeKeyName(modifier)),
          normalizeKeyName(event.key),
        ];
        await desktop.press(keys);
        return;
      }
    }
  }

  async waitForIdle(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    await runtime?.bootPromise;
    await runtime?.currentRunPromise;
  }

  async shutdown(): Promise<void> {
    for (const [sessionId, runtime] of this.runtimes) {
      await this.disposeRuntime(runtime, { terminateSandbox: false });
      this.runtimes.delete(sessionId);
    }
    this.options.sandboxClient.close?.();
  }

  private async runUserTurn(
    sessionId: string,
    userContent: string,
    runtime: ActiveRuntime,
  ): Promise<void> {
    try {
      if (!runtime.desktop) {
        throw new Error(`Session ${sessionId} is still booting`);
      }

      let record = this.options.store.requireSessionRecord(sessionId);
      record = await this.maybeGenerateSessionTitle(record, userContent, runtime);
      if (record.provider === "gemini") {
        await this.runGeminiTurn(sessionId, userContent, runtime);
      } else {
        await this.runOpenAITurn(sessionId, userContent, runtime);
      }

      const ready = this.options.store.updateSession(sessionId, {
        runState: "ready",
      });
      this.publishRunState(sessionId, "ready");
      this.publishSession(ready);
    } catch (error) {
      if (error instanceof RunAbortedError || isAbortLikeError(error, runtime)) {
        await this.handleAbort(sessionId);
        return;
      }
      await this.handleFailure(sessionId, error, { nextRunState: "ready" });
    }
  }

  private async maybeGenerateSessionTitle(
    record: SessionRecord,
    userContent: string,
    runtime: ActiveRuntime,
  ): Promise<SessionRecord> {
    if (record.providerState || !isDefaultSessionTitle(record.title)) {
      return record;
    }

    try {
      const title = sanitizeSessionTitle(
        record.provider === "gemini"
          ? await this.generateGeminiSessionTitle(userContent, runtime)
          : await this.generateOpenAISessionTitle(userContent, runtime),
      );
      if (!title || title === record.title) {
        return record;
      }

      const updated = this.options.store.updateSession(record.id, {
        title,
      });
      this.publishSession(updated);
      return updated;
    } catch (error) {
      if (error instanceof RunAbortedError || isAbortLikeError(error, runtime)) {
        throw error;
      }

      return record;
    }
  }

  private async runOpenAITurn(
    sessionId: string,
    userContent: string,
    runtime: ActiveRuntime,
  ): Promise<void> {
    const openai = this.requireOpenAI();
    let record = this.options.store.requireSessionRecord(sessionId);
    let response = await openai.responses.create(
      {
        model: OPENAI_MODEL,
        tools: [{ type: "computer" }],
        ...(record.providerState
          ? {
              previous_response_id: record.providerState,
              input: [
                {
                  role: "user",
                  content: [{ type: "input_text", text: userContent }],
                },
              ],
            }
          : {
              input: [
                {
                  role: "system",
                  content: [{ type: "input_text", text: SYSTEM_PROMPT }],
                },
                {
                  role: "user",
                  content: [{ type: "input_text", text: userContent }],
                },
              ],
            }),
      },
      runtime.abortController?.signal
        ? { signal: runtime.abortController.signal }
        : undefined,
    );
    record = this.options.store.updateSession(sessionId, {
      providerState: response.id,
      openaiLastResponseId: response.id,
    });
    this.publishSession(record);

    while (true) {
      this.throwIfStopped(runtime);

      const assistantText = extractAssistantText(response).trim();
      if (assistantText) {
        this.publishAssistantText(sessionId, assistantText);
      }

      const computerCall = findComputerCall(response);
      if (!computerCall) {
        break;
      }

      const screenshot = await this.executeActionsAndCaptureScreenshot(
        sessionId,
        runtime,
        computerCall.actions,
      );

      response = await openai.responses.create(
        {
          model: OPENAI_MODEL,
          tools: [{ type: "computer" }],
          previous_response_id: response.id,
          input: [
            {
              type: "computer_call_output",
              call_id: computerCall.callId,
              output: {
                type: "computer_screenshot",
                image_url: `data:image/png;base64,${screenshot.base64}`,
                detail: "original",
              },
            },
          ],
        },
        runtime.abortController?.signal
          ? { signal: runtime.abortController.signal }
          : undefined,
      );

      record = this.options.store.updateSession(sessionId, {
        providerState: response.id,
        openaiLastResponseId: response.id,
      });
      this.publishSession(record);
    }
  }

  private async runGeminiTurn(
    sessionId: string,
    userContent: string,
    runtime: ActiveRuntime,
  ): Promise<void> {
    const gemini = this.requireGemini();
    const priorMessages = this.options.store.listMessages(sessionId).slice(0, -1);
    const contents = buildGeminiContentsFromMessages(priorMessages);
    let currentViewport = { width: 1000, height: 1000 };
    const initialScreenshot = await this.captureInitialGeminiScreenshot(
      sessionId,
      runtime,
    );
    currentViewport = initialScreenshot.viewport;
    contents.push({
      role: "user",
      parts: [
        {
          text: userContent,
        },
        {
          inlineData: {
            mimeType: "image/png",
            data: initialScreenshot.base64,
          },
        },
      ],
    });

    while (true) {
      this.throwIfStopped(runtime);

      const response = await gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: {
          ...(runtime.abortController?.signal
            ? { abortSignal: runtime.abortController.signal }
            : {}),
          systemInstruction: SYSTEM_PROMPT,
          tools: [
            {
              computerUse: {
                environment: Environment.ENVIRONMENT_BROWSER,
                excludedPredefinedFunctions: [
                  "open_web_browser",
                  "search",
                  "navigate",
                  "go_back",
                  "go_forward",
                ],
              },
            },
          ],
        },
      });

      const assistantText = extractGeminiAssistantText(response).trim();
      if (assistantText) {
        this.publishAssistantText(sessionId, assistantText);
      }

      const candidateContent = getGeminiCandidateContent(response);
      if (candidateContent) {
        contents.push(candidateContent);
      }

      const functionCalls = extractGeminiFunctionCalls(response);
      if (functionCalls.length === 0) {
        break;
      }

      const safetyDecision = findGeminiSafetyDecision(functionCalls);
      if (safetyDecision) {
        this.publishAssistantText(
          sessionId,
          safetyDecision.explanation ||
            "Gemini requested user confirmation before continuing, and confirmation handling is not implemented in this app yet.",
        );
        break;
      }

      const actions = functionCalls.flatMap((functionCall) =>
        normalizeGeminiFunctionCall(functionCall, currentViewport),
      );
      const screenshot = await this.executeActionsAndCaptureScreenshot(
        sessionId,
        runtime,
        actions,
      );
      currentViewport = screenshot.viewport;

      contents.push({
        role: "user",
        parts: functionCalls.map((functionCall, index) => {
          const functionName = functionCall.name ?? "computer_action";
          return {
            functionResponse: {
              id: functionCall.id ?? `${functionName}-${index + 1}`,
              name: functionName,
              response: {
                output: {
                  ok: true,
                },
              },
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: screenshot.base64,
                  },
                },
              ],
            },
          };
        }),
      });
    }
  }

  private async generateOpenAISessionTitle(
    userContent: string,
    runtime: ActiveRuntime,
  ): Promise<string> {
    const openai = this.requireOpenAI();
    const response = await openai.responses.create(
      {
        model: OPENAI_MODEL,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: SESSION_TITLE_PROMPT }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: userContent }],
          },
        ],
      },
      runtime.abortController?.signal
        ? { signal: runtime.abortController.signal }
        : undefined,
    );

    return extractAssistantText(response);
  }

  private async generateGeminiSessionTitle(
    userContent: string,
    runtime: ActiveRuntime,
  ): Promise<string> {
    const gemini = this.requireGemini();
    const response = await gemini.models.generateContent({
      model: GEMINI_MODEL,
      contents: userContent,
      config: {
        ...(runtime.abortController?.signal
          ? { abortSignal: runtime.abortController.signal }
          : {}),
        systemInstruction: SESSION_TITLE_PROMPT,
      },
    });

    return extractGeminiAssistantText(response);
  }

  private async captureInitialGeminiScreenshot(
    sessionId: string,
    runtime: ActiveRuntime,
  ): Promise<{
    base64: string;
    viewport: { width: number; height: number };
  }> {
    this.publishStatus(sessionId, "Capturing screenshot...");
    const { bytes } = await this.captureRuntimeScreenshot(sessionId, runtime);
    return {
      base64: Buffer.from(bytes).toString("base64"),
      viewport: getPngDimensions(bytes),
    };
  }

  private async executeActionsAndCaptureScreenshot(
    sessionId: string,
    runtime: ActiveRuntime,
    actions: ComputerAction[],
  ): Promise<{
    base64: string;
    viewport: { width: number; height: number };
  }> {
    const desktop = runtime.desktop;
    if (!desktop) {
      throw new Error(`Session ${sessionId} lost its desktop connection`);
    }

    let frameVersionBeforeActions: number | undefined = getDesktopFrameVersion(desktop);
    this.publishStatus(sessionId, describeComputerActions(actions));

    try {
      await executeComputerActions(desktop, actions);
    } catch (error) {
      if (!isRecoverableDesktopRuntimeError(error)) {
        throw error;
      }
      this.publishStatus(sessionId, "Desktop control connection dropped. Reconnecting...");
      await this.reconnectDesktop(runtime, runtime.abortController?.signal);
      frameVersionBeforeActions = undefined;
    }
    this.throwIfStopped(runtime);

    this.publishStatus(sessionId, "Capturing screenshot...");
    const { bytes } = await this.captureRuntimeScreenshot(sessionId, runtime, {
      preferFrameAfterVersion: frameVersionBeforeActions,
    });
    return {
      base64: Buffer.from(bytes).toString("base64"),
      viewport: getPngDimensions(bytes),
    };
  }

  private requireOpenAI(): OpenAIClientLike {
    if (!this.options.openai) {
      throw new Error("OPENAI_KEY is not configured for this session");
    }
    return this.options.openai;
  }

  private requireGemini(): GeminiClientLike {
    if (!this.options.gemini) {
      throw new Error("GEMINI_KEY is not configured for this session");
    }
    return this.options.gemini;
  }

  private async handleAbort(sessionId: string): Promise<void> {
    const record = this.options.store.requireSessionRecord(sessionId);
    if (record.terminatedAt) {
      return;
    }

    const message = this.options.store.createMessage({
      sessionId,
      role: "system",
      kind: "status",
      content: "Run stopped.",
    });
    this.options.eventBus.publish({
      type: "message.created",
      message,
    });

    const ready = this.options.store.updateSession(sessionId, {
      runState: "ready",
    });
    this.publishRunState(sessionId, "ready");
    this.publishSession(ready);
  }

  private async handleFailure(
    sessionId: string,
    error: unknown,
    options: { nextRunState: "ready" | "error" },
  ): Promise<void> {
    const record = this.options.store.requireSessionRecord(sessionId);
    if (record.terminatedAt) {
      return;
    }

    const messageText = error instanceof Error ? error.message : "Unknown error";

    const message = this.options.store.createMessage({
      sessionId,
      role: "assistant",
      kind: "error",
      content: messageText,
    });
    this.options.eventBus.publish({
      type: "message.created",
      message,
    });
    this.options.eventBus.publish({
      type: "error",
      sessionId,
      message: messageText,
    });

    const updated = this.options.store.updateSession(sessionId, {
      runState: options.nextRunState,
    });
    this.publishRunState(sessionId, options.nextRunState);
    this.publishSession(updated);
  }

  private async bootstrapSession(
    sessionId: string,
    runtime: ActiveRuntime,
  ): Promise<void> {
    try {
      const desktop = await this.connectDesktopWithRetry(
        runtime.sandbox,
        runtime.bootAbortController?.signal,
      );
      runtime.desktop = desktop;

      await sleepWithAbort(
        this.options.desktopBootWaitMs ?? 4_000,
        runtime.bootAbortController?.signal,
      );

      this.throwIfBootStopped(runtime);
      await this.captureRuntimeScreenshot(sessionId, runtime);

      const ready = this.options.store.updateSession(sessionId, {
        runState: "ready",
      });
      this.publishRunState(sessionId, "ready");
      this.publishSession(ready);
    } catch (error) {
      if (error instanceof RunAbortedError || isAbortLikeError(error, runtime)) {
        return;
      }
      await this.handleFailure(sessionId, error, { nextRunState: "error" });
    }
  }

  private async captureAndPersist(
    sessionId: string,
    desktop: DesktopSessionLike,
    options: {
      timeoutSeconds?: number | undefined;
      preferFrameAfterVersion?: number | undefined;
    } = {},
  ): Promise<{ bytes: Uint8Array; session: SessionSummary }> {
    const bytes = await this.captureDesktopBytes(desktop, options);
    const record = this.options.store.requireSessionRecord(sessionId);
    const screenshotPath = await writeScreenshot(
      this.options.screenshotDir,
      sessionId,
      bytes,
    );
    const updated = this.options.store.updateSession(sessionId, {
      lastScreenshotPath: screenshotPath,
      lastScreenshotRevision: record.lastScreenshotRevision + 1,
    });
    const session = toSessionSummary(updated);
    this.publishSession(updated);
    this.options.eventBus.publish({
      type: "screenshot.updated",
      sessionId,
      revision: session.lastScreenshotRevision,
      updatedAt: session.updatedAt,
    });
    return { bytes, session };
  }

  private async captureRuntimeScreenshot(
    sessionId: string,
    runtime: ActiveRuntime,
    options: {
      preferFrameAfterVersion?: number | undefined;
    } = {},
  ): Promise<{ bytes: Uint8Array; session: SessionSummary }> {
    const desktop = runtime.desktop;
    if (!desktop) {
      throw new Error(`Session ${sessionId} is still booting`);
    }

    try {
      return await this.captureAndPersist(
        sessionId,
        desktop,
        {
          timeoutSeconds: RUNTIME_SCREENSHOT_TIMEOUT_SECONDS,
          preferFrameAfterVersion: options.preferFrameAfterVersion,
        },
      );
    } catch (error) {
      if (!isRecoverableDesktopRuntimeError(error)) {
        throw error;
      }

      this.publishStatus(sessionId, "Screenshot capture stalled. Reconnecting desktop...");
      const reconnected = await this.reconnectDesktop(
        runtime,
        runtime.abortController?.signal ?? runtime.bootAbortController?.signal,
      );
      return this.captureAndPersist(
        sessionId,
        reconnected,
        {
          timeoutSeconds: RUNTIME_SCREENSHOT_TIMEOUT_SECONDS,
        },
      );
    }
  }

  private async captureLiveFrame(
    sessionId: string,
    runtime: ActiveRuntime,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const desktop = runtime.desktop;
    if (!desktop) {
      throw new Error(`Session ${sessionId} is still booting`);
    }

    try {
      return await desktop.screenshot(LIVE_FRAME_SCREENSHOT_TIMEOUT_SECONDS);
    } catch (error) {
      if (!isRecoverableDesktopRuntimeError(error)) {
        throw error;
      }

      const reconnected = await this.reconnectDesktop(runtime, signal);
      return reconnected.screenshot(LIVE_FRAME_SCREENSHOT_TIMEOUT_SECONDS);
    }
  }

  private async captureDesktopBytes(
    desktop: DesktopSessionLike,
    options: {
      timeoutSeconds?: number | undefined;
      preferFrameAfterVersion?: number | undefined;
    },
  ): Promise<Uint8Array> {
    if (
      options.preferFrameAfterVersion != null &&
      isFrameAwareDesktop(desktop)
    ) {
      try {
        return await desktop.screenshotAfter(
          options.preferFrameAfterVersion,
          FRESH_FRAME_WAIT_TIMEOUT_SECONDS,
        );
      } catch (error) {
        if (!isFreshFrameTimeoutError(error)) {
          throw error;
        }
      }
    }

    return desktop.screenshot(
      options.timeoutSeconds ?? RUNTIME_SCREENSHOT_TIMEOUT_SECONDS,
    );
  }

  private publishSession(record: SessionRecord): void {
    this.options.eventBus.publish({
      type: "session.upsert",
      session: toSessionSummary(record),
    });
  }

  private publishRunState(sessionId: string, runState: SessionSummary["runState"]): void {
    this.options.eventBus.publish({
      type: "run.state",
      sessionId,
      runState,
    });
  }

  private throwIfStopped(runtime: ActiveRuntime): void {
    if (runtime.stopRequested || runtime.abortController?.signal.aborted) {
      throw new RunAbortedError();
    }
  }

  private async connectDesktopWithRetry(
    sandbox: SandboxLike,
    signal?: AbortSignal,
    options: {
      connectTimeoutSeconds?: number;
    } = {},
  ): Promise<DesktopSessionLike> {
    const attempts = this.options.desktopConnectAttempts ?? 8;
    const retryMs = this.options.desktopConnectRetryMs ?? 2_000;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) {
        throw new RunAbortedError();
      }

      try {
        return await sandbox.connectDesktop({
          password: "tensorlake",
          ...(options.connectTimeoutSeconds != null
            ? { connectTimeout: options.connectTimeoutSeconds }
            : {}),
        });
      } catch (error) {
        lastError = error;
        if (attempt === attempts || !isRetryableDesktopConnectError(error)) {
          throw error;
        }
        await sleepWithAbort(retryMs, signal);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private throwIfBootStopped(runtime: ActiveRuntime): void {
    if (runtime.stopRequested || runtime.bootAbortController?.signal.aborted) {
      throw new RunAbortedError();
    }
  }

  private async reconnectDesktop(
    runtime: ActiveRuntime,
    signal?: AbortSignal,
  ): Promise<DesktopSessionLike> {
    await runtime.desktop?.close().catch(() => {});
    const desktop = await this.connectDesktopWithRetry(runtime.sandbox, signal, {
      connectTimeoutSeconds:
        this.options.desktopReconnectTimeoutSeconds ??
        DESKTOP_RECONNECT_TIMEOUT_SECONDS,
    });
    runtime.desktop = desktop;
    return desktop;
  }

  private async disposeRuntime(
    runtime: ActiveRuntime,
    options: { terminateSandbox: boolean },
  ): Promise<void> {
    runtime.stopRequested = true;
    runtime.bootAbortController?.abort();
    runtime.abortController?.abort();
    await runtime.bootPromise?.catch(() => {});
    await runtime.currentRunPromise?.catch(() => {});
    await runtime.desktop?.close().catch(() => {});
    await runtime.vncTunnelPromise?.catch(() => {});
    await runtime.vncTunnel?.close().catch(() => {});
    runtime.vncTunnel = null;
    runtime.vncTunnelPromise = null;
    if (options.terminateSandbox) {
      await runtime.sandbox.terminate().catch(() => {});
    }
    runtime.sandbox.close?.();
  }

  private async reconcileSessionRecord(
    sessionId: string,
    options: {
      allowRuntimeRecovery: boolean;
    },
  ): Promise<void> {
    const record = this.options.store.getSessionRecord(sessionId);
    if (!record || record.terminatedAt) {
      return;
    }

    if (!record.sandboxId) {
      await this.archiveSession(sessionId, "missing");
      return;
    }

    let status: string;
    try {
      const info = await this.options.sandboxClient.get(record.sandboxId);
      status = (info.status ?? record.sandboxStatus ?? "unknown").toLowerCase();
    } catch (error) {
      if (isRetryableSandboxStatusCheckError(error)) {
        return;
      }

      await this.archiveSession(sessionId, sandboxStatusFromCheckError(error));
      return;
    }

    if (status !== "running") {
      await this.archiveSession(sessionId, status);
      return;
    }

    if (record.sandboxStatus !== status) {
      const updated = this.options.store.updateSession(sessionId, {
        sandboxStatus: status,
      });
      this.publishSession(updated);
    }

    if (!options.allowRuntimeRecovery) {
      return;
    }

    const runtime = this.runtimes.get(sessionId);
    const canReuseRuntime =
      runtime &&
      (runtime.desktop !== null || runtime.bootPromise !== null || runtime.currentRunPromise !== null);

    if (canReuseRuntime) {
      return;
    }

    if (runtime) {
      await this.disposeRuntime(runtime, { terminateSandbox: false });
      this.runtimes.delete(sessionId);
    }

    await this.restoreRuntime(this.options.store.requireSessionRecord(sessionId), status);
  }

  private async restoreRuntime(
    record: SessionRecord,
    sandboxStatus: string,
  ): Promise<void> {
    if (!record.sandboxId || this.runtimes.has(record.id)) {
      return;
    }

    const sandbox = this.options.sandboxClient.connect(record.sandboxId);
    const runtime: ActiveRuntime = {
      sandbox,
      desktop: null,
      vncTunnel: null,
      vncTunnelPromise: null,
      bootPromise: null,
      bootAbortController: new AbortController(),
      currentRunPromise: null,
      abortController: null,
      stopRequested: false,
    };
    this.runtimes.set(record.id, runtime);

    const pending = this.options.store.updateSession(record.id, {
      sandboxStatus,
      runState: "pending",
      terminatedAt: null,
    });
    this.publishRunState(record.id, "pending");
    this.publishSession(pending);

    runtime.bootPromise = this.bootstrapSession(record.id, runtime).finally(() => {
      runtime.bootPromise = null;
      runtime.bootAbortController = null;
    });
  }

  private async archiveSession(
    sessionId: string,
    sandboxStatus: string,
  ): Promise<void> {
    const record = this.options.store.getSessionRecord(sessionId);
    if (!record || record.terminatedAt) {
      return;
    }

    const terminated = this.options.store.terminateSession(sessionId, sandboxStatus);
    this.publishRunState(sessionId, "terminated");
    this.publishSession(terminated);
    this.options.eventBus.publish({
      type: "session.terminated",
      sessionId,
    });

    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return;
    }

    await this.disposeRuntime(runtime, { terminateSandbox: false });
    this.runtimes.delete(sessionId);
  }

  private publishAssistantText(sessionId: string, content: string): void {
    this.publishMessage(sessionId, "assistant", "text", content);
  }

  private publishStatus(sessionId: string, content: string): void {
    this.publishMessage(sessionId, "system", "status", content);
  }

  private publishMessage(
    sessionId: string,
    role: "assistant" | "system",
    kind: "text" | "status",
    content: string,
  ): void {
    const message = this.options.store.createMessage({
      sessionId,
      role,
      kind,
      content,
    });
    this.options.eventBus.publish({
      type: "message.created",
      message,
    });
  }

  private requireLiveRuntime(
    sessionId: string,
    options: { allowRunning: boolean },
  ): {
    record: SessionRecord;
    runtime: ActiveRuntime;
    desktop: DesktopSessionLike;
  } {
    const record = this.options.store.requireSessionRecord(sessionId);
    if (record.terminatedAt) {
      throw new Error(`Session ${sessionId} is terminated`);
    }

    if (
      !options.allowRunning &&
      (record.runState === "running" || record.runState === "stopping")
    ) {
      throw new Error(`Session ${sessionId} is currently running`);
    }

    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      throw new Error(`Session ${sessionId} is not connected`);
    }

    if (!runtime.desktop || runtime.bootPromise || record.runState === "pending") {
      throw new Error(`Session ${sessionId} is still booting`);
    }

    return {
      record,
      runtime,
      desktop: runtime.desktop,
    };
  }
}

function extractAssistantText(response: OpenAIResponseLike): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  const texts: string[] = [];

  for (const item of response.output ?? []) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const message = item as {
      type?: string;
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (message.type !== "message" || message.role !== "assistant") {
      continue;
    }

    for (const content of message.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }

  return texts.join("\n\n");
}

function sanitizeSessionTitle(raw: string): string | null {
  const cleaned = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?,:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SESSION_TITLE_LENGTH)
    .trim();

  return cleaned || null;
}

function isDefaultSessionTitle(title: string): boolean {
  return title === UNTITLED_SESSION_TITLE || /^Sandbox \d+$/.test(title);
}

function findComputerCall(
  response: OpenAIResponseLike,
): { callId: string; actions: ComputerAction[] } | null {
  for (const item of response.output ?? []) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const candidate = item as {
      type?: string;
      call_id?: string;
      actions?: ComputerAction[];
    };

    if (
      candidate.type === "computer_call" &&
      typeof candidate.call_id === "string" &&
      Array.isArray(candidate.actions)
    ) {
      return {
        callId: candidate.call_id,
        actions: candidate.actions,
      };
    }
  }

  return null;
}

function buildGeminiContentsFromMessages(messages: ChatMessage[]): GeminiContentLike[] {
  const contents: GeminiContentLike[] = [];

  for (const message of messages) {
    if (message.kind !== "text") {
      continue;
    }

    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const role = message.role === "assistant" ? "model" : "user";
    const lastContent = contents.at(-1);
    if (lastContent?.role === role) {
      lastContent.parts ??= [];
      lastContent.parts.push({ text: message.content });
      continue;
    }

    contents.push({
      role,
      parts: [{ text: message.content }],
    });
  }

  return contents;
}

function extractGeminiAssistantText(response: GeminiGenerateContentResponseLike): string {
  if (typeof response.text === "string" && response.text.trim()) {
    return response.text;
  }

  const candidateContent = getGeminiCandidateContent(response);
  const texts =
    candidateContent?.parts
      ?.flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
      .filter((text) => text.trim().length > 0) ?? [];

  return texts.join("\n\n");
}

function getGeminiCandidateContent(
  response: GeminiGenerateContentResponseLike,
): GeminiContentLike | null {
  const candidate = response.candidates?.[0];
  return candidate?.content ?? null;
}

function extractGeminiFunctionCalls(
  response: GeminiGenerateContentResponseLike,
): GeminiFunctionCallLike[] {
  if (Array.isArray(response.functionCalls) && response.functionCalls.length > 0) {
    return response.functionCalls;
  }

  const candidateContent = getGeminiCandidateContent(response);
  return (
    candidateContent?.parts
      ?.flatMap((part) => (part.functionCall ? [part.functionCall] : []))
      .filter((call): call is GeminiFunctionCallLike => typeof call.name === "string") ?? []
  );
}

function findGeminiSafetyDecision(
  functionCalls: GeminiFunctionCallLike[],
): { decision: string; explanation?: string } | null {
  for (const functionCall of functionCalls) {
    const safetyDecision = functionCall.args?.safety_decision;
    if (
      safetyDecision &&
      typeof safetyDecision === "object" &&
      "decision" in safetyDecision &&
      typeof safetyDecision.decision === "string"
    ) {
      const decision = safetyDecision as {
        decision: string;
        explanation?: unknown;
      };
      if (decision.decision !== "require_confirmation") {
        continue;
      }
      return {
        decision: decision.decision,
        ...(typeof decision.explanation === "string"
          ? { explanation: decision.explanation }
          : {}),
      };
    }
  }

  return null;
}

function normalizeGeminiFunctionCall(
  functionCall: GeminiFunctionCallLike,
  viewport: { width: number; height: number },
): ComputerAction[] {
  const args = functionCall.args ?? {};

  switch (functionCall.name) {
    case "click_at":
      return [
        {
          type: "click",
          x: scaleGeminiCoordinate(args.x, viewport.width),
          y: scaleGeminiCoordinate(args.y, viewport.height),
        },
      ];
    case "hover_at":
      return [
        {
          type: "move",
          x: scaleGeminiCoordinate(args.x, viewport.width),
          y: scaleGeminiCoordinate(args.y, viewport.height),
        },
      ];
    case "type_text_at": {
      const x = scaleGeminiCoordinate(args.x, viewport.width);
      const y = scaleGeminiCoordinate(args.y, viewport.height);
      const text = typeof args.text === "string" ? args.text : "";
      const clearBeforeTyping =
        typeof args.clear_before_typing === "boolean"
          ? args.clear_before_typing
          : true;
      const pressEnter =
        typeof args.press_enter === "boolean" ? args.press_enter : true;

      return [
        {
          type: "click",
          x,
          y,
        },
        ...(clearBeforeTyping
          ? [
              {
                type: "keypress" as const,
                keys: ["control", "a"],
              },
              {
                type: "keypress" as const,
                keys: ["backspace"],
              },
            ]
          : []),
        ...(text
          ? [
              {
                type: "type" as const,
                text,
              },
            ]
          : []),
        ...(pressEnter
          ? [
              {
                type: "keypress" as const,
                keys: ["enter"],
              },
            ]
          : []),
      ];
    }
    case "key_combination":
      return [
        {
          type: "keypress",
          keys: parseGeminiKeyCombination(args.keys),
        },
      ];
    case "scroll_document":
      return [
        {
          type: "scroll",
          x: Math.round(viewport.width / 2),
          y: Math.round(viewport.height / 2),
          scrollY: directionToScrollDelta(args.direction, 800),
        },
      ];
    case "scroll_at":
      return [
        {
          type: "scroll",
          x: scaleGeminiCoordinate(args.x, viewport.width),
          y: scaleGeminiCoordinate(args.y, viewport.height),
          scrollY: directionToScrollDelta(
            args.direction,
            scaleGeminiCoordinate(args.magnitude ?? 800, viewport.height),
          ),
        },
      ];
    case "drag_and_drop":
      return [
        {
          type: "drag",
          path: [
            [
              scaleGeminiCoordinate(args.x, viewport.width),
              scaleGeminiCoordinate(args.y, viewport.height),
            ],
            [
              scaleGeminiCoordinate(args.destination_x, viewport.width),
              scaleGeminiCoordinate(args.destination_y, viewport.height),
            ],
          ],
        },
      ];
    case "wait_5_seconds":
      return [
        { type: "wait" },
        { type: "wait" },
        { type: "wait" },
      ];
    default:
      throw new Error(`Unsupported Gemini computer action \`${functionCall.name ?? "unknown"}\``);
  }
}

function scaleGeminiCoordinate(value: unknown, size: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Gemini computer action is missing a valid coordinate");
  }

  const clamped = Math.max(0, Math.min(999, Math.round(value)));
  if (size <= 1) {
    return clamped;
  }

  return Math.round((clamped / 999) * (size - 1));
}

function directionToScrollDelta(direction: unknown, magnitude: number): number {
  if (direction === "up") {
    return -Math.abs(magnitude);
  }
  if (direction === "down") {
    return Math.abs(magnitude);
  }

  throw new Error(`Unsupported Gemini scroll direction \`${String(direction)}\``);
}

function parseGeminiKeyCombination(keys: unknown): string[] {
  if (typeof keys !== "string" || !keys.trim()) {
    throw new Error("Gemini key_combination action is missing keys");
  }

  return keys
    .split("+")
    .map((key) => key.trim())
    .filter(Boolean);
}

function getPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    return { width: 1000, height: 1000 };
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function isAbortLikeError(error: unknown, runtime: ActiveRuntime): boolean {
  if (runtime.stopRequested || runtime.abortController?.signal.aborted) {
    return true;
  }

  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.toLowerCase().includes("abort"))
  );
}

function isRetryableDesktopConnectError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("timed out while connecting desktop session") ||
    message.includes("timed out while connecting tunnel websocket") ||
    message.includes("tunnel websocket closed before opening") ||
    message.includes("tunnel websocket handshake failed") ||
    message.includes("502") ||
    message.includes("bad gateway") ||
    message.includes("websocket handshake failed")
  );
}

function isRetryableSandboxStatusCheckError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("502") ||
    message.includes("bad gateway")
  );
}

function sandboxStatusFromCheckError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "missing";
  }

  const message = error.message.toLowerCase();
  if (message.includes("terminated")) {
    return "terminated";
  }
  if (message.includes("not found") || message.includes("missing")) {
    return "missing";
  }

  return "missing";
}

function isRecoverableDesktopRuntimeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("desktop tunnel closed unexpectedly") ||
    message.includes("desktop tunnel is not connected") ||
    message.includes("connection closed") ||
    message.includes("econnreset") ||
    message.includes("timed out waiting for initial desktop framebuffer") ||
    message.includes("timed out while connecting desktop session") ||
    message.includes("timed out while connecting tunnel websocket") ||
    message.includes("tunnel websocket closed before opening") ||
    message.includes("tunnel websocket handshake failed")
  );
}

function isFreshFrameTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message
      .toLowerCase()
      .includes("timed out waiting for a fresher desktop framebuffer")
  );
}

function isFrameAwareDesktop(
  desktop: DesktopSessionLike,
): desktop is DesktopSessionLike & {
  getFrameVersion(): number;
  screenshotAfter(frameVersion: number, timeoutSeconds?: number): Promise<Uint8Array>;
} {
  return (
    typeof desktop.getFrameVersion === "function" &&
    typeof desktop.screenshotAfter === "function"
  );
}

function getDesktopFrameVersion(desktop: DesktopSessionLike): number {
  if (!isFrameAwareDesktop(desktop)) {
    return 0;
  }

  return desktop.getFrameVersion();
}

function describeComputerActions(actions: ComputerAction[]): string {
  const lines = actions.map((action, index) => `${index + 1}. ${describeComputerAction(action)}`);
  return `Agent actions:\n${lines.join("\n")}`;
}

function describeComputerAction(action: ComputerAction): string {
  switch (action.type) {
    case "click":
      return `Click ${action.button ?? "left"} at (${action.x}, ${action.y})`;
    case "double_click":
      return `Double-click ${action.button ?? "left"} at (${action.x}, ${action.y})`;
    case "move":
      return `Move mouse to (${action.x}, ${action.y})`;
    case "drag": {
      const path = action.path.map((point) =>
        Array.isArray(point) ? point : [point.x, point.y] as [number, number]
      );
      const start = path[0];
      const end = path.at(-1);
      if (!start || !end) {
        return "Drag pointer";
      }
      return `Drag from (${start[0]}, ${start[1]}) to (${end[0]}, ${end[1]})`;
    }
    case "scroll": {
      const vertical = action.scrollY ?? 0;
      if (vertical === 0) {
        return `Scroll at (${action.x}, ${action.y})`;
      }
      return `${vertical < 0 ? "Scroll up" : "Scroll down"} at (${action.x}, ${action.y})`;
    }
    case "type":
      return `Type text: ${JSON.stringify(truncate(action.text, 80))}`;
    case "keypress":
      return `Press keys: ${action.keys.join(" + ")}`;
    case "wait":
      return "Wait briefly";
    case "screenshot":
      return "Take screenshot";
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return sleep(ms);
  }
  if (signal.aborted) {
    throw new RunAbortedError();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new RunAbortedError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
