import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});
loadDotenv();

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  OPENAI_KEY: z.string().min(1).optional(),
  GEMINI_KEY: z.string().min(1).optional(),
  TENSORLAKE_API_KEY: z.string().min(1),
  TENSORLAKE_ORG_ID: z.string().min(1),
  TENSORLAKE_PROJECT_ID: z.string().min(1).optional(),
  TENSORLAKE_API_URL: z.string().url().optional(),
  APP_DB_PATH: z.string().default("./data/cua.sqlite"),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(overrides?: Partial<Record<keyof AppEnv, unknown>>): AppEnv {
  const env = envSchema.parse({
    ...process.env,
    ...overrides,
  });

  if (!env.GEMINI_KEY && !env.OPENAI_KEY) {
    throw new Error("Either GEMINI_KEY or OPENAI_KEY must be configured");
  }

  return {
    ...env,
    APP_DB_PATH: path.resolve(workspaceRoot, env.APP_DB_PATH),
  };
}
