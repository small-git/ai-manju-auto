import fs from "node:fs";
import path from "node:path";
import { ensureDir, loadConfig } from "../config.js";
import { requireKey } from "../keys.js";
import { fail, ok, step } from "../zh-log.js";

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
  step("生图", "开始生成定妆（OpenAI）", { model: cfg.openaiImageModel });
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
    fail("生图", "OpenAI 定妆请求失败", { http: resp.status, data: JSON.stringify(data).slice(0, 400) });
    throw new Error(`OpenAI 定妆失败 HTTP ${resp.status}: ${JSON.stringify(data)}`);
  }
  const item = data.data?.[0];
  if (!item) {
    fail("生图", "OpenAI 定妆返回空结果", { data: JSON.stringify(data).slice(0, 400) });
    throw new Error(`OpenAI 定妆结果为空: ${JSON.stringify(data)}`);
  }

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
    fail("生图", "OpenAI 定妆缺少 b64_json/url");
    throw new Error("OpenAI 定妆缺少 b64_json/url");
  }
  url = url || publicUrlFor(localPath);
  ok("生图", "定妆已保存", { path: localPath, has_public_url: !!url });
  return { localPath, url, model: cfg.openaiImageModel, provider: "openai" };
}

/** Gemini image model → 分镜静帧 */
export async function generateStillWithGemini(opts: {
  prompt: string;
  destPath: string;
  signal?: AbortSignal;
}): Promise<SavedImage> {
  const cfg = loadConfig();
  const model = cfg.geminiImageModel;
  step("生图", "开始生成静帧（Gemini）", { model });
  const geminiApiKey = await requireKey("gemini");
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
    fail("生图", "Gemini 静帧请求失败", { http: resp.status, data: JSON.stringify(data).slice(0, 400) });
    throw new Error(`Gemini 静帧失败 HTTP ${resp.status}: ${JSON.stringify(data)}`);
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) {
    fail("生图", "Gemini 静帧缺少 inlineData", { data: JSON.stringify(data).slice(0, 500) });
    throw new Error(`Gemini 静帧缺少 inlineData: ${JSON.stringify(data).slice(0, 500)}`);
  }
  const ext = (inline.mimeType || "").includes("jpeg") ? ".jpg" : ".png";
  let localPath = opts.destPath;
  if (!path.extname(localPath)) localPath += ext;
  localPath = await writeBytes(localPath, Buffer.from(inline.data, "base64"));
  const url = publicUrlFor(localPath);
  ok("生图", "静帧已保存", { path: localPath, has_public_url: !!url });
  return {
    localPath,
    url,
    model,
    provider: "gemini",
  };
}
