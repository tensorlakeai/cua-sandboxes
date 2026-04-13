import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

import type { AppEnv } from "../env.js";
import type {
  DesktopSessionLike,
  OpenAIClientLike,
  OpenAIResponseLike,
  SandboxClientLike,
  SandboxLike,
} from "../services/session-manager.js";

export async function createTempWorkspace(prefix: string): Promise<{
  root: string;
  dbPath: string;
  screenshotDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    root,
    dbPath: path.join(root, "app.sqlite"),
    screenshotDir: path.join(root, "screenshots"),
  };
}

export async function cleanupWorkspace(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

export function createTestEnv(root: string): AppEnv {
  return {
    HOST: "127.0.0.1",
    PORT: 3000,
    OPENAI_KEY: "openai_test_key",
    TENSORLAKE_API_KEY: "tensorlake_test_key",
    TENSORLAKE_ORG_ID: "org_test",
    APP_DB_PATH: path.join(root, "app.sqlite"),
  };
}

export function tinyPngBytes(): Uint8Array {
  return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
}

export class FakeDesktop implements DesktopSessionLike {
  readonly click = vi.fn(async () => {});
  readonly doubleClick = vi.fn(async () => {});
  readonly moveMouse = vi.fn(async () => {});
  readonly mousePress = vi.fn(async () => {});
  readonly mouseRelease = vi.fn(async () => {});
  readonly typeText = vi.fn(async () => {});
  readonly press = vi.fn(async () => {});
  readonly keyDown = vi.fn(async () => {});
  readonly keyUp = vi.fn(async () => {});
  readonly scrollUp = vi.fn(async () => {});
  readonly scrollDown = vi.fn(async () => {});
  readonly close = vi.fn(async () => {});
  readonly screenshot = vi.fn(async () => this.screenshots.shift() ?? tinyPngBytes());

  constructor(
    private readonly screenshots: Uint8Array[] = [tinyPngBytes()],
  ) {}
}

export class FakeSandbox implements SandboxLike {
  readonly connectDesktop = vi.fn(async () => this.desktop);
  readonly terminate = vi.fn(async () => {});
  readonly close = vi.fn(() => {});

  constructor(
    public readonly sandboxId: string,
    public readonly desktop: FakeDesktop = new FakeDesktop(),
  ) {}
}

type OpenAIHandler = (
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<OpenAIResponseLike>;

export class FakeOpenAI implements OpenAIClientLike {
  private readonly queue: OpenAIHandler[] = [];

  readonly responses = {
    create: vi.fn(async (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      const handler = this.queue.shift();
      if (!handler) {
        throw new Error("Unexpected OpenAI call");
      }
      return handler(body, options);
    }),
  };

  enqueueResponse(response: OpenAIResponseLike): void {
    this.queue.push(async () => response);
  }

  enqueueHandler(handler: OpenAIHandler): void {
    this.queue.push(handler);
  }
}

export class FakeSandboxClient implements SandboxClientLike {
  private readonly createQueue: FakeSandbox[] = [];
  private readonly sandboxes = new Map<string, FakeSandbox>();
  private readonly statuses = new Map<string, string>();

  readonly createAndConnect = vi.fn(async () => {
    const sandbox = this.createQueue.shift();
    if (!sandbox) {
      throw new Error("Unexpected sandbox creation");
    }

    this.registerSandbox(sandbox, "running");
    return sandbox;
  });

  readonly connect = vi.fn((sandboxId: string) => {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} is not registered`);
    }
    return sandbox;
  });

  readonly get = vi.fn(async (sandboxId: string) => ({
    status: this.statuses.get(sandboxId) ?? "missing",
  }));

  readonly close = vi.fn(() => {});

  queueSandbox(sandbox: FakeSandbox, status = "running"): void {
    this.createQueue.push(sandbox);
    this.statuses.set(sandbox.sandboxId, status);
  }

  registerSandbox(sandbox: FakeSandbox, status = "running"): void {
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    this.statuses.set(sandbox.sandboxId, status);
  }

  setStatus(sandboxId: string, status: string): void {
    this.statuses.set(sandboxId, status);
  }
}

export function assistantResponse(id: string, text: string): OpenAIResponseLike {
  return {
    id,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

export function computerCallResponse(
  id: string,
  callId: string,
  actions: unknown[],
): OpenAIResponseLike {
  return {
    id,
    output: [
      {
        type: "computer_call",
        call_id: callId,
        actions,
      },
    ],
  };
}
