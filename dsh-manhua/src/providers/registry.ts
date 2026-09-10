/**
 * Provider 抽象层：图像 / 视频 / TTS 可热切换。
 */
import fs from "node:fs";
import path from "node:path";
import { generateSheetWithGpt, generateStillWithGemini, type SavedImage } from "./images.js";
import { runMultiRefVideo, runBridgeVideo, runLipsyncVideo, type AutodlVideoResult } from "./autodl.js";
import { synthesizeDialogue, type TtsResult } from "./tts.js";

export type ImageProviderId = "openai" | "gemini";
export type VideoProviderId = "autodl";
export type TtsProviderId = "openai";

export type ProviderRegistry = {
  sheet: ImageProviderId;
  still: ImageProviderId;
  video: VideoProviderId;
  tts: TtsProviderId;
};

const DEFAULT_REGISTRY: ProviderRegistry = {
  sheet: "openai",
  still: "gemini",
  video: "autodl",
  tts: "openai",
};

let registry: ProviderRegistry = { ...DEFAULT_REGISTRY };

export function getProviders(): ProviderRegistry {
  return { ...registry };
}

export function setProviders(partial: Partial<ProviderRegistry>): ProviderRegistry {
  registry = { ...registry, ...partial };
  return getProviders();
}

export async function providerGenerateSheet(opts: {
  prompt: string;
  destPath: string;
  size?: string;
  signal?: AbortSignal;
}): Promise<SavedImage> {
  if (registry.sheet === "gemini") {
    return generateStillWithGemini({ prompt: opts.prompt, destPath: opts.destPath, signal: opts.signal });
  }
  return generateSheetWithGpt(opts);
}

export async function providerGenerateStill(opts: {
  prompt: string;
  destPath: string;
  signal?: AbortSignal;
}): Promise<SavedImage> {
  if (registry.still === "openai") {
    return generateSheetWithGpt({ prompt: opts.prompt, destPath: opts.destPath, signal: opts.signal });
  }
  return generateStillWithGemini(opts);
}

export async function providerVideoRef(opts: Parameters<typeof runMultiRefVideo>[0]): Promise<AutodlVideoResult> {
  return runMultiRefVideo(opts);
}

export async function providerBridge(opts: Parameters<typeof runBridgeVideo>[0]): Promise<AutodlVideoResult> {
  return runBridgeVideo(opts);
}

export async function providerLipsync(opts: Parameters<typeof runLipsyncVideo>[0]): Promise<AutodlVideoResult> {
  return runLipsyncVideo(opts);
}

export async function providerTts(opts: Parameters<typeof synthesizeDialogue>[0]): Promise<TtsResult> {
  return synthesizeDialogue(opts);
}

export function listStyleLocksFromRepo(repoRoot: string): string[] {
  const dir = path.join(repoRoot, "templates", "style_locks");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.replace(/\.txt$/, ""));
}
