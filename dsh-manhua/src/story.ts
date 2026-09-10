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
  steps?: Array<"video" | "bridge" | "lipsync" | string>;
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

export function storyPath(storyId: string): string {
  return path.join(STORIES_DIR, storyId, "story.json");
}

export function loadStory(storyId: string): { pack: StoryPack; path: string } {
  if (!storyId?.trim()) {
    throw new StoryError("必须显式指定 story_id（一故事一剧本，禁止无引用成片）");
  }
  const p = storyPath(storyId);
  if (!fs.existsSync(p)) {
    throw new StoryError(`故事不存在: ${p}`);
  }
  const pack = JSON.parse(fs.readFileSync(p, "utf8")) as StoryPack;
  if (pack.story_id !== storyId) {
    throw new StoryError(
      `故事引用不匹配：请求 ${storyId}，文件 story_id=${pack.story_id}`,
    );
  }
  pack.props = pack.props || [];
  const issues = validateStory(pack);
  if (issues.length) {
    throw new StoryError("story pack invalid:\n- " + issues.join("\n- "));
  }
  return { pack, path: p };
}

export function validateStory(pack: StoryPack): string[] {
  const issues: string[] = [];
  if (!pack.story_id) issues.push("missing story_id");
  if (!pack.chapter_id) issues.push("missing chapter_id");
  if (!pack.script) issues.push("missing script");
  if (!pack.characters?.length) issues.push("characters required");
  if (!pack.environments?.length) issues.push("environments required");
  if (!pack.shots?.length) issues.push("shots required");

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
  idx.stories[pack.story_id] = {
    title: pack.title || pack.story_id,
    chapter_id: pack.chapter_id,
    project_id: pack.project_id,
    path: rel,
    logline: (pack.script as { logline?: string })?.logline,
  };
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), "utf8");
  ok("故事注册", "已写入索引", { story_id: pack.story_id, path: rel });
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
