import fs from "node:fs";
import path from "node:path";
import { STORIES_DIR, ensureDir, loadConfig } from "./config.js";
import { REPO_ROOT } from "./paths.js";
import { ok, warn } from "./zh-log.js";

export type RefImages = Record<string, string>;

export type StoryCharacter = {
  id: string;
  name: string;
  identity_lock: string;
  role?: string;
  sheet_prompt?: string;
  ref_images?: RefImages;
  /** false 时禁止下游成片；缺省视为已批准 */
  approved?: boolean;
};

export type StoryEnvironment = {
  id: string;
  name: string;
  scene_card: string;
  time_of_day?: string;
  weather?: string;
  ref_images?: RefImages;
};

export type StoryProp = {
  id: string;
  name: string;
  clue_lock: string;
  ref_images?: RefImages;
};

export type StoryShot = {
  shot_id: string;
  environment_id: string;
  character_ids: string[];
  action: string;
  episode_id?: string;
  scene_id?: string;
  beat_id?: string;
  prop_ids?: string[];
  duration?: number;
  still_prompt?: string;
  still_url?: string;
  video_prompt?: string;
  ref_images?: string[];
  ref_audios?: string[];
  camera?: Record<string, string>;
  emotion?: string;
  dialogue?: string | null;
  plan_path?: "video_ref" | "bridge" | "grid" | "lipsync" | string;
  plan_notes?: string;
  bridge_from?: string | null;
  first_frame?: string;
  last_frame?: string;
  needs_lipsync?: boolean;
  still_approved?: boolean;
  video_approved?: boolean;
  segment_break?: boolean;
  hard_cut?: boolean;
  grid_cell?: number;
  workflow?: string;
  seed?: number | null;
  state?: Record<string, unknown>;
  [k: string]: unknown;
};

export type StoryPack = {
  story_id: string;
  chapter_id: string;
  project_id: string;
  title?: string;
  style_lock?: string;
  resolution?: string;
  video_workflow?: string;
  steps?: Array<"audio" | "video" | "bridge" | "lipsync" | string>;
  /** 章节管理新建的草稿章：允许空分镜，待后续流程填充 */
  draft?: boolean;
  script: Record<string, unknown>;
  characters: StoryCharacter[];
  environments: StoryEnvironment[];
  props?: StoryProp[];
  shots: StoryShot[];
  [k: string]: unknown;
};

export class StoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryError";
  }
}

export function storyPath(storyId: string, chapterId?: string): string {
  if (chapterId?.trim()) {
    const cid = chapterId.trim();
    const chapterFile = chapterFilePath(storyId, cid);
    if (fs.existsSync(chapterFile)) return chapterFile;
    // 默认章 story.json 若即该章则兜底
    const defaultFile = path.join(STORIES_DIR, storyId, "story.json");
    if (fs.existsSync(defaultFile)) {
      try {
        const p = JSON.parse(fs.readFileSync(defaultFile, "utf8")) as { chapter_id?: string };
        if (p?.chapter_id === cid) return defaultFile;
      } catch {
        /* fallthrough */
      }
    }
    throw new StoryError(`章节不存在: ${storyId}/${cid}（可在「章节管理」新建）`);
  }
  return path.join(STORIES_DIR, storyId, "story.json");
}

/** 新章节的目标文件（chapters/<chapter_id>.json），创建/保存时用。 */
export function chapterFilePath(storyId: string, chapterId: string): string {
  return path.join(STORIES_DIR, storyId, "chapters", `${chapterId}.json`);
}

export function loadStory(storyId: string, chapterId?: string): { pack: StoryPack; path: string } {
  if (!storyId?.trim()) {
    throw new StoryError("必须显式指定 story_id（一故事一剧本，禁止无引用成片）");
  }
  const p = storyPath(storyId, chapterId);
  if (!fs.existsSync(p)) {
    throw new StoryError(`故事不存在: ${p}`);
  }
  const pack = JSON.parse(fs.readFileSync(p, "utf8")) as StoryPack;
  if (pack.story_id !== storyId) {
    throw new StoryError(
      `故事引用不匹配：请求 ${storyId}，文件 story_id=${pack.story_id}`,
    );
  }
  if (chapterId?.trim() && pack.chapter_id !== chapterId.trim()) {
    throw new StoryError(
      `章节引用不匹配：请求 ${chapterId}，文件 chapter_id=${pack.chapter_id}`,
    );
  }
  pack.props = pack.props || [];
  const issues = validateStory(pack);
  if (issues.length) {
    throw new StoryError("story pack invalid:\n- " + issues.join("\n- "));
  }
  return { pack, path: p };
}

export type ChapterSummary = {
  chapter_id: string;
  title?: string;
  logline?: string;
  project_id?: string;
  path: string;
  is_default: boolean;
  draft: boolean;
  shots: number;
  episodes: number;
};

/** 列出故事全部章节：默认章 story.json + chapters/*.json。 */
export function listChapters(storyId: string): ChapterSummary[] {
  const dir = path.join(STORIES_DIR, storyId);
  if (!fs.existsSync(dir)) {
    throw new StoryError(`故事不存在: ${dir}`);
  }
  const out: ChapterSummary[] = [];
  const readChapter = (file: string, isDefault: boolean) => {
    try {
      const p = JSON.parse(fs.readFileSync(file, "utf8")) as StoryPack;
      if (p?.story_id !== storyId) return;
      out.push({
        chapter_id: p.chapter_id || (isDefault ? "CH01" : path.basename(file, ".json")),
        title: p.title,
        logline: (p.script as { logline?: string })?.logline,
        project_id: p.project_id,
        path: toRepoRelative(file),
        is_default: isDefault,
        draft: p.draft === true,
        shots: Array.isArray(p.shots) ? p.shots.length : 0,
        episodes: Array.isArray((p.script as { episodes?: unknown[] })?.episodes)
          ? ((p.script as { episodes?: unknown[] }).episodes as unknown[]).length
          : 0,
      });
    } catch {
      /* skip unreadable file */
    }
  };
  const defaultFile = path.join(dir, "story.json");
  if (fs.existsSync(defaultFile)) readChapter(defaultFile, true);
  const chaptersDir = path.join(dir, "chapters");
  if (fs.existsSync(chaptersDir)) {
    for (const f of fs
      .readdirSync(chaptersDir)
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      readChapter(path.join(chaptersDir, f), false);
    }
  }
  if (!out.length) {
    throw new StoryError(`故事无可用章节: ${storyId}`);
  }
  return out.sort((a, b) => a.chapter_id.localeCompare(b.chapter_id));
}

export type CreateChapterOptions = {
  /** 从哪一章克隆宇宙（人物/环境/道具/画风）；缺省为默认章 */
  from_chapter?: string;
  title?: string;
  logline?: string;
  synopsis?: string;
  project_id?: string;
};

/** 新建章节：克隆宇宙资产，剧本/分镜独立（draft，待后续流程填充）。 */
export function createChapter(
  storyId: string,
  chapterId: string,
  opts: CreateChapterOptions = {},
): { pack: StoryPack; path: string } {
  const cid = chapterId.trim().toUpperCase();
  if (!/^CH\d{2,}$/.test(cid)) {
    throw new StoryError(`章节 ID 需形如 CH02：${chapterId}`);
  }
  const target = chapterFilePath(storyId, cid);
  if (fs.existsSync(target)) {
    throw new StoryError(`章节已存在: ${storyId}/${cid}`);
  }
  const { pack: src } = loadStory(storyId, opts.from_chapter);
  const pack: StoryPack = {
    story_id: storyId,
    chapter_id: cid,
    project_id: opts.project_id || `${src.project_id || storyId}_${cid.toLowerCase()}`,
    title: opts.title || `${src.title || storyId}·${cid}`,
    style_lock: src.style_lock,
    resolution: src.resolution,
    video_workflow: src.video_workflow,
    steps: src.steps,
    draft: true,
    script: {
      logline: opts.logline || "",
      synopsis: opts.synopsis || "",
      episodes: [],
    },
    characters: structuredClone(src.characters),
    environments: structuredClone(src.environments),
    props: structuredClone(src.props || []),
    shots: [],
  };
  saveStory(pack, target);
  ok("章节管理", "已创建章节", { story_id: storyId, chapter_id: cid, path: target });
  return { pack, path: target };
}

export function validateStory(pack: StoryPack): string[] {
  const issues: string[] = [];
  if (!pack.story_id) issues.push("missing story_id");
  if (!pack.chapter_id) issues.push("missing chapter_id");
  if (!pack.script) issues.push("missing script");
  if (!pack.characters?.length) issues.push("characters required");
  if (!pack.environments?.length) issues.push("environments required");
  // draft 章节（章节管理新建、待填充）允许空分镜
  if (!pack.draft && !pack.shots?.length) issues.push("shots required");

  const charIds = new Set(pack.characters.map((c) => c.id));
  const envIds = new Set(pack.environments.map((e) => e.id));
  const propIds = new Set((pack.props || []).map((p) => p.id));
  const shotIds = new Set(pack.shots.map((s) => s.shot_id));

  for (const sh of pack.shots) {
    if (!envIds.has(sh.environment_id)) {
      issues.push(`${sh.shot_id}: unknown environment_id ${sh.environment_id}`);
    }
    for (const cid of sh.character_ids || []) {
      if (!charIds.has(cid)) issues.push(`${sh.shot_id}: unknown character_id ${cid}`);
    }
    for (const pid of sh.prop_ids || []) {
      if (!propIds.has(pid)) issues.push(`${sh.shot_id}: unknown prop_id ${pid}`);
    }
    for (const url of sh.ref_images || []) {
      if (url === "") issues.push(`${sh.shot_id}: empty string in ref_images (forbidden)`);
    }
    if (sh.bridge_from && !shotIds.has(String(sh.bridge_from))) {
      issues.push(`${sh.shot_id}: bridge_from unknown ${sh.bridge_from}`);
    }
  }
  return issues;
}

export function saveStory(pack: StoryPack, filePath?: string): string {
  const p = filePath || storyPath(pack.story_id);
  ensureDir(path.dirname(p));
  pack.props = pack.props || [];
  fs.writeFileSync(p, JSON.stringify(pack, null, 2), "utf8");
  registerStory(pack, p);
  return p;
}

function toRepoRelative(filePath: string): string {
  const abs = path.resolve(filePath);
  const root = path.resolve(REPO_ROOT);
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    warn("故事注册", "路径不在仓库内，仍写入原路径", { path: abs });
    return abs.replace(/\\/g, "/");
  }
  return rel;
}

function registerStory(pack: StoryPack, filePath: string): void {
  const cfg = loadConfig();
  const indexPath = path.join(cfg.storiesDir, "index.json");
  ensureDir(cfg.storiesDir);
  let idx: { stories: Record<string, unknown> } = { stories: {} };
  if (fs.existsSync(indexPath)) {
    idx = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    idx.stories ||= {};
  }
  const rel = toRepoRelative(filePath);
  const logline = (pack.script as { logline?: string })?.logline;
  const entry = ((idx.stories as Record<string, Record<string, unknown>>)[pack.story_id] ||
    {}) as Record<string, unknown>;
  // 故事→章节两级索引；顶层字段保留为"最近注册章"以兼容旧消费方
  const chapters = (entry.chapters || {}) as Record<string, unknown>;
  if (pack.chapter_id) {
    chapters[pack.chapter_id] = { project_id: pack.project_id, path: rel, logline };
  }
  entry.chapters = chapters;
  entry.title = pack.title || (entry.title as string) || pack.story_id;
  entry.chapter_id = pack.chapter_id;
  entry.project_id = pack.project_id;
  entry.path = rel;
  entry.logline = logline;
  (idx.stories as Record<string, unknown>)[pack.story_id] = entry;
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), "utf8");
  ok("故事注册", "已写入索引", { story_id: pack.story_id, chapter_id: pack.chapter_id, path: rel });
}

/** 宇宙同步：把源章的人物/环境/道具/画风锁复制到故事其余各章。 */
export function syncUniverse(storyId: string, fromChapter?: string): { updated: string[] } {
  const { pack: src } = loadStory(storyId, fromChapter);
  const updated: string[] = [];
  for (const ch of listChapters(storyId)) {
    if (ch.chapter_id === src.chapter_id) continue;
    const { pack, path: p } = loadStory(storyId, ch.chapter_id);
    pack.characters = structuredClone(src.characters);
    pack.environments = structuredClone(src.environments);
    pack.props = structuredClone(src.props || []);
    pack.style_lock = src.style_lock;
    saveStory(pack, p);
    updated.push(ch.chapter_id);
  }
  if (updated.length) {
    ok("章节管理", "宇宙已同步", { story_id: storyId, from: src.chapter_id, to: updated.join(",") });
  }
  return { updated };
}

export function getCharacter(pack: StoryPack, characterId: string) {
  const ch = pack.characters.find((c) => c.id === characterId);
  if (!ch) throw new StoryError(`unknown character_id: ${characterId}`);
  return ch;
}

export function getShot(pack: StoryPack, shotId: string) {
  const sh = pack.shots.find((s) => s.shot_id === shotId);
  if (!sh) throw new StoryError(`unknown shot_id: ${shotId}`);
  return sh;
}

export function getEnvironment(pack: StoryPack, envId: string) {
  const env = pack.environments.find((e) => e.id === envId);
  if (!env) throw new StoryError(`unknown environment_id: ${envId}`);
  return env;
}

export function getProp(pack: StoryPack, propId: string) {
  const prop = (pack.props || []).find((p) => p.id === propId);
  if (!prop) throw new StoryError(`unknown prop_id: ${propId}`);
  return prop;
}

export function loadStyleLock(name?: string): string {
  if (!name) return "";
  const p = path.join(loadConfig().repoRoot, "templates", "style_locks", `${name}.txt`);
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  return name;
}

export function listStyleLocks(): string[] {
  const dir = path.join(loadConfig().repoRoot, "templates", "style_locks");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.replace(/\.txt$/, ""));
}

export function withLocks(prompt: string, styleLock: string, identityLock: string): string {
  return [styleLock, identityLock, prompt].filter(Boolean).join("。");
}
