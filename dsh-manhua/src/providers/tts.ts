import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDir, loadConfig } from "../config.js";
import { requireKey } from "../keys.js";
import { fail, ok, step, warn } from "../zh-log.js";

export type TtsResult = {
  localPath: string;
  url?: string;
  provider: string;
  model: string;
};

/** 韵律参数：edge-tts 用 rate/volume/pitch 字符串；OpenAI 侧 rate 折算为 speed。 */
export type TtsProsody = { rate?: string; volume?: string; pitch?: string };

function publicUrlFor(localPath: string): string | undefined {
  const base = loadConfig().publicAssetBaseUrl;
  if (!base) return undefined;
  const rel = path.relative(loadConfig().repoRoot, localPath).replace(/\\/g, "/");
  return `${base}/${rel}`;
}

/** Microsoft Edge 在线语音（中文可用，无需 OpenAI TTS 通道） */
async function synthesizeWithEdge(opts: {
  text: string;
  destPath: string;
  voice?: string;
  prosody?: TtsProsody;
}): Promise<TtsResult> {
  const voice = opts.voice || process.env.EDGE_TTS_VOICE || "zh-CN-YunxiNeural";
  const rate = opts.prosody?.rate || "+0%";
  const volume = opts.prosody?.volume || "+0%";
  const pitch = opts.prosody?.pitch || "+0Hz";
  let dest = opts.destPath;
  if (!path.extname(dest)) dest += ".mp3";
  ensureDir(path.dirname(dest));
  step("TTS", "使用 edge-tts 合成对白", { voice, chars: opts.text.length, rate, volume, pitch });

  const textFile = `${dest}.txt`;
  fs.writeFileSync(textFile, opts.text, "utf8");
  const py = `
import asyncio, edge_tts, sys
async def main():
    communicate = edge_tts.Communicate(open(sys.argv[1], encoding='utf-8').read(), sys.argv[2], rate=sys.argv[3], volume=sys.argv[4], pitch=sys.argv[5])
    await communicate.save(sys.argv[6])
asyncio.run(main())
`.trim();
  const result = spawnSync("python", ["-c", py, textFile, voice, rate, volume, pitch, dest], {
    encoding: "utf8",
    timeout: 120_000,
  });
  try {
    fs.unlinkSync(textFile);
  } catch {
    /* ignore */
  }
  if (result.status !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size < 32) {
    const err = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail("TTS", "edge-tts 合成失败", { error: err.slice(0, 400) });
    throw new Error(`edge-tts 失败: ${err.slice(0, 300)}`);
  }
  ok("TTS", "对白音频已保存", { path: dest, bytes: fs.statSync(dest).size, provider: "edge-tts" });
  return {
    localPath: dest,
    url: publicUrlFor(dest),
    provider: "edge-tts",
    model: voice,
  };
}

/** rate 百分比（如 "-8%"）折算 OpenAI speed（0.25–4.0）。 */
function rateToSpeed(rate?: string): number | undefined {
  if (!rate) return undefined;
  const m = rate.match(/^([+-]?\d+(?:\.\d+)?)%$/);
  if (!m) return undefined;
  const speed = 1 + Number(m[1]) / 100;
  return Math.min(4, Math.max(0.25, Math.round(speed * 100) / 100));
}

async function synthesizeWithOpenAi(opts: {
  text: string;
  destPath: string;
  voice?: string;
  prosody?: TtsProsody;
  signal?: AbortSignal;
}): Promise<TtsResult> {
  const cfg = loadConfig();
  const apiKey = await requireKey("openai");
  const model = process.env.OPENAI_TTS_MODEL || "tts-1";
  const voice = opts.voice || process.env.OPENAI_TTS_VOICE || "alloy";
  const speed = rateToSpeed(opts.prosody?.rate);
  step("TTS", "开始 OpenAI 合成对白", { model, voice, chars: opts.text.length, speed });
  const resp = await fetch(`${cfg.openaiBaseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input: opts.text,
      ...(speed ? { speed } : {}),
    }),
    signal: opts.signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    fail("TTS", "OpenAI 合成失败", { http: resp.status, error: errText.slice(0, 400) });
    throw new Error(`OpenAI TTS 失败 HTTP ${resp.status}: ${errText.slice(0, 400)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  ensureDir(path.dirname(opts.destPath));
  let dest = opts.destPath;
  if (!path.extname(dest)) dest += ".mp3";
  fs.writeFileSync(dest, buf);
  ok("TTS", "对白音频已保存", { path: dest, bytes: buf.length, provider: "openai" });
  return {
    localPath: dest,
    url: publicUrlFor(dest),
    provider: "openai",
    model,
  };
}

/** 情绪文本 → IndexTTS2 情绪权重向量（emo_* 0–1.4；首个命中生效）。 */
const EMO_WEIGHTS: Array<[RegExp, Record<string, number | string>]> = [
  [/(不舍|悲伤|难过|沉重|压抑|沉默|忧郁)/, { emo_melancholic: 0.9, emo_calm: 0.3 }],
  [/(羞怯|不安|拘谨|害怕|紧张|警惕|焦虑|茫然)/, { emo_afraid: 0.7 }],
  [/(愤怒|生气|激动)/, { emo_angry: 0.9 }],
  [/(开心|欢快|喜悦|兴奋|高兴)/, { emo_happy: 1.0 }],
  [/(厌恶|嫌弃)/, { emo_disgusted: 0.8 }],
  [/(惊讶|震惊)/, { emo_surprised: "1" }],
  [/(坚定|决意|勇敢)/, { emo_calm: 0.5, emo_angry: 0.3 }],
  [/(平静|安定|温柔|温暖|安宁|希望|克制)/, { emo_calm: 0.6 }],
];

export function emotionToWeights(emotion?: string): Record<string, number | string> {
  if (!emotion) return {};
  for (const [re, w] of EMO_WEIGHTS) {
    if (re.test(emotion)) return w;
  }
  return {};
}

/** 情绪 → 官方情感参考音频（runs/shared/tts 下，经隧道公网）。返回公网 URL 或 undefined。 */
const EMO_REF_MAP: Array<[RegExp, string]> = [
  [/(不舍|悲伤|难过|沉重|压抑|沉默|忧郁|留恋)/, "emo_sad.wav"],
  [/(愤怒|生气|激动|憎恨)/, "emo_hate.wav"],
];

export function emoRefFor(emotion: string | undefined, repoRoot: string, publicBase: string): string | undefined {
  if (!emotion || !publicBase) return undefined;
  for (const [re, file] of EMO_REF_MAP) {
    if (re.test(emotion)) {
      const local = path.join(repoRoot, "runs", "shared", "tts", file);
      if (fs.existsSync(local)) return `${publicBase}/runs/shared/tts/${file}`;
    }
  }
  return undefined;
}

/** AutoDL IndexTTS2：情感参考音频 + 音色克隆（prompt_simple 为必填音色参考音频公网 URL）。 */
async function synthesizeWithAutodl(opts: {
  text: string;
  destPath: string;
  emotion?: string;
  voiceRef?: string;
  signal?: AbortSignal;
}): Promise<TtsResult> {
  if (!opts.voiceRef) {
    throw new Error("IndexTTS2 需要音色参考音频（voiceRef 公网 URL）");
  }
  const { submitWorkflow, waitResult, downloadResults } = await import("./autodl.js");
  const cfg = loadConfig();
  const workflowId = process.env.AUTODL_TTS_WORKFLOW_ID || "indextts2-v1";
  // 官方工作流情感只认「情感参考音频」；emo_* 权重在「与音色相同」模式下被忽略
  const emoRef = emoRefFor(opts.emotion, cfg.repoRoot, cfg.publicAssetBaseUrl);
  const body: Record<string, unknown> = {
    prompt_text: opts.text,
    prompt_simple: opts.voiceRef,
    emo_control_method: emoRef ? "使用情感参考音频" : "与音色参考音频相同",
  };
  if (emoRef) body.emo_ref_audio = emoRef;
  step("TTS", "IndexTTS2 情感配音", {
    workflow_id: workflowId,
    chars: opts.text.length,
    emo_ref: emoRef ? path.basename(emoRef) : "(无，跟随音色)",
  });
  const taskId = await submitWorkflow(workflowId, body, opts.signal);
  const data = await waitResult(taskId, opts.signal);
  let dest = opts.destPath;
  if (!path.extname(dest)) dest += ".mp3";
  ensureDir(path.dirname(dest));
  const stem = `${path.basename(dest, path.extname(dest))}_idx`;
  const files = await downloadResults(data, path.dirname(dest), stem, opts.signal);
  const primary = files.find((f) => /\.(mp3|wav|m4a|flac|ogg)$/i.test(f)) || files[0];
  if (!primary) {
    fail("TTS", "IndexTTS2 未返回音频", { workflow_id: workflowId });
    throw new Error("IndexTTS2 未返回音频");
  }
  if (primary !== dest) fs.copyFileSync(primary, dest);
  ok("TTS", "IndexTTS2 配音已保存", { path: dest, provider: "autodl-indextts2" });
  return { localPath: dest, url: publicUrlFor(dest), provider: "autodl-indextts2", model: workflowId };
}

/** Microsoft Edge 在线语音（也用于角色音色采样） */
export async function synthesizeWithEdgeSample(opts: {
  text: string;
  destPath: string;
  voice?: string;
}): Promise<TtsResult> {
  return synthesizeWithEdge(opts);
}

/**
 * dialogue → mp3。
 * OPENAI_TTS_PROVIDER=autodl|openai|edge|auto（默认 auto：IndexTTS2（情感）→ OpenAI → edge-tts）。
 */
export async function synthesizeDialogue(opts: {
  text: string;
  destPath: string;
  voice?: string;
  voiceRef?: string;
  emotion?: string;
  prosody?: TtsProsody;
  signal?: AbortSignal;
}): Promise<TtsResult> {
  const mode = (process.env.OPENAI_TTS_PROVIDER || "auto").toLowerCase();
  if (mode === "edge") {
    return synthesizeWithEdge(opts);
  }
  if (mode === "openai") {
    return synthesizeWithOpenAi(opts);
  }
  if (mode === "autodl") {
    return synthesizeWithAutodl(opts);
  }
  try {
    return await synthesizeWithAutodl(opts);
  } catch (err) {
    warn("TTS", "IndexTTS2 不可用，回退 OpenAI", {
      error: err instanceof Error ? err.message.slice(0, 180) : String(err),
    });
  }
  try {
    return await synthesizeWithOpenAi(opts);
  } catch (err) {
    warn("TTS", "OpenAI TTS 不可用，回退 edge-tts", {
      error: err instanceof Error ? err.message.slice(0, 180) : String(err),
    });
    return synthesizeWithEdge(opts);
  }
}
