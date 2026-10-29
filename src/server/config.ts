import { readFileSync, writeFileSync, existsSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

export interface Config {
  port: number;
  dataDir: string;
  transcriptionModel: string;
  groq: { apiKey: string };
  jev: { apiKey: string; model: string };
  haiku: { apiKey: string };
  notion: { clientId: string; clientSecret: string; accessToken?: string };
  thresholds: {
    whisperAvgLogprob: number;
    whisperNoSpeechProb: number;
    whisperCompressionRatio: number;
    noiseMinProbability: number;
  };
  contextMarginMs: number;
  mergeWindowConcurrency: number;
  mergeWindowRetryAttempts?: number;
  mergeWindowRetryBaseMs?: number;
  chunkTargetMs: number;
  retryDelayBaseMs?: number;
  haikuTokenThreshold?: number;
}

function loadJson(filePath: string): Partial<Config> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Partial<Config>;
  } catch {
    return {};
  }
}

function loadConfig(root: string = repoRoot): Config {
  const examplePath = path.join(root, "config.example.json");
  const localPath = path.join(root, "config.local.json");

  const example = loadJson(examplePath) as Config;
  const local = loadJson(localPath);

  return { ...example, ...local };
}

export const config = loadConfig();

export function loadConfigFrom(root: string): Config {
  const examplePath = path.join(root, "config.example.json");
  const localPath = path.join(root, "config.local.json");

  const example = loadJson(examplePath) as Config;
  const local = loadJson(localPath);

  return { ...example, ...local };
}

export function notionCallbackUri(port: number): string {
  return `http://localhost:${port}/api/notion/callback`;
}

export function saveNotionToken(configRoot: string, accessToken: string): void {
  const localPath = path.join(configRoot, "config.local.json");
  const existing = loadJson(localPath) as Partial<Config>;
  const updated = {
    ...existing,
    notion: { ...(existing.notion ?? {}), accessToken },
  };
  writeFileSync(localPath, JSON.stringify(updated, null, 2), "utf8");
}
