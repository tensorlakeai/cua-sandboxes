import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const TARGET = "exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();";
const REPLACEMENT = "exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = false;";

async function main() {
  const browserUtilPath = require.resolve("@novnc/novnc/lib/util/browser.js", {
    paths: [path.resolve(process.cwd(), "apps/web")],
  });

  const current = await fs.readFile(browserUtilPath, "utf8");
  if (!current.includes(TARGET)) {
    return;
  }

  const patched = current.replace(TARGET, REPLACEMENT);
  await fs.writeFile(browserUtilPath, patched, "utf8");
}

await main();
