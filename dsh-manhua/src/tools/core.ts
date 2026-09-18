import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import {
  keysSet,
  keysSetSettings,
  keysStatus,
  keysUnset,
} from "../keys.js";
import {
  getCharacter,
  getEnvironment,
  getProp,
  getShot,
  listStyleLocks,
  loadStory,
  loadStyleLock,
  saveStory,
  withLocks,
  type StoryPack,
} from "../story.js";
import { assertShotReady, checkChapterReady, checkShotReady } from "../production/gate.js";
import {
  autoBridgeChapter,
  buildChapterPlan,
  resolvePlanPath,
  resolveSteps,
  setShotPlan,
  type PlanPath,
} from "../production/plan.js";
import { compileH3PromptSections } from "../production/prompt.js";
import { shouldSkipExisting, withRetry } from "../production/retry.js";
import {
  listShotVideoFiles,
  loadManifest,
  registerStillVersion,
  registerVideoVersion,
  resolveSelectedVideo,
  saveManifest,
  selectVersion,
} from "../production/versions.js";
import {
  buildTimelineManifest,
  cropGridCell,
  exportJianyingDraft,
  exportStoryZip,
  importStoryZip,
  muxChapterDub,
  probeDurationSec,
  writeSrtBesideTimeline,
} from "../production/export_bundle.js";
import { RUNS_DIR, ensureDir } from "../paths.js";
import {
  getProviders,
  providerBridge,
  providerGenerateSheet,
  providerGenerateStill,
  providerLipsync,
  providerTts,
  providerVideoRef,
  setProviders,
} from "../providers/registry.js";
import { expandStoryFromSynopsis, expandNextEpisodeFromWriting, generateWritingText } from "../providers/llm.js";
import {
  adoptDraft,
  appendDraft,
  emptyWriting,
  getActiveDraft,
  loadWriting,
  saveWriting,
} from "../production/writing.js";
import type { WritingKind } from "../production/writing.js";
import { probeProvider } from "../providers/probe.js";
import { fail, info, ok, step, warn } from "../zh-log.js";

export type ToolResult = Record<string, unknown>;

/** 统一章节寻址：工具 args 透传可选 chapter_id，缺省为默认章。 */
function loadChapter(args: { story_id: string; chapter_id?: string }): { pack: StoryPack; path: string } {
  return loadStory(args.story_id, (args as { chapter_id?: string }).chapter_id);
}

function textRender(_args: unknown, value: ToolResult) {
  return [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];
}

function assetDirs(pack: StoryPack) {
  const base = path.join(RUNS_DIR, pack.story_id, pack.chapter_id);
  return {
    base,
    assets: path.join(base, "01_assets"),
    audio: path.join(base, "02_audio"),
    video: path.join(base, "03_video"),
    exportDir: path.join(base, "04_export"),
  };
}

function isHttp(url?: string | null): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

export function assembleRefs(pack: StoryPack, shotId: string): string[] {
  const shot = getShot(pack, shotId);
  if (shot.ref_images?.length) return shot.ref_images.filter(Boolean);
  const urls: string[] = [];
  for (const cid of shot.character_ids) {
    const ch = getCharacter(pack, cid);
    for (const key of ["sheet", "face", "full", "costume"] as const) {
      const u = ch.ref_images?.[key];
      if (isHttp(u)) urls.push(u!);
    }
  }
  for (const pid of shot.prop_ids || []) {
    const prop = getProp(pack, pid);
    const sheet = prop.ref_images?.sheet;
    if (isHttp(sheet)) urls.push(sheet!);
  }
  if (isHttp(shot.still_url)) urls.push(shot.still_url!);
  const env = getEnvironment(pack, shot.environment_id);
  for (const key of ["establishing", "detail"] as const) {
    const u = env.ref_images?.[key];
    if (isHttp(u)) urls.push(u!);
  }
  return [...new Set(urls)];
}

export function compileVideoPrompt(pack: StoryPack, shotId: string): string {
  const preview = compileH3PromptSections(pack, shotId);
  return preview.assembled;
}

/** keys.status */
export async function keysStatusTool(): Promise<ToolResult> {
  return keysStatus();
}

export async function keysSetTool(args: { provider: string; value: string }): Promise<ToolResult> {
  return keysSet(args.provider, args.value);
}

export async function keysUnsetTool(args: { provider: string }): Promise<ToolResult> {
  return keysUnset(args.provider);
}

export async function keysProbeTool(args: { provider: string }): Promise<ToolResult> {
  return probeProvider(args.provider);
}

export async function keysSetSettingsTool(args: {
  autodl_base_url?: string;
  openai_base_url?: string;
  gemini_base_url?: string;
  openai_image_model?: string;
  openai_chat_model?: string;
  gemini_image_model?: string;
  default_resolution?: string;
  video_workflow_id?: string;
  public_asset_base_url?: string;
}): Promise<ToolResult> {
  return keysSetSettings({
    autodlBaseUrl: args.autodl_base_url,
    openaiBaseUrl: args.openai_base_url,
    geminiBaseUrl: args.gemini_base_url,
    openaiImageModel: args.openai_image_model,
    openaiChatModel: args.openai_chat_model,
    geminiImageModel: args.gemini_image_model,
    defaultResolution: args.default_resolution,
    videoWorkflowId: args.video_workflow_id,
    publicAssetBaseUrl: args.public_asset_base_url,
  });
}

export async function storyLoad(args: { story_id: string; chapter_id?: string }): Promise<ToolResult> {
  const { pack, path: filePath } = loadChapter(args);
  return {
    ok: true,
    story_id: pack.story_id,
    chapter_id: pack.chapter_id,
    title: pack.title,
    path: filePath,
    style_lock: pack.style_lock,
    characters: pack.characters.map((c) => ({ id: c.id, name: c.name, approved: c.approved !== false })),
    environments: pack.environments.map((e) => ({ id: e.id, name: e.name })),
    props: (pack.props || []).map((p) => ({ id: p.id, name: p.name })),
    shots: pack.shots.map((s) => s.shot_id),
    plan: buildChapterPlan(pack),
    steps: resolveSteps(pack),
    logline: (pack.script as { logline?: string }).logline,
  };
}

export async function characterSheetGpt(
  args: { story_id: string; chapter_id?: string; character_id: string; size?: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { pack, path: filePath } = loadChapter(args);
  const ch = getCharacter(pack, args.character_id);
  const style = loadStyleLock(pack.style_lock);
  const prompt = withLocks(ch.sheet_prompt || `角色设定三视图。${ch.identity_lock}`, style, ch.identity_lock);
  const dirs = assetDirs(pack);
  const dest = path.join(dirs.assets, `${ch.id}_sheet.png`);
  const img = await withRetry(
    () => providerGenerateSheet({ prompt, destPath: dest, size: args.size, signal }),
    { label: `sheet:${ch.id}` },
  );
  ch.ref_images = { ...(ch.ref_images || {}) };
  if (img.url) {
    ch.ref_images.sheet = img.url;
  } else if (ch.ref_images.sheet && !/^https?:\/\//i.test(ch.ref_images.sheet)) {
    // 禁止把本地路径写进公网槽，否则齐套门闸误判且 AutoDL 无法拉取
    delete ch.ref_images.sheet;
  }
  ch.approved = true;
  saveStory(pack, filePath);
  return {
    ok: true,
    story_id: pack.story_id,
    character_id: ch.id,
    local_path: img.localPath,
    url: img.url || null,
    provider: img.provider,
    model: img.model,
    note: img.url
      ? "已写回 characters[].ref_images.sheet"
      : "仅本地落盘；请配置 PUBLIC_ASSET_BASE_URL 或上传公网 URL 后才能成片",
  };
}

export async function shotStillGemini(
  args: { story_id: string; chapter_id?: string; shot_id: string; as_grid?: boolean },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { pack, path: filePath } = loadChapter(args);
  const shot = getShot(pack, args.shot_id);
  const env = getEnvironment(pack, shot.environment_id);
  const ch = getCharacter(pack, shot.character_ids[0]);
  const style = loadStyleLock(pack.style_lock);
  const gridHint = args.as_grid
    ? "输出 3x3 九宫格分镜候选，同一人物同一画风，九格构图各异，横屏。"
    : "横屏分镜静帧。";
  const stillBody =
    shot.still_prompt ||
    `${env.scene_card}。${shot.action}。情绪：${shot.emotion || ""}。${gridHint}`;
  const prompt = withLocks(stillBody, style, ch.identity_lock);
  const dirs = assetDirs(pack);
  const dest = path.join(dirs.assets, `${shot.shot_id}_${args.as_grid ? "grid" : "still"}.png`);
  const img = await withRetry(
    () => providerGenerateStill({ prompt, destPath: dest, signal }),
    { label: `still:${shot.shot_id}` },
  );
  const registered = registerStillVersion(pack, dirs, shot.shot_id, img.localPath);
  if (args.as_grid) {
    const manifest = loadManifest(pack, dirs);
    const entry = manifest.shots[shot.shot_id] || {
      still_versions: [],
      selected_still: null,
      video_versions: [],
      selected_video: null,
    };
    manifest.shots[shot.shot_id] = entry;
    entry.grid_path = registered.dest;
    saveManifest(dirs, manifest);
  }
  if (img.url) shot.still_url = img.url;
  else if (shot.still_url && !/^https?:\/\//i.test(shot.still_url)) {
    delete shot.still_url;
  }
  if (args.as_grid) shot.plan_path = "grid";
  shot.still_approved = true;
  saveStory(pack, filePath);
  return {
    ok: true,
    story_id: pack.story_id,
    shot_id: shot.shot_id,
    local_path: img.localPath,
    version: registered.version,
    version_path: registered.dest,
    url: img.url || null,
    as_grid: !!args.as_grid,
    provider: img.provider,
    model: img.model,
    note: img.url
      ? "已写回 shots[].still_url"
      : "仅本地落盘；请配置 PUBLIC_ASSET_BASE_URL 或上传公网 URL 后才能成片",
  };
}

export async function selectGridCellTool(args: {
  story_id: string;
  chapter_id?: string;
  shot_id: string;
  cell: number;
}): Promise<ToolResult> {
  const { pack, path: filePath } = loadChapter(args);
  const shot = getShot(pack, args.shot_id);
  const dirs = assetDirs(pack);
  const manifest = loadManifest(pack, dirs);
  const gridPath =
    manifest.shots[args.shot_id]?.grid_path ||
    path.join(dirs.assets, `${args.shot_id}_grid.png`);
  if (!fs.existsSync(gridPath)) throw new Error("请先生成九宫格静帧");
  const dest = path.join(dirs.assets, `${args.shot_id}_cell${args.cell}.png`);
  cropGridCell(gridPath, args.cell, dest);
  const registered = registerStillVersion(pack, dirs, args.shot_id, dest);
  shot.grid_cell = args.cell;
  shot.still_url = registered.dest;
  shot.still_approved = true;
  saveStory(pack, filePath);
  return {
    ok: true,
    shot_id: args.shot_id,
    cell: args.cell,
    still_path: registered.dest,
    version: registered.version,
    note: "已裁切并写回 still；若需公网 URL 请配置 CDN 或手动上传",
  };
}

export async function autodlVideoRef(
  args: {
    story_id: string;
    chapter_id?: string;
    shot_id: string;
    workflow_id?: string;
    duration?: number;
    resolution?: string;
    force?: boolean;
    skip_gate?: boolean;
  },
  signal?: AbortSignal,
): Promise<ToolResult> {
  step("成片工具", "准备多参考成片", { story_id: args.story_id, shot_id: args.shot_id });
  const { pack, path: filePath } = loadChapter(args);
  if (!args.skip_gate) assertShotReady(pack, args.shot_id);
  const dirs = assetDirs(pack);
  const existing = resolveSelectedVideo(pack, dirs, args.shot_id);
  if (shouldSkipExisting(existing, args.force)) {
    ok("成片工具", "已有成片，跳过", { shot_id: args.shot_id, file: existing });
    return {
      ok: true,
      skipped: true,
      story_id: pack.story_id,
      shot_id: args.shot_id,
      file: existing,
      note: "已有成片，跳过（传 force=true 可重跑）",
    };
  }

  const refs = assembleRefs(pack, args.shot_id);
  if (!refs.length) {
    fail("成片工具", "缺少公网参考图", { shot_id: args.shot_id });
    throw new Error(`${args.shot_id}: 缺少公网参考图`);
  }
  const prompt = compileVideoPrompt(pack, args.shot_id);
  const tempDir = path.join(dirs.video, "_tmp");
  const result = await withRetry(
    () =>
      providerVideoRef({
        storyId: pack.story_id,
        shotId: args.shot_id,
        prompt,
        refImages: refs,
        duration: args.duration,
        resolution: args.resolution || pack.resolution,
        workflowId: args.workflow_id,
        outDir: tempDir,
        signal,
      }),
    { label: `video:${args.shot_id}` },
  );
  const primary = result.files.find((f) => f.toLowerCase().endsWith(".mp4")) || result.files[0];
  let versionInfo = null;
  if (primary) {
    versionInfo = registerVideoVersion(pack, dirs, args.shot_id, primary);
  }
  const shot = getShot(pack, args.shot_id);
  shot.video_approved = true;
  saveStory(pack, filePath);
  ok("成片工具", "多参考成片完成", { shot_id: args.shot_id, version: versionInfo?.version });
  return {
    ok: true,
    story_id: pack.story_id,
    shot_id: args.shot_id,
    task_id: result.taskId,
    status: result.status,
    files: result.files,
    version: versionInfo?.version,
    version_file: versionInfo?.dest,
    workflow_id: result.workflowId,
    ref_images_used: refs,
  };
}

export async function runBridgeShot(
  args: { story_id: string; chapter_id?: string; shot_id: string; force?: boolean },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { pack } = loadChapter(args);
  const shot = getShot(pack, args.shot_id);
  if (!shot.bridge_from) throw new Error(`${args.shot_id} 缺少 bridge_from`);
  const dirs = assetDirs(pack);
  const prevVideo = resolveSelectedVideo(pack, dirs, String(shot.bridge_from));
  const curStill = shot.still_url;
  // Prefer explicit first/last frame URLs; otherwise require public still as last, and previous still as first
  const prevShot = getShot(pack, String(shot.bridge_from));
  const first = shot.first_frame || prevShot.still_url;
  const last = shot.last_frame || curStill;
  if (!isHttp(first) || !isHttp(last)) {
    throw new Error(`${args.shot_id} bridge 需要公网 first_frame/last_frame（或相邻镜 still_url）`);
  }
  const prompt = compileVideoPrompt(pack, args.shot_id);
  const result = await withRetry(
    () =>
      providerBridge({
        storyId: pack.story_id,
        shotId: args.shot_id,
        prompt,
        firstFrame: first!,
        lastFrame: last!,
        duration: shot.duration,
        resolution: pack.resolution,
        outDir: path.join(dirs.video, "_tmp"),
        signal,
      }),
    { label: `bridge:${args.shot_id}` },
  );
  const primary = result.files.find((f) => f.toLowerCase().endsWith(".mp4")) || result.files[0];
  const versionInfo = primary ? registerVideoVersion(pack, dirs, args.shot_id, primary) : null;
  return {
    ok: true,
    shot_id: args.shot_id,
    bridge_from: shot.bridge_from,
    prev_video: prevVideo,
    version: versionInfo?.version,
    files: result.files,
    task_id: result.taskId,
  };
}

export async function runLipsyncShot(
  args: { story_id: string; chapter_id?: string; shot_id: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { pack, path: filePath } = loadChapter(args);
  const shot = getShot(pack, args.shot_id);
  const dirs = assetDirs(pack);
  let audioUrl = (shot.ref_audios || []).find(isHttp);
  if (!audioUrl && shot.dialogue) {
    const tts = await shotTts({ story_id: args.story_id, shot_id: args.shot_id }, signal);
    audioUrl = typeof tts.url === "string" ? tts.url : undefined;
    if (!audioUrl) throw new Error("TTS 未得到公网 URL，无法 lipsync");
  }
  if (!isHttp(shot.still_url) || !audioUrl) {
    throw new Error(`${args.shot_id} lipsync 需要公网 still_url + audio`);
  }
  const prompt = compileVideoPrompt(pack, args.shot_id);
  const result = await withRetry(
    () =>
      providerLipsync({
        storyId: pack.story_id,
        shotId: args.shot_id,
        prompt,
        imageUrl: shot.still_url!,
        audioUrl,
        duration: shot.duration,
        resolution: pack.resolution,
        outDir: path.join(dirs.video, "_tmp"),
        signal,
      }),
    { label: `lipsync:${args.shot_id}` },
  );
  const primary = result.files.find((f) => f.toLowerCase().endsWith(".mp4")) || result.files[0];
  const versionInfo = primary ? registerVideoVersion(pack, dirs, args.shot_id, primary) : null;
  shot.needs_lipsync = true;
  saveStory(pack, filePath);
  return {
    ok: true,
    shot_id: args.shot_id,
    version: versionInfo?.version,
    files: result.files,
    task_id: result.taskId,
  };
}

/** TTS 前剥离「角色：」标签（单音色兜底场景用）。 */
export function cleanDialogueForTts(dialogue: string): string {
  return dialogue
    .split(/[\n。！？!?；;]+/)
    .map((seg) => seg.replace(/^\s*[一-龥A-Za-z]{1,8}[:：]\s*/, "").trim())
    .filter(Boolean)
    .join("。");
}

export type DialogueSegment = { speaker: string; text: string };

/** 按「角色：」标签拆句；无标签文本归属上一角色（开头无标签则 speaker 为空）。 */
export function parseDialogueSegments(dialogue: string): DialogueSegment[] {
  const segs: DialogueSegment[] = [];
  const re = /([一-龥A-Za-z·]{1,8})[:：]/g;
  let speaker = "";
  let lastIndex = 0;
  const push = (end: number) => {
    const text = dialogue.slice(lastIndex, end).trim();
    if (text) segs.push({ speaker, text });
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(dialogue))) {
    push(m.index);
    speaker = m[1];
    lastIndex = m.index + m[0].length;
  }
  push(dialogue.length);
  return segs;
}

const VOICE_FEMALE = /(母|妈|奶|婆|姑|姨|姐|妹|女|婶|嫂)/;
const VOICE_CHILD = /(孩|娃|儿童|少年|小孩|平凡)/;
const VOICE_MALE = /(父|爸|爷|叔|伯|哥|兄|弟|男|公)/;

function loadVoiceMap(): Record<string, string> {
  try {
    const p = path.join(loadConfig().repoRoot, "config", "tts_voices.json");
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;
      delete raw["说明"];
      return raw;
    }
  } catch {
    /* 配置缺失走启发式 */
  }
  return {};
}

/** 角色 → edge-tts 音色：配置表优先，其次启发式。 */
export function voiceForSpeaker(speaker: string, map: Record<string, string> = loadVoiceMap()): string {
  if (speaker && map[speaker]) return map[speaker];
  if (speaker && VOICE_CHILD.test(speaker)) return "zh-CN-YunxiaNeural";
  if (speaker && VOICE_FEMALE.test(speaker)) return "zh-CN-XiaoxiaoNeural";
  if (speaker && VOICE_MALE.test(speaker)) return "zh-CN-YunjianNeural";
  return map._default || process.env.EDGE_TTS_VOICE || "zh-CN-YunxiNeural";
}

function findFfmpegBin(): string {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], {
    encoding: "utf8",
  });
  const line = (which.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (line && fs.existsSync(line)) return line;
  const guess = "C:\\ffmpeg-2026-06-29-git-de6bcf5c05-full_build\\bin\\ffmpeg.exe";
  if (fs.existsSync(guess)) return guess;
  throw new Error("多角色配音拼接需要 ffmpeg");
}

/** 与 providers 一致的公网 URL 换算（隧道/静态服务场景）。 */
function publicUrlForLocal(localPath: string): string | undefined {
  const cfg = loadConfig();
  if (!cfg.publicAssetBaseUrl) return undefined;
  const rel = path.relative(cfg.repoRoot, localPath).replace(/\\/g, "/");
  return `${cfg.publicAssetBaseUrl}/${rel}`;
}

/** 多段配音按顺序拼接（段间 0.35s 静音），输出单个 mp3。 */
function concatAudioParts(parts: string[], dest: string, workDir: string): string {
  if (parts.length === 1) {
    fs.copyFileSync(parts[0], dest);
    return dest;
  }
  const ffmpeg = findFfmpegBin();
  ensureDir(workDir);
  const silence = path.join(workDir, "silence.mp3");
  if (!fs.existsSync(silence)) {
    const r = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "0.35", silence], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`静音垫生成失败: ${r.stderr || r.stdout}`);
  }
  const ordered: string[] = [];
  parts.forEach((p, i) => {
    ordered.push(p);
    if (i < parts.length - 1) ordered.push(silence);
  });
  const inputs = ordered.flatMap((p) => ["-i", p]);
  const labels = ordered.map((_, i) => `[${i}:a]`).join("");
  const r = spawnSync(
    ffmpeg,
    ["-y", ...inputs, "-filter_complex", `${labels}concat=n=${ordered.length}:v=0:a=1[out]`, "-map", "[out]", "-c:a", "libmp3lame", dest],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !fs.existsSync(dest)) {
    throw new Error(`多角色配音拼接失败: ${r.stderr || r.stdout}`);
  }
  return dest;
}

export async function shotTts(
  args: { story_id: string; chapter_id?: string; shot_id: string; voice?: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { pack, path: filePath } = loadChapter(args);
  const shot = getShot(pack, args.shot_id);
  if (!shot.dialogue) throw new Error(`${args.shot_id} 无 dialogue`);
  const dirs = assetDirs(pack);
  ensureDir(dirs.audio);
  const dest = path.join(dirs.audio, `${args.shot_id}.mp3`);

  const segments = parseDialogueSegments(String(shot.dialogue));
  if (!segments.length) throw new Error(`${args.shot_id} dialogue 清洗后为空`);
  const voiceMap = loadVoiceMap();

  let provider = "";
  let tts: { localPath: string; url?: string; provider: string; model: string };
  if (args.voice || segments.length === 1) {
    // 显式单音色，或单角色镜头：一次合成
    const text = args.voice ? cleanDialogueForTts(String(shot.dialogue)) : segments[0].text;
    tts = await withRetry(
      () => providerTts({ text, destPath: dest, voice: args.voice, signal }),
      { label: `tts:${args.shot_id}` },
    );
    provider = tts.provider;
  } else {
    // 多角色：逐段分音色合成后拼接
    const segDir = path.join(dirs.audio, `${args.shot_id}_segments`);
    ensureDir(segDir);
    const parts: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const voice = voiceForSpeaker(seg.speaker, voiceMap);
      step("TTS", "分角色合成", { shot_id: args.shot_id, seg: i + 1, speaker: seg.speaker || "(叙述)", voice });
      let part;
      try {
        part = await providerTts({ text: seg.text, destPath: path.join(segDir, `seg${i + 1}.mp3`), voice, signal });
      } catch (e) {
        warn("TTS", "该音色失败，回退默认音色", { voice, error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
        part = await providerTts({ text: seg.text, destPath: path.join(segDir, `seg${i + 1}.mp3`), signal });
      }
      provider = part.provider;
      parts.push(part.localPath);
    }
    concatAudioParts(parts, dest, segDir);
    tts = { localPath: dest, url: publicUrlForLocal(dest), provider: provider || "edge-tts", model: "multi-voice" };
  }

  shot.ref_audios = [tts.url || tts.localPath];
  shot.ref_audios = [tts.url || tts.localPath];
  saveStory(pack, filePath);
  return {
    ok: true,
    shot_id: args.shot_id,
    local_path: tts.localPath,
    url: tts.url || null,
    provider: tts.provider,
  };
}

export async function runChapterPipeline(
  args: { story_id: string; chapter_id?: string; force?: boolean; shot_ids?: string[] },
  signal?: AbortSignal,
): Promise<ToolResult> {
  step("章节流水线", "开始章节成片", { story_id: args.story_id });
  const { pack, path: filePath } = loadChapter(args);
  autoBridgeChapter(pack, filePath);
  const steps = resolveSteps(pack);
  const targets = args.shot_ids?.length
    ? pack.shots.filter((s) => args.shot_ids!.includes(s.shot_id))
    : pack.shots;
  info("章节流水线", "镜头计划已就绪", { shots: targets.length, steps: steps.join(",") });
  const results: ToolResult[] = [];
  for (const shot of targets) {
    const plan = resolvePlanPath(shot);
    step("章节流水线", "处理镜头", { shot_id: shot.shot_id, plan });
    if (steps.includes("video") && (plan === "video_ref" || plan === "grid")) {
      results.push(await autodlVideoRef({ story_id: args.story_id, chapter_id: args.chapter_id, shot_id: shot.shot_id, force: args.force }, signal));
    }
    if (steps.includes("bridge") && (plan === "bridge" || shot.bridge_from)) {
      results.push(await runBridgeShot({ story_id: args.story_id, chapter_id: args.chapter_id, shot_id: shot.shot_id, force: args.force }, signal));
    }
    if (steps.includes("lipsync") && (plan === "lipsync" || shot.needs_lipsync)) {
      results.push(await runLipsyncShot({ story_id: args.story_id, chapter_id: args.chapter_id, shot_id: shot.shot_id }, signal));
    }
  }
  ok("章节流水线", "章节成片流程结束", { story_id: args.story_id, count: results.length });
  return { ok: true, story_id: args.story_id, steps, count: results.length, results };
}

export async function gateCheckTool(args: { story_id: string; chapter_id?: string; shot_id?: string }): Promise<ToolResult> {
  step("齐套门闸", "开始检查", { story_id: args.story_id, shot_id: args.shot_id || "(整章)" });
  const { pack } = loadChapter(args);
  if (args.shot_id) {
    const issues = checkShotReady(pack, args.shot_id);
    const ready = !issues.some((i) => i.level === "error");
    if (ready) ok("齐套门闸", "单镜齐套通过", { shot_id: args.shot_id });
    else warn("齐套门闸", "单镜未齐套", { shot_id: args.shot_id, issues: issues.length });
    return { ok: ready, shot_id: args.shot_id, issues };
  }
  const chapter = checkChapterReady(pack);
  if (chapter.ok) ok("齐套门闸", "整章齐套通过", { story_id: args.story_id });
  else warn("齐套门闸", "整章未齐套", { story_id: args.story_id });
  return { ...chapter, plan: buildChapterPlan(pack) };
}

export async function planUpdateTool(args: {
  story_id: string;
  chapter_id?: string;
  shot_id: string;
  plan_path?: PlanPath;
  bridge_from?: string | null;
  needs_lipsync?: boolean;
  plan_notes?: string;
}): Promise<ToolResult> {
  const { pack, path: filePath } = loadChapter(args);
  setShotPlan(pack, args.shot_id, args, filePath);
  return { ok: true, plan: buildChapterPlan(pack) };
}

export async function autoBridgeTool(args: { story_id: string; chapter_id?: string }): Promise<ToolResult> {
  const { pack, path: filePath } = loadChapter(args);
  const { updated } = autoBridgeChapter(pack, filePath);
  return { ok: true, updated, plan: buildChapterPlan(pack) };
}

export async function approveTool(args: {
  story_id: string;
  chapter_id?: string;
  kind: "character" | "still" | "video";
  id: string;
  approved: boolean;
}): Promise<ToolResult> {
  const { pack, path: filePath } = loadChapter(args);
  if (args.kind === "character") {
    getCharacter(pack, args.id).approved = args.approved;
  } else {
    const shot = getShot(pack, args.id);
    if (args.kind === "still") shot.still_approved = args.approved;
    else shot.video_approved = args.approved;
  }
  saveStory(pack, filePath);
  return { ok: true, kind: args.kind, id: args.id, approved: args.approved };
}

export async function selectVersionTool(args: {
  story_id: string;
  chapter_id?: string;
  shot_id: string;
  kind: "still" | "video";
  version: string;
}): Promise<ToolResult> {
  const { pack } = loadChapter(args);
  const dirs = assetDirs(pack);
  const manifest = selectVersion(pack, dirs, args.shot_id, args.kind, args.version);
  return { ok: true, manifest: manifest.shots[args.shot_id] };
}

export async function promptPreviewTool(args: { story_id: string; chapter_id?: string; shot_id: string }): Promise<ToolResult> {
  step("提示词预览", "编译 H3 分节提示词", { story_id: args.story_id, shot_id: args.shot_id });
  const { pack } = loadChapter(args);
  const preview = compileH3PromptSections(pack, args.shot_id);
  ok("提示词预览", "编译完成", { shot_id: args.shot_id });
  return { ok: true, ...preview };
}

export async function zipExportTool(args: { story_id: string; chapter_id?: string }): Promise<ToolResult> {
  step("工程包", "导出 ZIP", { story_id: args.story_id });
  const result = exportStoryZip(args.story_id);
  ok("工程包", "导出完成", { zip_path: result.zip_path });
  return { ok: true, ...result };
}

export async function zipImportTool(args: { zip_path: string }): Promise<ToolResult> {
  return { ok: true, ...importStoryZip(args.zip_path) };
}

function resolveShotAudioLocal(dirs: ReturnType<typeof assetDirs>, shotId: string): string | null {
  for (const ext of [".mp3", ".wav", ".m4a"]) {
    const p = path.join(dirs.audio, `${shotId}${ext}`);
    if (fs.existsSync(p) && fs.statSync(p).size >= 32) return p;
  }
  return null;
}

export async function timelineExportTool(args: { story_id: string; chapter_id?: string }): Promise<ToolResult> {
  step("时间线", "正在导出时间线与字幕", { story_id: args.story_id });
  const { pack } = loadChapter(args);
  const dirs = assetDirs(pack);
  const clips = pack.shots
    .map((sh) => {
      const file = resolveSelectedVideo(pack, dirs, sh.shot_id);
      if (!file) return null;
      const audio = resolveShotAudioLocal(dirs, sh.shot_id);
      const duration = probeDurationSec(file, sh.duration || 5);
      return {
        shot_id: sh.shot_id,
        file,
        duration,
        dialogue: sh.dialogue,
        audio_file: audio,
        audio_duration_sec: audio ? probeDurationSec(audio, duration) : undefined,
      };
    })
    .filter(Boolean) as Array<{
    shot_id: string;
    file: string;
    duration: number;
    dialogue?: string | null;
    audio_file?: string | null;
    audio_duration_sec?: number;
  }>;
  const timeline = buildTimelineManifest(pack, clips);
  ensureDir(dirs.exportDir);
  const out = path.join(dirs.exportDir, `${pack.chapter_id}_timeline.json`);
  fs.writeFileSync(out, JSON.stringify(timeline, null, 2), "utf8");
  const srtFile = writeSrtBesideTimeline(timeline, out);
  ok("时间线", "已写出 timeline + SRT", { timeline_file: out, srt_file: srtFile, clips: clips.length });
  return { ok: true, timeline_file: out, srt_file: srtFile, timeline };
}

/** 全章对白 TTS（有 dialogue 的镜头） */
export async function chapterTtsTool(
  args: { story_id: string; chapter_id?: string; force?: boolean },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { pack } = loadChapter(args);
  const dirs = assetDirs(pack);
  step("全章配音", "正在为有对白镜头生成 TTS", { story_id: args.story_id });
  const results: ToolResult[] = [];
  const errors: Array<{ shot_id: string; error: string }> = [];
  for (const shot of pack.shots) {
    if (!shot.dialogue) continue;
    const existing = resolveShotAudioLocal(dirs, shot.shot_id);
    if (existing && !args.force) {
      results.push({ ok: true, skipped: true, shot_id: shot.shot_id, local_path: existing });
      continue;
    }
    try {
      results.push(await shotTts({ story_id: args.story_id, shot_id: shot.shot_id }, signal));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fail("全章配音", `镜头 ${shot.shot_id} 失败，继续下一镜`, { error: message.slice(0, 200) });
      errors.push({ shot_id: shot.shot_id, error: message });
    }
  }
  ok("全章配音", "TTS 批次结束", { ok_count: results.length, fail_count: errors.length });
  return {
    ok: errors.length === 0,
    story_id: args.story_id,
    count: results.length,
    results,
    errors,
  };
}

/**
 * 交付包：可选全章 TTS → 时间线/SRT →（若已有成片）叠配音轨 → 可选剪映草稿。
 * 默认不重跑 lipsync（贵且慢）；先解决「无声无字幕」交付。
 */
export async function chapterDeliverTool(
  args: {
    story_id: string;
    chapter_id?: string;
    force_tts?: boolean;
    skip_tts?: boolean;
    skip_mux?: boolean;
    jianying?: boolean;
    jianying_draft_dir?: string;
  },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const storyId = args.story_id;
  step("章节交付", "开始补配音/字幕交付", { story_id: storyId });
  const { pack } = loadChapter(args);
  const dirs = assetDirs(pack);

  let ttsResult: ToolResult | null = null;
  if (!args.skip_tts) {
    ttsResult = await chapterTtsTool({ story_id: storyId, force: args.force_tts }, signal);
  }

  const timelineResult = await timelineExportTool({ story_id: storyId });
  const timelineFile = String(timelineResult.timeline_file);
  const srtFile = String(timelineResult.srt_file);
  const timeline = timelineResult.timeline as {
    clips: Array<{ duration_sec: number; audio_file?: string | null; dialogue?: string | null }>;
  };

  const chapterCut = path.join(dirs.exportDir, `${pack.chapter_id}_chapter_cut.mp4`);
  let dubFile: string | null = null;
  let muxNote: string | null = null;
  if (!args.skip_mux && fs.existsSync(chapterCut)) {
    dubFile = path.join(dirs.exportDir, `${pack.chapter_id}_chapter_dub.mp4`);
    const muxed = muxChapterDub({
      videoFile: chapterCut,
      outFile: dubFile,
      clips: timeline.clips,
      srtFile,
    });
    muxNote = muxed.note;
  } else if (!args.skip_mux) {
    warn("章节交付", "尚未有 chapter_cut，跳过叠轨；请先一键出片");
  }

  let jianying: ToolResult | null = null;
  if (args.jianying) {
    try {
      jianying = await jianyingExportTool({
        story_id: storyId,
        draft_dir: args.jianying_draft_dir,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn("章节交付", "剪映草稿失败（配音/字幕已产出）", { error: message.slice(0, 240) });
      jianying = { ok: false, error: message };
    }
  }

  ok("章节交付", "配音/字幕交付完成", {
    srt_file: srtFile,
    dub_file: dubFile,
    jianying: !!jianying?.ok,
  });
  return {
    ok: true,
    story_id: storyId,
    tts: ttsResult,
    timeline_file: timelineFile,
    srt_file: srtFile,
    chapter_cut: fs.existsSync(chapterCut) ? chapterCut : null,
    dub_file: dubFile,
    mux_note: muxNote,
    jianying,
  };
}

export async function jianyingExportTool(args: {
  story_id: string;
  chapter_id?: string;
  draft_dir?: string;
  draft_name?: string;
}): Promise<ToolResult> {
  const timelineResult = await timelineExportTool({ story_id: args.story_id });
  const timelineFile = String(timelineResult.timeline_file);
  const srtFile = String(timelineResult.srt_file);
  const result = exportJianyingDraft({
    timelineFile,
    draftDir: args.draft_dir,
    draftName: args.draft_name,
    srtFile,
  });
  return {
    ok: true,
    draft_path: result.draft_path || null,
    draft_name: result.draft_name || null,
    note: result.note,
    timeline_file: timelineFile,
    srt_file: srtFile,
  };
}

export async function expandStoryTool(args: {
  story_id: string;
  chapter_id?: string;
  logline: string;
  synopsis: string;
  title?: string;
  style_lock?: string;
}): Promise<ToolResult> {
  const pack = await expandStoryFromSynopsis(args);
  const dest = saveStory(pack);
  return { ok: true, path: dest, story_id: pack.story_id, shots: pack.shots.length, note: "草稿已写入，请人工审阅后再生成资产" };
}

function ensureWritingSeeded(storyId: string) {
  let doc = loadWriting(storyId);
  if (doc.source_text.trim()) return doc;
  try {
    const { pack } = loadStory(storyId);
    const script = pack.script as { synopsis?: string; logline?: string };
    doc = emptyWriting(storyId, {
      title: pack.title,
      source_text: script.synopsis || "",
      logline: script.logline || "",
    });
    saveWriting(doc);
  } catch {
    /* story may not exist yet */
  }
  return loadWriting(storyId);
}

export async function writingGetTool(args: { story_id: string; chapter_id?: string }): Promise<ToolResult> {
  const doc = ensureWritingSeeded(args.story_id);
  const active = getActiveDraft(doc);
  return {
    ok: true,
    writing: doc,
    active_draft: active,
    path: writingPathSafe(args.story_id),
  };
}

function writingPathSafe(storyId: string) {
  return `stories/${storyId}/writing.json`;
}

export async function writingSeedTool(args: {
  story_id: string;
  chapter_id?: string;
  source_text: string;
  title?: string;
  logline?: string;
}): Promise<ToolResult> {
  const storyId = args.story_id.trim();
  if (!storyId) throw new Error("story_id 必填");
  const text = (args.source_text || "").trim();
  if (!text) throw new Error("请粘贴主线或小说正文");
  let doc = loadWriting(storyId);
  doc.title = args.title?.trim() || doc.title || storyId;
  doc.logline = args.logline?.trim() || doc.logline || "";
  doc.source_text = text;
  const draft = appendDraft(doc, "seed", text, "导入主线/小说");
  saveWriting(doc);
  return { ok: true, writing: doc, draft, note: "已写入文案账本" };
}

export async function writingGenerateTool(args: {
  story_id: string;
  chapter_id?: string;
  kind: "continue" | "twist" | "revise";
  instruction?: string;
  target_chars?: number;
}): Promise<ToolResult> {
  const doc = ensureWritingSeeded(args.story_id);
  if (!doc.source_text.trim() && args.kind !== "revise") {
    throw new Error("正文为空：请先粘贴主线/小说并保存");
  }
  const gen = await generateWritingText({
    kind: args.kind,
    source_text: doc.source_text || args.instruction || "",
    logline: doc.logline,
    title: doc.title,
    instruction: args.instruction,
    target_chars: args.target_chars,
  });
  if (gen.logline) doc.logline = gen.logline;
  const draft = appendDraft(doc, args.kind as WritingKind, gen.content, args.instruction);
  saveWriting(doc);
  return {
    ok: true,
    writing: doc,
    draft,
    notes: gen.notes,
    note: args.kind === "continue" ? "续写草稿已生成" : args.kind === "twist" ? "反转草稿已生成" : "改写草稿已生成",
  };
}

export async function writingAdoptTool(args: {
  story_id: string;
  chapter_id?: string;
  draft_id?: string;
  mode?: "replace" | "append";
}): Promise<ToolResult> {
  const doc = loadWriting(args.story_id);
  adoptDraft(doc, args.draft_id, args.mode || "replace");
  saveWriting(doc);
  return { ok: true, writing: doc, note: "已采用为正文" };
}

export async function writingApplySynopsisTool(args: {
  story_id: string;
  chapter_id?: string;
  draft_id?: string;
}): Promise<ToolResult> {
  const doc = loadWriting(args.story_id);
  const draft = args.draft_id
    ? doc.drafts.find((d) => d.id === args.draft_id)
    : getActiveDraft(doc);
  const text = (draft?.content || doc.source_text || "").trim();
  if (!text) throw new Error("没有可写入的文案");
  const { pack, path: filePath } = loadChapter(args);
  const script = { ...(pack.script || {}) } as { logline?: string; synopsis?: string };
  script.synopsis = text;
  if (doc.logline) script.logline = doc.logline;
  pack.script = script;
  if (doc.title) pack.title = doc.title;
  saveStory(pack, filePath);
  return {
    ok: true,
    story_id: pack.story_id,
    logline: script.logline,
    synopsis_chars: text.length,
    note: "已写回 story.json 的 script.synopsis（未改镜头）",
  };
}

export async function writingExpandEpisodeTool(args: {
  story_id: string;
  chapter_id?: string;
  draft_id?: string;
  instruction?: string;
  create_if_missing?: boolean;
  title?: string;
  style_lock?: string;
}): Promise<ToolResult> {
  const doc = loadWriting(args.story_id);
  const draft = args.draft_id
    ? doc.drafts.find((d) => d.id === args.draft_id)
    : getActiveDraft(doc);
  const writingText = (draft?.content || doc.source_text || "").trim();
  if (!writingText) throw new Error("没有可用于拆镜的文案");

  let pack: StoryPack;
  let filePath: string | undefined;
  try {
    const loaded = loadChapter(args);
    pack = loaded.pack;
    filePath = loaded.path;
  } catch (err) {
    if (!args.create_if_missing) throw err;
    pack = await expandStoryFromSynopsis({
      story_id: args.story_id,
      title: args.title || doc.title || args.story_id,
      logline: doc.logline || writingText.slice(0, 80),
      synopsis: writingText,
      style_lock: args.style_lock || "live_action",
    });
    const dest = saveStory(pack);
    return {
      ok: true,
      story_id: pack.story_id,
      path: dest,
      shots: pack.shots.length,
      episode: "E01",
      created: true,
      note: "故事不存在，已从文案首拆 StoryPack 草稿，请审阅后再成片",
    };
  }

  const before = pack.shots.length;
  pack = await expandNextEpisodeFromWriting({
    pack,
    writing_text: writingText,
    instruction: args.instruction,
  });
  // 分镜已就位：草稿章自动转正（移除 draft 标记，可进成片校验）
  if (pack.draft && pack.shots.length) {
    delete pack.draft;
  }
  const dest = saveStory(pack, filePath);
  return {
    ok: true,
    story_id: pack.story_id,
    path: dest,
    shots: pack.shots.length,
    shots_added: pack.shots.length - before,
    created: false,
    note: "已追加下一集分镜；已有人物 identity_lock 保持冻结，请审阅后生成资产",
  };
}

export async function providersTool(args?: {
  sheet?: "openai" | "gemini";
  still?: "openai" | "gemini";
}): Promise<ToolResult> {
  if (args?.sheet || args?.still) setProviders(args);
  return {
    ok: true,
    providers: getProviders(),
    style_locks: listStyleLocks(),
  };
}

export async function setStyleLockTool(args: { story_id: string; chapter_id?: string; style_lock: string }): Promise<ToolResult> {
  const { pack, path: filePath } = loadChapter(args);
  const locks = listStyleLocks();
  if (locks.length && !locks.includes(args.style_lock) && !args.style_lock.includes(" ")) {
    // allow raw text locks too
  }
  pack.style_lock = args.style_lock;
  saveStory(pack, filePath);
  return { ok: true, style_lock: pack.style_lock, available: locks };
}

export async function manhuaHelpTool(): Promise<ToolResult> {
  return {
    ok: true,
    说明: "漫剧工具箱：StoryPack 账本 + 齐套门闸 + 计划预审 + 版本抽卡 + bridge/bridge/lipsync + ZIP/时间线。",
    推荐顺序: [
      "文案工作室：主线/小说 → 续写/反转 → 采用正文 → 拆下一集分镜",
      "加载故事 → 齐套检查 → 计划预审/自动 bridge",
      "定妆批准 → 静帧/九宫格 → 成片（跳过已有）",
      "TTS/lipsync → 时间线/ZIP/出片",
    ],
    工具列表: listToolCatalog(),
  };
}

function listToolCatalog() {
  return toolSpecs.map((t) => ({ 名称: t.name, 说明: t.description }));
}

export { listShotVideoFiles, resolveSelectedVideo, assetDirs, buildChapterPlan, checkChapterReady, loadManifest };

export const toolSpecs = [
  {
    name: "漫剧_使用说明",
    title: "漫剧使用说明",
    description: "【漫剧工具箱入口】说明工具挂载位置与推荐流程。",
    parameters: {},
    execute: manhuaHelpTool,
    render: textRender,
  },
  {
    name: "漫剧_查看密钥",
    title: "查看密钥",
    description: "【漫剧】查看 AutoDL / OpenAI / Gemini 密钥是否已配置。",
    parameters: {},
    execute: keysStatusTool,
    render: textRender,
  },
  {
    name: "漫剧_写入密钥",
    title: "写入密钥",
    description: "【漫剧】写入一类 API 密钥。provider: autodl / openai / gemini。",
    parameters: {
      provider: { type: "string", required: true, description: "autodl / openai / gemini" },
      value: { type: "string", required: true, description: "密钥明文" },
    },
    execute: keysSetTool,
    render: textRender,
  },
  {
    name: "漫剧_清除密钥",
    title: "清除密钥",
    description: "【漫剧】清除一类密钥。",
    parameters: {
      provider: { type: "string", required: true, description: "autodl / openai / gemini" },
    },
    execute: keysUnsetTool,
    render: textRender,
  },
  {
    name: "漫剧_设置参数",
    title: "设置参数",
    description: "【漫剧】写入非密钥配置。",
    parameters: {
      autodl_base_url: { type: "string" },
      openai_base_url: { type: "string" },
      gemini_base_url: { type: "string" },
      openai_image_model: { type: "string" },
      openai_chat_model: { type: "string" },
      gemini_image_model: { type: "string" },
      default_resolution: { type: "string" },
      video_workflow_id: { type: "string" },
      public_asset_base_url: { type: "string" },
    },
    execute: keysSetSettingsTool,
    render: textRender,
  },
  {
    name: "漫剧_测试连通",
    title: "测试连通",
    description: "【漫剧】探测 autodl / openai / gemini 密钥与 Base URL 是否可达。",
    parameters: {
      provider: { type: "string", required: true, description: "autodl / openai / gemini" },
    },
    execute: keysProbeTool,
    render: textRender,
  },
  {
    name: "漫剧_加载故事",
    title: "加载故事",
    description: "【漫剧】加载并校验独立故事剧本。",
    parameters: {
      story_id: { type: "string", required: true, description: "故事 ID" },
    },
    execute: storyLoad,
    render: textRender,
  },
  {
    name: "漫剧_齐套检查",
    title: "齐套检查",
    description: "【漫剧】成片前齐套门闸：定妆/道具/静帧/审批。",
    parameters: {
      story_id: { type: "string", required: true },
      shot_id: { type: "string", description: "可选，只检查单镜" },
    },
    execute: gateCheckTool,
    render: textRender,
  },
  {
    name: "漫剧_计划预审",
    title: "计划预审",
    description: "【漫剧】设置单镜路径 video_ref/bridge/grid/lipsync。",
    parameters: {
      story_id: { type: "string", required: true },
      shot_id: { type: "string", required: true },
      plan_path: { type: "string", description: "video_ref|bridge|grid|lipsync" },
      bridge_from: { type: "string" },
      needs_lipsync: { type: "boolean" },
      plan_notes: { type: "string" },
    },
    execute: planUpdateTool,
    render: textRender,
  },
  {
    name: "漫剧_自动Bridge",
    title: "自动Bridge",
    description: "【漫剧】相邻同场景自动填 bridge_from。",
    parameters: { story_id: { type: "string", required: true } },
    execute: autoBridgeTool,
    render: textRender,
  },
  {
    name: "漫剧_GPT定妆",
    title: "GPT定妆",
    description: "【漫剧】生成角色定妆并写回。",
    parameters: {
      story_id: { type: "string", required: true },
      character_id: { type: "string", required: true },
      size: { type: "string" },
    },
    execute: characterSheetGpt,
    render: textRender,
  },
  {
    name: "漫剧_Gemini分镜",
    title: "Gemini分镜",
    description: "【漫剧】生成静帧；as_grid=true 时出九宫格。",
    parameters: {
      story_id: { type: "string", required: true },
      shot_id: { type: "string", required: true },
      as_grid: { type: "boolean" },
    },
    execute: shotStillGemini,
    render: textRender,
  },
  {
    name: "漫剧_九宫格选格",
    title: "九宫格选格",
    description: "【漫剧】从九宫格裁切 cell 1-9 作为静帧。",
    parameters: {
      story_id: { type: "string", required: true },
      shot_id: { type: "string", required: true },
      cell: { type: "number", required: true },
    },
    execute: selectGridCellTool,
    render: textRender,
  },
  {
    name: "漫剧_AutoDL成片",
    title: "AutoDL成片",
    description: "【漫剧】多图参考成片；默认跳过已有，force 重跑。",
    parameters: {
      story_id: { type: "string", required: true },
      shot_id: { type: "string", required: true },
      workflow_id: { type: "string" },
      duration: { type: "number" },
      resolution: { type: "string" },
      force: { type: "boolean" },
    },
    execute: autodlVideoRef,
    render: textRender,
  },
  {
    name: "漫剧_章节流水线",
    title: "章节流水线",
    description: "【漫剧】按 steps 跑 video→bridge→lipsync，跳过已有。",
    parameters: {
      story_id: { type: "string", required: true },
      force: { type: "boolean" },
      shot_ids: { type: "array", items: { type: "string" } },
    },
    execute: runChapterPipeline,
    render: textRender,
  },
  {
    name: "漫剧_TTS对白",
    title: "TTS对白",
    description: "【漫剧】OpenAI TTS 生成对白音频。",
    parameters: {
      story_id: { type: "string", required: true },
      shot_id: { type: "string", required: true },
      voice: { type: "string" },
    },
    execute: shotTts,
    render: textRender,
  },
  {
    name: "漫剧_提示词预览",
    title: "提示词预览",
    description: "【漫剧】H3 九分节提示词预览（不改 identity_lock）。",
    parameters: {
      story_id: { type: "string", required: true },
      shot_id: { type: "string", required: true },
    },
    execute: promptPreviewTool,
    render: textRender,
  },
  {
    name: "漫剧_批准资产",
    title: "批准资产",
    description: "【漫剧】批准/驳回角色定妆或镜头静帧/成片。",
    parameters: {
      story_id: { type: "string", required: true },
      kind: { type: "string", required: true, description: "character|still|video" },
      id: { type: "string", required: true },
      approved: { type: "boolean", required: true },
    },
    execute: approveTool,
    render: textRender,
  },
  {
    name: "漫剧_选用版本",
    title: "选用版本",
    description: "【漫剧】选用静帧或成片版本号 v01/v02…",
    parameters: {
      story_id: { type: "string", required: true },
      shot_id: { type: "string", required: true },
      kind: { type: "string", required: true },
      version: { type: "string", required: true },
    },
    execute: selectVersionTool,
    render: textRender,
  },
  {
    name: "漫剧_导出ZIP",
    title: "导出ZIP",
    description: "【漫剧】导出故事工程包（不含密钥）。",
    parameters: { story_id: { type: "string", required: true } },
    execute: zipExportTool,
    render: textRender,
  },
  {
    name: "漫剧_导入ZIP",
    title: "导入ZIP",
    description: "【漫剧】导入故事工程 ZIP。",
    parameters: { zip_path: { type: "string", required: true } },
    execute: zipImportTool,
    render: textRender,
  },
  {
    name: "漫剧_导出时间线",
    title: "导出时间线",
    description: "【漫剧】导出时间线 JSON + SRT 字幕。",
    parameters: { story_id: { type: "string", required: true } },
    execute: timelineExportTool,
    render: textRender,
  },
  {
    name: "漫剧_全章配音",
    title: "全章配音",
    description: "【漫剧】为有对白镜头批量 TTS。",
    parameters: {
      story_id: { type: "string", required: true },
      force: { type: "boolean" },
    },
    execute: chapterTtsTool,
    render: textRender,
  },
  {
    name: "漫剧_章节交付",
    title: "章节交付",
    description: "【漫剧】TTS + SRT + 叠配音轨 + 可选剪映草稿。",
    parameters: {
      story_id: { type: "string", required: true },
      force_tts: { type: "boolean" },
      skip_tts: { type: "boolean" },
      skip_mux: { type: "boolean" },
      jianying: { type: "boolean" },
      jianying_draft_dir: { type: "string" },
    },
    execute: chapterDeliverTool,
    render: textRender,
  },
  {
    name: "漫剧_导出剪映草稿",
    title: "导出剪映草稿",
    description: "【漫剧】用 pyJianYingDraft 生成剪映草稿目录。",
    parameters: {
      story_id: { type: "string", required: true },
      draft_dir: { type: "string" },
      draft_name: { type: "string" },
    },
    execute: jianyingExportTool,
    render: textRender,
  },
  {
    name: "漫剧_LLM拆剧",
    title: "LLM拆剧",
    description: "【漫剧】从梗概生成 StoryPack 草稿。",
    parameters: {
      story_id: { type: "string", required: true },
      logline: { type: "string", required: true },
      synopsis: { type: "string", required: true },
      title: { type: "string" },
      style_lock: { type: "string" },
    },
    execute: expandStoryTool,
    render: textRender,
  },
  {
    name: "漫剧_文案读取",
    title: "文案读取",
    description: "【漫剧】读取文案账本 writing.json。",
    parameters: { story_id: { type: "string", required: true } },
    execute: writingGetTool,
    render: textRender,
  },
  {
    name: "漫剧_文案导入",
    title: "文案导入",
    description: "【漫剧】导入主线/小说正文。",
    parameters: {
      story_id: { type: "string", required: true },
      source_text: { type: "string", required: true },
      title: { type: "string" },
      logline: { type: "string" },
    },
    execute: writingSeedTool,
    render: textRender,
  },
  {
    name: "漫剧_文案生成",
    title: "文案生成",
    description: "【漫剧】续写 / 加反转 / 按指示改写。",
    parameters: {
      story_id: { type: "string", required: true },
      kind: { type: "string", required: true, description: "continue | twist | revise" },
      instruction: { type: "string" },
      target_chars: { type: "number" },
    },
    execute: writingGenerateTool,
    render: textRender,
  },
  {
    name: "漫剧_文案采用",
    title: "文案采用",
    description: "【漫剧】草稿采用为正文。",
    parameters: {
      story_id: { type: "string", required: true },
      draft_id: { type: "string" },
      mode: { type: "string" },
    },
    execute: writingAdoptTool,
    render: textRender,
  },
  {
    name: "漫剧_文案写回剧本",
    title: "文案写回剧本",
    description: "【漫剧】写回 script.synopsis，不改镜头。",
    parameters: {
      story_id: { type: "string", required: true },
      draft_id: { type: "string" },
    },
    execute: writingApplySynopsisTool,
    render: textRender,
  },
  {
    name: "漫剧_文案拆下一集",
    title: "文案拆下一集",
    description: "【漫剧】按文案追加分镜；冻结 identity_lock。",
    parameters: {
      story_id: { type: "string", required: true },
      draft_id: { type: "string" },
      instruction: { type: "string" },
      create_if_missing: { type: "boolean" },
      title: { type: "string" },
      style_lock: { type: "string" },
    },
    execute: writingExpandEpisodeTool,
    render: textRender,
  },
  {
    name: "漫剧_Provider与画风",
    title: "Provider与画风",
    description: "【漫剧】查看/切换图像 Provider，列出 style_lock。",
    parameters: {
      sheet: { type: "string" },
      still: { type: "string" },
    },
    execute: providersTool,
    render: textRender,
  },
  {
    name: "漫剧_切换画风",
    title: "切换画风",
    description: "【漫剧】为当前故事切换 style_lock。",
    parameters: {
      story_id: { type: "string", required: true },
      style_lock: { type: "string", required: true },
    },
    execute: setStyleLockTool,
    render: textRender,
  },
] as const;
