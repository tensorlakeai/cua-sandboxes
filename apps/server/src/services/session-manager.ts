import path from "node:path";

import {
  type SessionSummary,
} from "@vnc-cua/contracts";

import {
  type ComputerAction,
  type DesktopLike,
  executeComputerActions,
} from "./action-executor.js";
import {
  SessionStore,
  toSessionSummary,
  type SessionRecord,
} from "./session-store.js";
import { EventBus } from "../lib/event-bus.js";
import { sleep } from "../lib/time.js";
import { writeScreenshot } from "../lib/screenshot.js";

export interface DesktopSessionLike extends DesktopLike {
  screenshot(timeoutSeconds?: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface SandboxLike {
  sandboxId: string;
  connectDesktop(options?: { password?: string }): Promise<DesktopSessionLike>;
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

interface ActiveRuntime {
  sandbox: SandboxLike;
  desktop: DesktopSessionLike | null;
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

const SYSTEM_PROMPT = `You are a computer-use agent operating a Linux desktop inside a sandbox.
Use the built-in computer tool for UI work. Be concise and helpful.
Do not send, submit, post, delete, purchase, or transmit sensitive data or irreversible changes without explicit user confirmation.
If a task would require risky external side effects, stop and ask the user in normal assistant text instead of taking that step.`;

export class SessionManager {
  private readonly runtimes = new Map<string, ActiveRuntime>();

  constructor(private readonly options: {
    store: SessionStore;
    eventBus: EventBus;
    openai: OpenAIClientLike;
    sandboxClient: SandboxClientLike;
    screenshotDir: string;
    desktopBootWaitMs?: number;
    desktopConnectAttempts?: number;
    desktopConnectRetryMs?: number;
  }) {}

  async restoreSessions(): Promise<void> {
    for (const record of this.options.store.listActiveSessionRecords()) {
      if (!record.sandboxId) {
        this.markSessionMissing(record.id, "missing");
        continue;
      }

      try {
        const info = await this.options.sandboxClient.get(record.sandboxId);
        const status = (info.status ?? "unknown").toLowerCase();

        if (status !== "running") {
          this.markSessionMissing(record.id, status);
          continue;
        }

        const sandbox = this.options.sandboxClient.connect(record.sandboxId);
        const runtime: ActiveRuntime = {
          sandbox,
          desktop: null,
          bootPromise: null,
          bootAbortController: new AbortController(),
          currentRunPromise: null,
          abortController: null,
          stopRequested: false,
        };
        this.runtimes.set(record.id, runtime);

        const pending = this.options.store.updateSession(record.id, {
          sandboxStatus: status,
          runState: "pending",
          terminatedAt: null,
        });
        this.publishRunState(record.id, "pending");
        this.publishSession(pending);

        runtime.bootPromise = this.bootstrapSession(record.id, runtime).finally(() => {
          runtime.bootPromise = null;
          runtime.bootAbortController = null;
        });
      } catch {
        this.markSessionMissing(record.id, "missing");
      }
    }
  }

  async createSession(): Promise<SessionSummary> {
    const sandbox = await this.options.sandboxClient.createAndConnect({
      image: "tensorlake/ubuntu-vnc",
    });

    try {
      const sessionId = `session_${crypto.randomUUID()}`;
      const session = this.options.store.createSession({
        id: sessionId,
        title: `Sandbox ${this.options.store.listSessionRecords().length + 1}`,
        sandboxId: sandbox.sandboxId,
        sandboxStatus: "running",
        runState: "pending",
      });

      const runtime: ActiveRuntime = {
        sandbox,
        desktop: null,
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
      runtime.stopRequested = true;
      runtime.bootAbortController?.abort();
      runtime.abortController?.abort();
      await runtime.bootPromise?.catch(() => {});
      await runtime.currentRunPromise?.catch(() => {});
      await runtime.desktop?.close().catch(() => {});
      await runtime.sandbox.terminate().catch(() => {});
      runtime.sandbox.close?.();
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

  async waitForIdle(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    await runtime?.bootPromise;
    await runtime?.currentRunPromise;
  }

  async shutdown(): Promise<void> {
    for (const [sessionId, runtime] of this.runtimes) {
      runtime.stopRequested = true;
      runtime.bootAbortController?.abort();
      runtime.abortController?.abort();
      await runtime.bootPromise?.catch(() => {});
      await runtime.currentRunPromise?.catch(() => {});
      await runtime.desktop?.close().catch(() => {});
      runtime.sandbox.close?.();
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
      let response = await this.options.openai.responses.create(
        {
          model: "gpt-5.4",
          tools: [{ type: "computer" }],
          ...(record.openaiLastResponseId
            ? {
                previous_response_id: record.openaiLastResponseId,
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
        openaiLastResponseId: response.id,
      });
      this.publishSession(record);

      while (true) {
        this.throwIfStopped(runtime);

        const computerCall = findComputerCall(response);
        if (!computerCall) {
          break;
        }

        const desktop = runtime.desktop;
        if (!desktop) {
          throw new Error(`Session ${sessionId} lost its desktop connection`);
        }

        try {
          await executeComputerActions(desktop, computerCall.actions);
        } catch (error) {
          if (!isRecoverableDesktopRuntimeError(error)) {
            throw error;
          }
          await this.reconnectDesktop(runtime, runtime.abortController?.signal);
        }
        this.throwIfStopped(runtime);

        const { bytes } = await this.captureRuntimeScreenshot(sessionId, runtime);
        const screenshotBase64 = Buffer.from(bytes).toString("base64");

        response = await this.options.openai.responses.create(
          {
            model: "gpt-5.4",
            tools: [{ type: "computer" }],
            previous_response_id: response.id,
            input: [
              {
                type: "computer_call_output",
                call_id: computerCall.callId,
                output: {
                  type: "computer_screenshot",
                  image_url: `data:image/png;base64,${screenshotBase64}`,
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
          openaiLastResponseId: response.id,
        });
        this.publishSession(record);
      }

      const assistantText = extractAssistantText(response).trim();
      if (assistantText) {
        const message = this.options.store.createMessage({
          sessionId,
          role: "assistant",
          kind: "text",
          content: assistantText,
        });
        this.options.eventBus.publish({
          type: "message.created",
          message,
        });
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
      await this.handleFailure(sessionId, error);
    }
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

  private async handleFailure(sessionId: string, error: unknown): Promise<void> {
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
      runState: "error",
    });
    this.publishRunState(sessionId, "error");
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
      await this.handleFailure(sessionId, error);
    }
  }

  private async captureAndPersist(
    sessionId: string,
    desktop: DesktopSessionLike,
  ): Promise<{ bytes: Uint8Array; session: SessionSummary }> {
    const bytes = await desktop.screenshot();
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
  ): Promise<{ bytes: Uint8Array; session: SessionSummary }> {
    const desktop = runtime.desktop;
    if (!desktop) {
      throw new Error(`Session ${sessionId} is still booting`);
    }

    try {
      return await this.captureAndPersist(sessionId, desktop);
    } catch (error) {
      if (!isRecoverableDesktopRuntimeError(error)) {
        throw error;
      }

      const reconnected = await this.reconnectDesktop(
        runtime,
        runtime.abortController?.signal ?? runtime.bootAbortController?.signal,
      );
      return this.captureAndPersist(sessionId, reconnected);
    }
  }

  private markSessionMissing(sessionId: string, sandboxStatus: string): void {
    const updated = this.options.store.terminateSession(sessionId, sandboxStatus);
    this.publishRunState(sessionId, "terminated");
    this.publishSession(updated);
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
  ): Promise<DesktopSessionLike> {
    const attempts = this.options.desktopConnectAttempts ?? 8;
    const retryMs = this.options.desktopConnectRetryMs ?? 2_000;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) {
        throw new RunAbortedError();
      }

      try {
        return await sandbox.connectDesktop({ password: "tensorlake" });
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
    const desktop = await this.connectDesktopWithRetry(runtime.sandbox, signal);
    runtime.desktop = desktop;
    return desktop;
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
    message.includes("502") ||
    message.includes("bad gateway") ||
    message.includes("websocket handshake failed")
  );
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
    message.includes("econnreset")
  );
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
