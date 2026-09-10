import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../paths.js";
import type { StoryPack } from "../story.js";

export type ShotVersions = {
  still_versions: string[];
  selected_still: string | null;
  video_versions: string[];
  selected_video: string | null;
  grid_path?: string | null;
  selected_grid_cell?: number | null;
};

export type ChapterManifest = {
  story_id: string;
  chapter_id: string;
  updated_at: string;
  shots: Record<string, ShotVersions>;
};

function manifestPath(dirs: { base: string }): string {
  return path.join(dirs.base, "manifest.json");
}

export function loadManifest(pack: StoryPack, dirs: { base: string }): ChapterManifest {
  const p = manifestPath(dirs);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, "utf8")) as ChapterManifest;
  }
  return {
    story_id: pack.story_id,
    chapter_id: pack.chapter_id,
    updated_at: new Date().toISOString(),
    shots: {},
  };
}

export function saveManifest(dirs: { base: string }, manifest: ChapterManifest): void {
  ensureDir(dirs.base);
  manifest.updated_at = new Date().toISOString();
  fs.writeFileSync(manifestPath(dirs), JSON.stringify(manifest, null, 2), "utf8");
}

function shotEntry(manifest: ChapterManifest, shotId: string): ShotVersions {
  if (!manifest.shots[shotId]) {
    manifest.shots[shotId] = {
      still_versions: [],
      selected_still: null,
      video_versions: [],
      selected_video: null,
    };
  }
  return manifest.shots[shotId];
}

function nextVersionLabel(existing: string[]): string {
  let max = 0;
  for (const v of existing) {
    const m = /^v(\d+)$/i.exec(v);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `v${String(max + 1).padStart(2, "0")}`;
}

/** 登记静帧新版本，默认选中最新 */
export function registerStillVersion(
  pack: StoryPack,
  dirs: { base: string; assets: string },
  shotId: string,
  filePath: string,
): { version: string; dest: string; manifest: ChapterManifest } {
  const manifest = loadManifest(pack, dirs);
  const entry = shotEntry(manifest, shotId);
  const version = nextVersionLabel(entry.still_versions);
  const versionDir = path.join(dirs.assets, shotId, "stills");
  ensureDir(versionDir);
  const ext = path.extname(filePath) || ".png";
  const dest = path.join(versionDir, `${version}${ext}`);
  fs.copyFileSync(filePath, dest);
  entry.still_versions.push(version);
  entry.selected_still = version;
  saveManifest(dirs, manifest);
  return { version, dest, manifest };
}

/** 登记成片新版本到 03_video/{shotId}/vNN.mp4 */
export function registerVideoVersion(
  pack: StoryPack,
  dirs: { base: string; video: string },
  shotId: string,
  filePath: string,
): { version: string; dest: string; manifest: ChapterManifest } {
  const manifest = loadManifest(pack, dirs);
  const entry = shotEntry(manifest, shotId);
  const version = nextVersionLabel(entry.video_versions);
  const versionDir = path.join(dirs.video, shotId);
  ensureDir(versionDir);
  const dest = path.join(versionDir, `${version}.mp4`);
  fs.copyFileSync(filePath, dest);
  entry.video_versions.push(version);
  entry.selected_video = version;
  saveManifest(dirs, manifest);
  return { version, dest, manifest };
}

export function selectVersion(
  pack: StoryPack,
  dirs: { base: string },
  shotId: string,
  kind: "still" | "video",
  version: string,
): ChapterManifest {
  const manifest = loadManifest(pack, dirs);
  const entry = shotEntry(manifest, shotId);
  if (kind === "still") {
    if (!entry.still_versions.includes(version)) throw new Error(`静帧版本不存在: ${version}`);
    entry.selected_still = version;
  } else {
    if (!entry.video_versions.includes(version)) throw new Error(`成片版本不存在: ${version}`);
    entry.selected_video = version;
  }
  saveManifest(dirs, manifest);
  return manifest;
}

/** 解析选用成片路径：优先 manifest 选中版本，否则回退扁平文件 */
export function resolveSelectedVideo(
  pack: StoryPack,
  dirs: { base: string; video: string },
  shotId: string,
): string | null {
  const manifest = loadManifest(pack, dirs);
  const entry = manifest.shots[shotId];
  if (entry?.selected_video) {
    const p = path.join(dirs.video, shotId, `${entry.selected_video}.mp4`);
    if (fs.existsSync(p)) return p;
  }
  const versionDir = path.join(dirs.video, shotId);
  if (fs.existsSync(versionDir)) {
    const files = fs
      .readdirSync(versionDir)
      .filter((f) => f.toLowerCase().endsWith(".mp4"))
      .sort();
    if (files.length) return path.join(versionDir, files[files.length - 1]);
  }
  if (!fs.existsSync(dirs.video)) return null;
  const flat = fs
    .readdirSync(dirs.video)
    .filter((f) => f.startsWith(`${shotId}_`) && f.toLowerCase().endsWith(".mp4"))
    .sort();
  return flat.length ? path.join(dirs.video, flat[flat.length - 1]) : null;
}

export function listShotVideoFiles(dirs: { video: string }, shotId: string): string[] {
  const out: string[] = [];
  const versionDir = path.join(dirs.video, shotId);
  if (fs.existsSync(versionDir)) {
    out.push(
      ...fs
        .readdirSync(versionDir)
        .filter((f) => f.toLowerCase().endsWith(".mp4"))
        .map((f) => path.join(versionDir, f))
        .sort(),
    );
  }
  if (fs.existsSync(dirs.video)) {
    out.push(
      ...fs
        .readdirSync(dirs.video)
        .filter((f) => f.startsWith(`${shotId}_`) && f.toLowerCase().endsWith(".mp4"))
        .map((f) => path.join(dirs.video, f))
        .sort(),
    );
  }
  return [...new Set(out)];
}
