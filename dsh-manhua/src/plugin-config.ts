/**
 * Build schemastery Config when peer packages exist.
 * Config only stores credential *references*, never literal keys.
 */
import { createRequire } from "node:module";
import type { KeyProvider } from "./keys.js";
import { DEFAULT_KEY_REFS } from "./keys.js";

export const MANHUA_SETTINGS_NS = "dsh-manhua";

export interface Config {
  autodlApiTokenEnv?: string;
  openaiApiKeyEnv?: string;
  geminiApiKeyEnv?: string;
  autodlBaseUrl?: string;
  openaiBaseUrl?: string;
  geminiBaseUrl?: string;
  openaiImageModel?: string;
  openaiChatModel?: string;
  geminiImageModel?: string;
  defaultResolution?: string;
  videoWorkflowId?: string;
  publicAssetBaseUrl?: string;
  storiesRoot?: string;
}

export function buildConfigSchema(): unknown {
  try {
    const req = createRequire(import.meta.url);
    const z = req("@deepseek-ai/schemastery").default as {
      object: (s: Record<string, unknown>) => unknown;
      string: () => {
        role: (r: string) => { default: (v: string) => unknown };
        default: (v: string) => unknown;
      };
    };
    return z.object({
      autodlApiTokenEnv: z.string().role("credential-ref").default(DEFAULT_KEY_REFS.autodl),
      openaiApiKeyEnv: z.string().role("credential-ref").default(DEFAULT_KEY_REFS.openai),
      geminiApiKeyEnv: z.string().role("credential-ref").default(DEFAULT_KEY_REFS.gemini),
      autodlBaseUrl: z.string().default("https://autodl.art"),
      openaiBaseUrl: z.string().default("https://api.openai.com/v1"),
      geminiBaseUrl: z.string().default("https://generativelanguage.googleapis.com/v1beta"),
      openaiImageModel: z.string().default("gpt-image-1"),
      openaiChatModel: z.string().default("gpt-4o-mini"),
      geminiImageModel: z.string().default("gemini-3.1-flash-image"),
      defaultResolution: z.string().default("768p横"),
      videoWorkflowId: z.string().default("minimax_h3_lightx2v_v5"),
      publicAssetBaseUrl: z.string(),
      storiesRoot: z.string(),
    });
  } catch {
    return undefined;
  }
}

export const Config = buildConfigSchema();

export function refsFromConfig(config: Config = {}): Record<KeyProvider, string> {
  return {
    autodl: config.autodlApiTokenEnv || DEFAULT_KEY_REFS.autodl,
    openai: config.openaiApiKeyEnv || DEFAULT_KEY_REFS.openai,
    gemini: config.geminiApiKeyEnv || DEFAULT_KEY_REFS.gemini,
  };
}

export function settingsFromConfig(config: Config = {}) {
  return {
    autodlBaseUrl: config.autodlBaseUrl,
    openaiBaseUrl: config.openaiBaseUrl,
    geminiBaseUrl: config.geminiBaseUrl,
    openaiImageModel: config.openaiImageModel,
    openaiChatModel: config.openaiChatModel,
    geminiImageModel: config.geminiImageModel,
    defaultResolution: config.defaultResolution,
    videoWorkflowId: config.videoWorkflowId,
    publicAssetBaseUrl: config.publicAssetBaseUrl,
  };
}
