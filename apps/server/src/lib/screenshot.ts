import fs from "node:fs/promises";
import path from "node:path";

export function screenshotPathFor(rootDir: string, sessionId: string): string {
  return path.resolve(rootDir, `${sessionId}.png`);
}

export async function writeScreenshot(
  rootDir: string,
  sessionId: string,
  bytes: Uint8Array,
): Promise<string> {
  await fs.mkdir(rootDir, { recursive: true });
  const filePath = screenshotPathFor(rootDir, sessionId);
  await fs.writeFile(filePath, Buffer.from(bytes));
  return filePath;
}
