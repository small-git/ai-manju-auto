import fs from "node:fs";
import path from "node:path";
import { ensureDir, loadConfig } from "../config.js";
import { requireKey } from "../keys.js";

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

/** OpenAI TTS：dialogue → mp3 */
export async function synthesizeDialogue(opts: {
  text: string;
  destPath: string;
  voice?: string;
  signal?: AbortSignal;
}): Promise<TtsResult> {
  const cfg = loadConfig();
  const apiKey = await requireKey("openai");
  const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const voice = opts.voice || process.env.OPENAI_TTS_VOICE || "alloy";
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
    throw new Error(`OpenAI TTS HTTP ${resp.status}: ${errText.slice(0, 400)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  ensureDir(path.dirname(opts.destPath));
  let dest = opts.destPath;
  if (!path.extname(dest)) dest += ".mp3";
  fs.writeFileSync(dest, buf);
  return {
    localPath: dest,
    url: publicUrlFor(dest),
    provider: "openai",
    model,
  };
}
