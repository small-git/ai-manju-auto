import fs from "node:fs";
import path from "node:path";
import { ensureDir, loadConfig } from "../config.js";
import { requireKey } from "../keys.js";

export type SavedImage = {
  localPath: string;
  /** public URL if API returned one or PUBLIC_ASSET_BASE_URL is set */
  url?: string;
  model: string;
  provider: string;
};

async function writeBytes(dest: string, buf: Buffer): Promise<string> {
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, buf);
  return dest;
}

function publicUrlFor(localPath: string): string | undefined {
  const base = loadConfig().publicAssetBaseUrl;
  if (!base) return undefined;
  const rel = path.relative(loadConfig().repoRoot, localPath).replace(/\\/g, "/");
  return `${base}/${rel}`;
}

/** ChatGPT / OpenAI Images API → 定妆 */
export async function generateSheetWithGpt(opts: {
  prompt: string;
  destPath: string;
  size?: string;
  signal?: AbortSignal;
}): Promise<SavedImage> {
  const cfg = loadConfig();
  const openaiApiKey = await requireKey("openai");
  const body = {
    model: cfg.openaiImageModel,
    prompt: opts.prompt,
    n: 1,
    size: opts.size || "1024x1536",
  };
  const resp = await fetch(`${cfg.openaiBaseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const data = (await resp.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
    error?: { message?: string };
  };
  if (!resp.ok) {
    throw new Error(`OpenAI image HTTP ${resp.status}: ${JSON.stringify(data)}`);
  }
  const item = data.data?.[0];
  if (!item) throw new Error(`OpenAI image empty: ${JSON.stringify(data)}`);

  let localPath = opts.destPath;
  let url = item.url;
  if (item.b64_json) {
    localPath = await writeBytes(localPath, Buffer.from(item.b64_json, "base64"));
  } else if (item.url) {
    const img = await fetch(item.url, { signal: opts.signal });
    const buf = Buffer.from(await img.arrayBuffer());
    const ext = path.extname(new URL(item.url).pathname) || ".png";
    if (!path.extname(localPath)) localPath = localPath + ext;
    localPath = await writeBytes(localPath, buf);
  } else {
    throw new Error("OpenAI image missing b64_json/url");
  }
  url = url || publicUrlFor(localPath);
  return { localPath, url, model: cfg.openaiImageModel, provider: "openai" };
}

/** Gemini image model → 分镜静帧 */
export async function generateStillWithGemini(opts: {
  prompt: string;
  destPath: string;
  signal?: AbortSignal;
}): Promise<SavedImage> {
  const cfg = loadConfig();
  const geminiApiKey = await requireKey("gemini");
  const model = cfg.geminiImageModel;
  let base = cfg.geminiBaseUrl.replace(/\/$/, "");
  // LinkAPI / Google: root host needs /v1beta; OpenAI-compat /v1 is wrong for native generateContent
  if (/^https?:\/\/[^/]+$/i.test(base)) {
    base = `${base}/v1beta`;
  } else if (base.endsWith("/v1")) {
    base = `${base.slice(0, -3)}/v1beta`;
  }
  const endpoint = base.includes("/models/")
    ? `${base}:generateContent?key=${encodeURIComponent(geminiApiKey)}`
    : `${base}/models/${model}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],
    },
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const data = (await resp.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> };
    }>;
    error?: { message?: string };
  };
  if (!resp.ok) {
    throw new Error(`Gemini image HTTP ${resp.status}: ${JSON.stringify(data)}`);
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) {
    throw new Error(`Gemini image missing inlineData: ${JSON.stringify(data).slice(0, 500)}`);
  }
  const ext = (inline.mimeType || "").includes("jpeg") ? ".jpg" : ".png";
  let localPath = opts.destPath;
  if (!path.extname(localPath)) localPath += ext;
  localPath = await writeBytes(localPath, Buffer.from(inline.data, "base64"));
  return {
    localPath,
    url: publicUrlFor(localPath),
    model,
    provider: "gemini",
  };
}
