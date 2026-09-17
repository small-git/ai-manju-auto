/**
 * 文案工作室 LLM：续写 / 反转 / 改写，以及「冻结人设」拆下一章分镜。
 */
import { loadConfig } from "../config.js";
import { requireKey } from "../keys.js";
import type { StoryPack, StoryShot } from "../story.js";
import { fail, ok, step, warn } from "../zh-log.js";

/** 中转站把上游 SSE 流原样塞进 content 的兼容：解包 data: 帧拼回正文。 */
function unwrapSse(text: string): string {
  if (!/^\s*data:/m.test(text)) return text;
  const parts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      const piece = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content;
      if (typeof piece === "string") parts.push(piece);
    } catch {
      /* 跳过非 JSON 帧 */
    }
  }
  return parts.length ? parts.join("") : text;
}

/** 宽松提取 JSON：容忍 markdown 围栏与前后杂质。 */
function parseJsonLoose<T>(text: string): T {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new Error(`LLM 返回非 JSON：${cleaned.slice(0, 200)}`);
  }
}

/** 中转站偶发 SSE/502/空内容：显式 stream:false + 有限重试（429/5xx/空内容/解析失败可重试，4xx 直接失败）。 */
async function chatJson<T>(opts: {
  system: string;
  user: unknown;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const cfg = loadConfig();
  const apiKey = await requireKey("openai");
  const maxAttempts = 3;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      step("文案LLM", "正在请求 Chat Completions", { model: cfg.openaiChatModel, attempt });
      const signal = opts.signal ?? AbortSignal.timeout(180_000);
      const resp = await fetch(`${cfg.openaiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.openaiChatModel,
          temperature: opts.temperature ?? 0.7,
          stream: false,
          response_format: { type: "json_object" },
          messages: [
            // 上游强制 json_object 时要求消息含小写 "json"
            { role: "system", content: `${opts.system}\n请仅以 json 格式输出。` },
            { role: "user", content: typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user) },
          ],
        }),
        signal,
      });
      const raw = await resp.text();
      if (!resp.ok) {
        const msg = raw.slice(0, 300);
        const err = new Error(`文案 LLM HTTP ${resp.status}: ${msg}`);
        // 4xx（除 429）属确定性错误，不重试
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          fail("文案LLM", "请求失败（不重试）", { error: msg });
          throw Object.assign(err, { retryable: false });
        }
        throw Object.assign(err, { retryable: true });
      }
      let data: {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string; code?: string };
      };
      try {
        data = JSON.parse(raw);
      } catch {
        // 整个响应就是 SSE 流：包一层便于统一解包
        data = { choices: [{ message: { content: raw } }] };
      }
      let content = data.choices?.[0]?.message?.content || "";
      content = unwrapSse(content).trim();
      if (!content) throw Object.assign(new Error("文案 LLM 返回空内容"), { retryable: true });
      ok("文案LLM", "已收到 JSON 响应", { chars: content.length });
      return parseJsonLoose<T>(content);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const retryable = (e as { retryable?: boolean })?.retryable !== false && !/不重试/.test(lastErr.message);
      if (!retryable || attempt === maxAttempts) break;
      const wait = attempt * 3000;
      warn("文案LLM", "请求失败，退避后重试", { attempt, wait_ms: wait, error: lastErr.message.slice(0, 160) });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  fail("文案LLM", "请求最终失败", { error: lastErr?.message });
  throw lastErr ?? new Error("文案 LLM 失败");
}

export type WritingGenerateKind = "continue" | "twist" | "revise";

export async function generateWritingText(opts: {
  kind: WritingGenerateKind;
  source_text: string;
  logline?: string;
  title?: string;
  instruction?: string;
  /** 约字数提示，默认 600–1200 */
  target_chars?: number;
  signal?: AbortSignal;
}): Promise<{ content: string; logline?: string; notes?: string }> {
  const target = opts.target_chars || 900;
  const kindHint =
    opts.kind === "continue"
      ? "在既有正文之后自然续写下一情节段落，保持人物口吻与世界观，不推翻已发生事实。"
      : opts.kind === "twist"
        ? "在既有正文基础上增加一个有力反转/悬念落点，反转要合理可回溯，不要无端换主角身份。"
        : "按用户指示改写/润色既有正文；未提及处保持原意。";

  const system = `你是漫剧编剧文案助手。输出严格 JSON：
{
  "content": "正文（中文，可分段）",
  "logline": "一句话主线（可空）",
  "notes": "编剧备注（可空）"
}
规则：${kindHint}
目标篇幅约 ${target} 字（可上下浮动）。禁止输出 markdown 代码块。禁止改写人物五官发型服装等定妆身份。`;

  const out = await chatJson<{ content?: string; logline?: string; notes?: string }>({
    system,
    user: {
      title: opts.title,
      logline: opts.logline,
      source_text: opts.source_text,
      instruction: opts.instruction || "",
      kind: opts.kind,
    },
    temperature: opts.kind === "twist" ? 0.85 : 0.7,
    signal: opts.signal,
  });
  if (!out.content?.trim()) throw new Error("文案生成结果为空");
  return {
    content: out.content.trim(),
    logline: out.logline?.trim() || undefined,
    notes: out.notes?.trim() || undefined,
  };
}

/** 从梗概 LLM 拆出 StoryPack 草稿（需人工改后再生成资产） */
export async function expandStoryFromSynopsis(opts: {
  story_id: string;
  title?: string;
  logline: string;
  synopsis: string;
  style_lock?: string;
  signal?: AbortSignal;
}): Promise<StoryPack> {
  const system = `你是漫剧分镜编剧。输出严格 JSON（不要 markdown），结构：
{
  "story_id": string,
  "chapter_id": "CH01",
  "project_id": string,
  "title": string,
  "style_lock": string,
  "resolution": "768p横",
  "video_workflow": "manhua_video_ref",
  "steps": ["video"],
  "script": { "logline", "synopsis", "theme", "episodes":[{ "episode_id","title","summary","beats":[{ "beat_id","scene_id","summary","emotion"}] }] },
  "characters": [{ "id","name","role","identity_lock","sheet_prompt","approved": true, "ref_images": {} }],
  "environments": [{ "id","name","scene_card","time_of_day","weather","ref_images": {} }],
  "props": [{ "id","name","clue_lock","ref_images": {} }],
  "shots": [{ "shot_id","episode_id","scene_id","beat_id","environment_id","character_ids","prop_ids","duration","camera":{"shot_size","angle","move"},"action","dialogue","emotion","plan_path":"video_ref","still_approved":true,"needs_lipsync":false }]
}
规则：一故事一宇宙；identity_lock 写清五官发型服装且分镜 action 不得改身份；横屏 768p；3–6 个镜头；道具可为空数组；shot_id 必须形如 E01_S01_SH01。`;

  const pack = await chatJson<StoryPack>({
    system,
    user: {
      story_id: opts.story_id,
      title: opts.title || opts.story_id,
      logline: opts.logline,
      synopsis: opts.synopsis,
      style_lock: opts.style_lock || "live_action",
    },
    temperature: 0.4,
    signal: opts.signal,
  });
  pack.story_id = opts.story_id;
  pack.resolution = pack.resolution || "768p横";
  pack.video_workflow = pack.video_workflow || "manhua_video_ref";
  pack.style_lock = opts.style_lock || pack.style_lock || "live_action";
  pack.props = pack.props || [];
  return pack;
}

type ExpandDelta = {
  episode?: {
    episode_id: string;
    title: string;
    summary: string;
    beats: Array<{ beat_id: string; scene_id: string; summary: string; emotion: string }>;
  };
  new_characters?: StoryPack["characters"];
  new_environments?: StoryPack["environments"];
  new_props?: NonNullable<StoryPack["props"]>;
  new_shots?: StoryShot[];
  logline?: string;
  synopsis_patch?: string;
};

function nextEpisodeId(pack: StoryPack): string {
  const eps = ((pack.script as { episodes?: Array<{ episode_id?: string }> })?.episodes || [])
    .map((e) => e.episode_id || "")
    .filter(Boolean);
  let max = 0;
  for (const id of eps) {
    const m = /^E(\d+)$/i.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  for (const sh of pack.shots || []) {
    const m = /^E(\d+)_/i.exec(sh.shot_id || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `E${String(max + 1).padStart(2, "0")}`;
}

/**
 * 在既有 StoryPack 上按新文案追加一集分镜；冻结已有 identity_lock / clue_lock。
 */
export async function expandNextEpisodeFromWriting(opts: {
  pack: StoryPack;
  writing_text: string;
  instruction?: string;
  signal?: AbortSignal;
}): Promise<StoryPack> {
  const pack = structuredClone(opts.pack) as StoryPack;
  const episodeId = nextEpisodeId(pack);
  const frozenChars = pack.characters.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    identity_lock: c.identity_lock,
  }));
  const frozenEnvs = pack.environments.map((e) => ({
    id: e.id,
    name: e.name,
    scene_card: e.scene_card,
  }));
  const frozenProps = (pack.props || []).map((p) => ({
    id: p.id,
    name: p.name,
    clue_lock: p.clue_lock,
  }));

  const system = `你是漫剧分镜编剧。在已有故事宇宙上追加下一集。输出严格 JSON：
{
  "episode": { "episode_id","title","summary","beats":[{"beat_id","scene_id","summary","emotion"}] },
  "new_characters": [],
  "new_environments": [],
  "new_props": [],
  "new_shots": [{ "shot_id","episode_id","scene_id","beat_id","environment_id","character_ids","prop_ids","duration","camera":{"shot_size","angle","move"},"action","dialogue","emotion","plan_path":"video_ref","still_approved":true,"needs_lipsync":false }],
  "logline": "可选更新",
  "synopsis_patch": "本集追加梗概段落"
}
硬规则：
1. episode_id 必须是 ${episodeId}；shot_id 形如 ${episodeId}_S01_SH01…
2. 禁止修改已有角色 identity_lock；已有角色只能引用其 id
3. 新角色才可出现在 new_characters，且须写完整 identity_lock
4. 优先复用已有 environments / props；新场景/道具才进 new_*
5. 3–6 个镜头；横屏；action 只写动作运镜情绪，不改五官发型服装
6. 道具可空数组`;

  const delta = await chatJson<ExpandDelta>({
    system,
    user: {
      story_id: pack.story_id,
      title: pack.title,
      style_lock: pack.style_lock,
      existing_logline: (pack.script as { logline?: string }).logline,
      existing_synopsis: (pack.script as { synopsis?: string }).synopsis,
      frozen_characters: frozenChars,
      frozen_environments: frozenEnvs,
      frozen_props: frozenProps,
      writing_text: opts.writing_text,
      instruction: opts.instruction || "",
      next_episode_id: episodeId,
    },
    temperature: 0.45,
    signal: opts.signal,
  });

  const script = { ...(pack.script || {}) } as {
    logline?: string;
    synopsis?: string;
    theme?: string;
    episodes?: Array<Record<string, unknown>>;
  };
  if (delta.logline) script.logline = delta.logline;
  if (delta.synopsis_patch) {
    script.synopsis = [script.synopsis || "", delta.synopsis_patch].filter(Boolean).join("\n\n");
  }
  script.episodes = [...(script.episodes || [])];
  if (delta.episode) {
    delta.episode.episode_id = episodeId;
    script.episodes.push(delta.episode);
  }
  pack.script = script;

  const charIds = new Set(pack.characters.map((c) => c.id));
  for (const c of delta.new_characters || []) {
    if (!c?.id || charIds.has(c.id)) continue;
    pack.characters.push({
      ...c,
      approved: c.approved !== false,
      ref_images: c.ref_images || {},
    });
    charIds.add(c.id);
  }

  const envIds = new Set(pack.environments.map((e) => e.id));
  for (const e of delta.new_environments || []) {
    if (!e?.id || envIds.has(e.id)) continue;
    pack.environments.push({ ...e, ref_images: e.ref_images || {} });
    envIds.add(e.id);
  }

  pack.props = pack.props || [];
  const propIds = new Set(pack.props.map((p) => p.id));
  for (const p of delta.new_props || []) {
    if (!p?.id || propIds.has(p.id)) continue;
    pack.props.push({ ...p, ref_images: p.ref_images || {} });
    propIds.add(p.id);
  }

  const shotIds = new Set(pack.shots.map((s) => s.shot_id));
  let idx = 1;
  for (const sh of delta.new_shots || []) {
    if (!sh) continue;
    let sid = sh.shot_id || `${episodeId}_S01_SH${String(idx).padStart(2, "0")}`;
    if (!sid.startsWith(episodeId)) sid = `${episodeId}_S01_SH${String(idx).padStart(2, "0")}`;
    while (shotIds.has(sid)) {
      idx += 1;
      sid = `${episodeId}_S01_SH${String(idx).padStart(2, "0")}`;
    }
    const shot: StoryShot = {
      ...sh,
      shot_id: sid,
      episode_id: episodeId,
      character_ids: (sh.character_ids || []).filter((id) => charIds.has(id)),
      prop_ids: (sh.prop_ids || []).filter((id) => propIds.has(id)),
      environment_id: envIds.has(sh.environment_id) ? sh.environment_id : pack.environments[0]?.id,
      plan_path: sh.plan_path || "video_ref",
      still_approved: sh.still_approved !== false,
      duration: sh.duration || 5,
    };
    if (!shot.environment_id) throw new Error("拆镜失败：无可用环境");
    pack.shots.push(shot);
    shotIds.add(sid);
    idx += 1;
  }

  return pack;
}
