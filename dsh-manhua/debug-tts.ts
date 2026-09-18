// 临时探测中转站可用的情感 TTS 模型（不打印密钥）
import { loadConfig } from "./src/config.js";
import { requireKey } from "./src/keys.js";

const cfg = loadConfig();
const key = await requireKey("openai");

for (const model of ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"]) {
  const resp = await fetch(`${cfg.openaiBaseUrl}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      voice: "alloy",
      input: "到了镇上，要听老师的话，别乱跑。",
      ...(model === "gpt-4o-mini-tts" ? { instructions: "以温柔而不舍的语气，语速稍慢，像母亲送孩子远行" } : {}),
    }),
  });
  console.log(model, "→", resp.status, resp.headers.get("content-type"));
  if (resp.ok) {
    const buf = Buffer.from(await resp.arrayBuffer());
    console.log("  OK bytes:", buf.length);
  } else {
    console.log("  err:", (await resp.text()).slice(0, 160));
  }
}
