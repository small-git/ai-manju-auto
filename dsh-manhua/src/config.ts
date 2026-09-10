import path from "node:path";
import dotenv from "dotenv";
import { mergedSettings } from "./keys.js";
import { REPO_ROOT, RUNS_DIR, STORIES_DIR } from "./paths.js";

export { REPO_ROOT, RUNS_DIR, STORIES_DIR, ensureDir } from "./paths.js";

export type ManhuaConfig = {
  repoRoot: string;
  storiesDir: string;
  runsDir: string;
  openaiBaseUrl: string;
  geminiBaseUrl: string;
  openaiImageModel: string;
  openaiChatModel: string;
  geminiImageModel: string;
  autodlBaseUrl: string;
  defaultResolution: string;
  defaultVideoWorkflowId: string;
  pollIntervalSec: number;
  pollTimeoutSec: number;
  publicAssetBaseUrl: string;
};

let envLoaded = false;

function loadEnvFiles(): void {
  if (envLoaded) return;
  dotenv.config({ path: path.join(REPO_ROOT, ".env") });
  dotenv.config({ path: path.join(REPO_ROOT, "dsh-manhua", ".env") });
  envLoaded = true;
}

/** Non-secret runtime settings. Secrets go through keys.resolveKey / requireKey. */
export function loadConfig(): ManhuaConfig {
  loadEnvFiles();
  const s = mergedSettings();
  return {
    repoRoot: REPO_ROOT,
    storiesDir: STORIES_DIR,
    runsDir: RUNS_DIR,
    openaiBaseUrl: (s.openaiBaseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    ),
    geminiBaseUrl: (
      s.geminiBaseUrl ||
      process.env.GEMINI_BASE_URL ||
      "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/$/, ""),
    openaiImageModel: s.openaiImageModel || process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
    openaiChatModel: s.openaiChatModel || process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    geminiImageModel: s.geminiImageModel || process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image",
    autodlBaseUrl: (s.autodlBaseUrl || process.env.AUTODL_BASE_URL || "https://autodl.art").replace(/\/$/, ""),
    defaultResolution: s.defaultResolution || process.env.DEFAULT_RESOLUTION || "768p横",
    defaultVideoWorkflowId:
      s.videoWorkflowId || process.env.AUTODL_VIDEO_WORKFLOW_ID || "minimax_h3_lightx2v_v5",
    pollIntervalSec: Number(process.env.POLL_INTERVAL_SEC || 3),
    pollTimeoutSec: Number(process.env.POLL_TIMEOUT_SEC || 1800),
    publicAssetBaseUrl: (s.publicAssetBaseUrl || process.env.PUBLIC_ASSET_BASE_URL || "").replace(/\/$/, ""),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
