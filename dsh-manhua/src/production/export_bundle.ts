import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RUNS_DIR, STORIES_DIR, ensureDir } from "../paths.js";
import { loadStory, saveStory, type StoryPack } from "../story.js";

function findFfmpeg(): string | null {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], {
    encoding: "utf8",
  });
  const line = (which.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (line && fs.existsSync(line)) return line;
  return null;
}

/** 九宫格图按 cell 1–9 裁切（需 ffmpeg） */
export function cropGridCell(gridPath: string, cell: number, destPath: string): string {
  if (cell < 1 || cell > 9) throw new Error("grid cell 必须是 1–9");
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("裁切九宫格需要 ffmpeg");
  ensureDir(path.dirname(destPath));
  const col = (cell - 1) % 3;
  const row = Math.floor((cell - 1) / 3);
  const filter = `crop=iw/3:ih/3:${col}*iw/3:${row}*ih/3`;
  const result = spawnSync(ffmpeg, ["-y", "-i", gridPath, "-vf", filter, destPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`九宫格裁切失败: ${result.stderr || result.stdout || "unknown"}`);
  }
  return destPath;
}

export type TimelineClip = {
  shot_id: string;
  file: string;
  duration: number;
  dialogue?: string | null;
};

/** 简易时间线 + 剪映可参考清单（JSON） */
export function buildTimelineManifest(
  pack: StoryPack,
  clips: TimelineClip[],
): Record<string, unknown> {
  let t = 0;
  const items = clips.map((c) => {
    const start = t;
    t += c.duration;
    return {
      shot_id: c.shot_id,
      file: c.file.replace(/\\/g, "/"),
      start_sec: start,
      end_sec: t,
      duration_sec: c.duration,
      dialogue: c.dialogue || null,
    };
  });
  return {
    format: "manhua_timeline_v1",
    story_id: pack.story_id,
    chapter_id: pack.chapter_id,
    title: pack.title,
    resolution: pack.resolution || "768p横",
    total_duration_sec: t,
    clips: items,
    jianying_hint: "将 clips[].file 按序导入剪映；对白见 dialogue 字段",
  };
}

export function exportStoryZip(storyId: string, outPath?: string): { zip_path: string; note: string } {
  const { pack } = loadStory(storyId);
  const storyDir = path.join(STORIES_DIR, storyId);
  const runsDir = path.join(RUNS_DIR, storyId);
  const exportRoot = path.join(RUNS_DIR, storyId, pack.chapter_id, "04_export");
  ensureDir(exportRoot);
  const zipPath = outPath || path.join(exportRoot, `${storyId}_${pack.chapter_id}_bundle.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  const staging = path.join(exportRoot, `_zip_staging_${Date.now()}`);
  ensureDir(staging);
  copyDir(storyDir, path.join(staging, "stories", storyId));
  if (fs.existsSync(runsDir)) copyDir(runsDir, path.join(staging, "runs", storyId));
  // strip secrets if any leaked env files
  for (const name of [".env", "keys.json"]) {
    const p = path.join(staging, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  if (process.platform === "win32") {
    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}' -Force`],
      { encoding: "utf8" },
    );
    fs.rmSync(staging, { recursive: true, force: true });
    if (ps.status !== 0) throw new Error(`ZIP 失败: ${ps.stderr || ps.stdout}`);
  } else {
    const zip = spawnSync("zip", ["-r", zipPath, "."], { cwd: staging, encoding: "utf8" });
    fs.rmSync(staging, { recursive: true, force: true });
    if (zip.status !== 0) throw new Error(`ZIP 失败: ${zip.stderr || zip.stdout}`);
  }
  return { zip_path: zipPath, note: "已打包 stories + runs（不含密钥）" };
}

export function importStoryZip(zipPath: string): { story_id: string; note: string } {
  if (!fs.existsSync(zipPath)) throw new Error(`ZIP 不存在: ${zipPath}`);
  const staging = path.join(RUNS_DIR, `_import_${Date.now()}`);
  ensureDir(staging);
  if (process.platform === "win32") {
    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${staging}' -Force`],
      { encoding: "utf8" },
    );
    if (ps.status !== 0) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`解压失败: ${ps.stderr || ps.stdout}`);
    }
  } else {
    const unzip = spawnSync("unzip", ["-o", zipPath, "-d", staging], { encoding: "utf8" });
    if (unzip.status !== 0) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`解压失败: ${unzip.stderr || unzip.stdout}`);
    }
  }

  const storiesRoot = path.join(staging, "stories");
  if (!fs.existsSync(storiesRoot)) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error("ZIP 内缺少 stories/");
  }
  const ids = fs.readdirSync(storiesRoot).filter((n) => fs.existsSync(path.join(storiesRoot, n, "story.json")));
  if (!ids.length) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error("ZIP 内无有效 story.json");
  }
  for (const id of ids) {
    copyDir(path.join(storiesRoot, id), path.join(STORIES_DIR, id));
  }
  const runsRoot = path.join(staging, "runs");
  if (fs.existsSync(runsRoot)) {
    for (const id of fs.readdirSync(runsRoot)) {
      copyDir(path.join(runsRoot, id), path.join(RUNS_DIR, id));
    }
  }
  const storyId = ids[0];
  const { pack, path: storyPath } = loadStory(storyId);
  saveStory(pack, storyPath);
  fs.rmSync(staging, { recursive: true, force: true });
  return { story_id: storyId, note: `已导入故事 ${ids.join(", ")}` };
}

function copyDir(src: string, dest: string): void {
  ensureDir(dest);
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else {
      ensureDir(path.dirname(d));
      fs.copyFileSync(s, d);
    }
  }
}
