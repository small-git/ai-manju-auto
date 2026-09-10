import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RUNS_DIR, STORIES_DIR, ensureDir } from "../paths.js";
import { loadStory, saveStory, type StoryPack } from "../story.js";
import { fail, ok, step } from "../zh-log.js";

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

function shouldSkipZipEntry(name: string): boolean {
  return (
    name.startsWith("_zip_staging_") ||
    name.startsWith("_import_") ||
    name.endsWith("_bundle.zip") ||
    name === ".env" ||
    name === "keys.json" ||
    name === ".manhua-secrets.json"
  );
}

function copyDir(src: string, dest: string): void {
  ensureDir(dest);
  for (const name of fs.readdirSync(src)) {
    if (shouldSkipZipEntry(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else {
      ensureDir(path.dirname(d));
      fs.copyFileSync(s, d);
    }
  }
}

export function exportStoryZip(storyId: string, outPath?: string): { zip_path: string; note: string } {
  step("ZIP导出", "开始打包工程", { story_id: storyId });
  const { pack } = loadStory(storyId);
  const storyDir = path.join(STORIES_DIR, storyId);
  const runsDir = path.join(RUNS_DIR, storyId);
  const exportRoot = path.join(RUNS_DIR, storyId, pack.chapter_id, "04_export");
  ensureDir(exportRoot);
  const zipPath = outPath || path.join(exportRoot, `${storyId}_${pack.chapter_id}_bundle.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  // staging MUST be outside runsDir to avoid recursive self-copy
  const staging = path.join(os.tmpdir(), `manhua_zip_${storyId}_${Date.now()}`);
  ensureDir(staging);
  try {
    copyDir(storyDir, path.join(staging, "stories", storyId));
    if (fs.existsSync(runsDir)) copyDir(runsDir, path.join(staging, "runs", storyId));

    if (process.platform === "win32") {
      const ps = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Compress-Archive -Path (Join-Path '${staging}' '*') -DestinationPath '${zipPath}' -Force`,
        ],
        { encoding: "utf8" },
      );
      if (ps.status !== 0) {
        fail("ZIP导出", "Compress-Archive 失败", { error: ps.stderr || ps.stdout });
        throw new Error(`ZIP 失败: ${ps.stderr || ps.stdout}`);
      }
    } else {
      const zip = spawnSync("zip", ["-r", zipPath, "."], { cwd: staging, encoding: "utf8" });
      if (zip.status !== 0) {
        fail("ZIP导出", "zip 命令失败", { error: zip.stderr || zip.stdout });
        throw new Error(`ZIP 失败: ${zip.stderr || zip.stdout}`);
      }
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  ok("ZIP导出", "工程包已生成", { zip_path: zipPath });
  return { zip_path: zipPath, note: "已打包 stories + runs（不含密钥）" };
}

export function importStoryZip(zipPath: string): { story_id: string; note: string } {
  step("ZIP导入", "开始解压工程包", { zip_path: zipPath });
  if (!fs.existsSync(zipPath)) {
    fail("ZIP导入", "ZIP 文件不存在", { zip_path: zipPath });
    throw new Error(`ZIP 不存在: ${zipPath}`);
  }
  const staging = path.join(os.tmpdir(), `manhua_import_${Date.now()}`);
  ensureDir(staging);
  try {
    if (process.platform === "win32") {
      const ps = spawnSync(
        "powershell",
        ["-NoProfile", "-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${staging}' -Force`],
        { encoding: "utf8" },
      );
      if (ps.status !== 0) {
        fail("ZIP导入", "Expand-Archive 失败", { error: ps.stderr || ps.stdout });
        throw new Error(`解压失败: ${ps.stderr || ps.stdout}`);
      }
    } else {
      const unzip = spawnSync("unzip", ["-o", zipPath, "-d", staging], { encoding: "utf8" });
      if (unzip.status !== 0) {
        fail("ZIP导入", "unzip 失败", { error: unzip.stderr || unzip.stdout });
        throw new Error(`解压失败: ${unzip.stderr || unzip.stdout}`);
      }
    }

    const storiesRoot = path.join(staging, "stories");
    if (!fs.existsSync(storiesRoot)) {
      fail("ZIP导入", "ZIP 内缺少 stories/");
      throw new Error("ZIP 内缺少 stories/");
    }
    const ids = fs
      .readdirSync(storiesRoot)
      .filter((n) => fs.existsSync(path.join(storiesRoot, n, "story.json")));
    if (!ids.length) {
      fail("ZIP导入", "ZIP 内无有效 story.json");
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
    ok("ZIP导入", "导入完成", { story_id: storyId, stories: ids.join(",") });
    return { story_id: storyId, note: `已导入故事 ${ids.join(", ")}` };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
