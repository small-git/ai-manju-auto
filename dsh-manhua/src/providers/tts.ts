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
}): Promise<TtsResult> {
  const voice = process.env.EDGE_TTS_VOICE || "zh-CN-YunxiNeural";
  let dest = opts.destPath;
  if (!path.extname(dest)) dest += ".mp3";
  ensureDir(path.dirname(dest));
  step("TTS", "使用 edge-tts 合成对白", { voice, chars: opts.text.length });

  const textFile = `${dest}.txt`;
  fs.writeFileSync(textFile, opts.text, "utf8");
  const py = `
import asyncio, edge_tts, sys
async def main():
    communicate = edge_tts.Communicate(open(sys.argv[1], encoding='utf-8').read(), sys.argv[2])
    await communicate.save(sys.argv[3])
asyncio.run(main())
`.trim();
  const result = spawnSync("python", ["-c", py, textFile, voice, dest], {
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

async function synthesizeWithOpenAi(opts: {
  text: string;
  destPath: string;
  voice?: string;
  signal?: AbortSignal;
}): Promise<TtsResult> {
  const cfg = loadConfig();
  const apiKey = await requireKey("openai");
  const model = process.env.OPENAI_TTS_MODEL || "tts-1";
  const voice = opts.voice || process.env.OPENAI_TTS_VOICE || "alloy";
  step("TTS", "开始 OpenAI 合成对白", { model, voice, chars: opts.text.length });
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

/**
 * dialogue → mp3。
 * 优先 OPENAI_TTS_PROVIDER=openai|edge|auto（默认 auto：OpenAI 失败则 edge-tts）。
 */
export async function synthesizeDialogue(opts: {
  text: string;
  destPath: string;
  voice?: string;
  signal?: AbortSignal;
}): Promise<TtsResult> {
  const mode = (process.env.OPENAI_TTS_PROVIDER || "auto").toLowerCase();
  if (mode === "edge") {
    return synthesizeWithEdge(opts);
  }
  if (mode === "openai") {
    return synthesizeWithOpenAi(opts);
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
