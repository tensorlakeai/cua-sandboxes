import { sleep } from "../lib/time.js";

export interface DesktopLike {
  click(options?: { button?: "left" | "middle" | "right"; x?: number; y?: number }): Promise<void>;
  doubleClick(options?: {
    button?: "left" | "middle" | "right";
    x?: number;
    y?: number;
  }): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  mousePress(options?: { button?: "left" | "middle" | "right"; x?: number; y?: number }): Promise<void>;
  mouseRelease(options?: { button?: "left" | "middle" | "right"; x?: number; y?: number }): Promise<void>;
  typeText(text: string): Promise<void>;
  press(keys: string | string[]): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  scrollUp(steps?: number, x?: number, y?: number): Promise<void>;
  scrollDown(steps?: number, x?: number, y?: number): Promise<void>;
}

export interface ClickAction {
  type: "click";
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  keys?: string[];
}

export interface DoubleClickAction {
  type: "double_click";
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  keys?: string[];
}

export interface MoveAction {
  type: "move";
  x: number;
  y: number;
  keys?: string[];
}

export interface DragAction {
  type: "drag";
  path: Array<[number, number] | { x: number; y: number }>;
  keys?: string[];
}

export interface ScrollAction {
  type: "scroll";
  x: number;
  y: number;
  scrollX?: number;
  scrollY?: number;
  keys?: string[];
}

export interface TypeAction {
  type: "type";
  text: string;
}

export interface KeypressAction {
  type: "keypress";
  keys: string[];
}

export interface WaitAction {
  type: "wait";
}

export interface ScreenshotAction {
  type: "screenshot";
}

export type ComputerAction =
  | ClickAction
  | DoubleClickAction
  | MoveAction
  | DragAction
  | ScrollAction
  | TypeAction
  | KeypressAction
  | WaitAction
  | ScreenshotAction;

const KEY_ALIASES: Record<string, string> = {
  ALT: "alt",
  ARROWDOWN: "down",
  ARROWLEFT: "left",
  ARROWRIGHT: "right",
  ARROWUP: "up",
  BACKSPACE: "backspace",
  CMD: "meta",
  COMMAND: "meta",
  CONTROL: "ctrl",
  CTRL: "ctrl",
  DELETE: "delete",
  ENTER: "enter",
  ESC: "esc",
  ESCAPE: "esc",
  META: "meta",
  OPTION: "alt",
  PAGEDOWN: "pagedown",
  PAGE_DOWN: "pagedown",
  PAGEUP: "pageup",
  PAGE_UP: "pageup",
  SHIFT: "shift",
  SPACE: "space",
  SUPER: "meta",
  TAB: "tab",
};

export function normalizeKeyName(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error("Key names cannot be empty");
  }

  return KEY_ALIASES[trimmed.toUpperCase()] ?? trimmed.toLowerCase();
}

export function normalizeDragPath(path: DragAction["path"]): Array<[number, number]> {
  return path.map((point) => {
    if (Array.isArray(point)) {
      if (point.length !== 2) {
        throw new Error("Drag path tuple entries must contain exactly two values");
      }
      return [point[0], point[1]];
    }

    return [point.x, point.y];
  });
}

export function scrollStepsFromDelta(delta: number): number {
  if (delta === 0) {
    return 0;
  }

  return Math.max(1, Math.round(Math.abs(delta) / 100));
}

export async function executeComputerActions(
  desktop: DesktopLike,
  actions: ComputerAction[],
): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case "click":
        await withModifiers(desktop, action.keys, async () => {
          await desktop.click({
            button: action.button ?? "left",
            x: action.x,
            y: action.y,
          });
        });
        break;
      case "double_click":
        await withModifiers(desktop, action.keys, async () => {
          await desktop.doubleClick({
            button: action.button ?? "left",
            x: action.x,
            y: action.y,
          });
        });
        break;
      case "move":
        await withModifiers(desktop, action.keys, async () => {
          await desktop.moveMouse(action.x, action.y);
        });
        break;
      case "drag": {
        const path = normalizeDragPath(action.path);
        if (path.length < 2) {
          throw new Error("Drag action requires at least two path points");
        }
        const start = path[0];
        if (!start) {
          throw new Error("Drag action requires a starting path point");
        }

        await withModifiers(desktop, action.keys, async () => {
          const [startX, startY] = start;
          await desktop.mousePress({ x: startX, y: startY });
          for (const [x, y] of path.slice(1)) {
            await desktop.moveMouse(x, y);
          }
          await desktop.mouseRelease();
        });
        break;
      }
      case "scroll": {
        const vertical = action.scrollY ?? 0;
        await withModifiers(desktop, action.keys, async () => {
          await desktop.moveMouse(action.x, action.y);

          const steps = scrollStepsFromDelta(vertical);
          if (steps === 0) {
            return;
          }

          if (vertical < 0) {
            await desktop.scrollUp(steps, action.x, action.y);
          } else {
            await desktop.scrollDown(steps, action.x, action.y);
          }
        });
        break;
      }
      case "keypress":
        await desktop.press(action.keys.map(normalizeKeyName));
        break;
      case "type":
        await desktop.typeText(action.text);
        break;
      case "wait":
        await sleep(2_000);
        break;
      case "screenshot":
        break;
      default:
        throw new Error(`Unsupported computer action: ${(action satisfies never)}`);
    }
  }
}

async function withModifiers(
  desktop: DesktopLike,
  keys: string[] | undefined,
  callback: () => Promise<void>,
): Promise<void> {
  const normalizedKeys = (keys ?? []).map(normalizeKeyName);
  const pressedKeys: string[] = [];

  try {
    for (const key of normalizedKeys) {
      await desktop.keyDown(key);
      pressedKeys.push(key);
    }
    await callback();
  } finally {
    for (const key of pressedKeys.reverse()) {
      await desktop.keyUp(key);
    }
  }
}
