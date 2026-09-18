import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RUNS_DIR, STORIES_DIR, ensureDir } from "../paths.js";
import { loadStory, saveStory, type StoryPack } from "../story.js";
import { fileURLToPath } from "node:url";
import { fail, ok, step, warn } from "../zh-log.js";

function findBinary(name: string): string | null {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    encoding: "utf8",
  });
  const line = (which.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (line && fs.existsSync(line)) return line;
  return null;
}

function findFfmpeg(): string | null {
  return findBinary("ffmpeg");
}

function findFfprobe(): string | null {
  return findBinary("ffprobe");
}

function findPython(): string | null {
  for (const name of ["python", "py"]) {
    const hit = findBinary(name);
    if (hit) return hit;
  }
  return null;
}

/** 探测媒体时长（秒）；失败则返回 fallback */
export function probeDurationSec(filePath: string, fallback = 5): number {
  const ffprobe = findFfprobe();
  if (!ffprobe || !fs.existsSync(filePath)) return fallback;
  const result = spawnSync(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath],
    { encoding: "utf8" },
  );
  const n = Number.parseFloat((result.stdout || "").trim());
  return Number.isFinite(n) && n > 0.05 ? n : fallback;
}

export function probeVideoSize(filePath: string): { width?: number; height?: number } {
  const ffprobe = findFfprobe();
  if (!ffprobe || !fs.existsSync(filePath)) return {};
  const result = spawnSync(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      filePath,
    ],
    { encoding: "utf8" },
  );
  const parts = (result.stdout || "").trim().split(",");
  const width = Number.parseInt(parts[0] || "", 10);
  const height = Number.parseInt(parts[1] || "", 10);
  return {
    width: Number.isFinite(width) ? width : undefined,
    height: Number.isFinite(height) ? height : undefined,
  };
}

function srtTimestamp(sec: number): string {
  const msTotal = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(msTotal / 3_600_000);
  const m = Math.floor((msTotal % 3_600_000) / 60_000);
  const s = Math.floor((msTotal % 60_000) / 1000);
  const ms = msTotal % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/** 由时间线 clips 生成 SRT 正文 */
export function buildSrtFromClips(
  clips: Array<{ start_sec: number; end_sec: number; dialogue?: string | null }>,
): string {
  const blocks: string[] = [];
  let idx = 1;
  for (const c of clips) {
    const text = String(c.dialogue || "").trim();
    if (!text) continue;
    blocks.push(
      `${idx}\n${srtTimestamp(c.start_sec)} --> ${srtTimestamp(c.end_sec)}\n${text.replace(/\r?\n/g, " ")}\n`,
    );
    idx += 1;
  }
  return blocks.join("\n");
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
  audio_file?: string | null;
  audio_duration_sec?: number;
  width?: number;
  height?: number;
};

/** 时间线 + SRT 线索 + 剪映草稿输入 */
export function buildTimelineManifest(
  pack: StoryPack,
  clips: TimelineClip[],
): Record<string, unknown> {
  let t = 0;
  const items = clips.map((c) => {
    const start = t;
    const dur = c.duration > 0 ? c.duration : 5;
    t += dur;
    const size = c.width && c.height ? { width: c.width, height: c.height } : probeVideoSize(c.file);
    return {
      shot_id: c.shot_id,
      file: c.file.replace(/\\/g, "/"),
      start_sec: start,
      end_sec: t,
      duration_sec: dur,
      dialogue: c.dialogue || null,
      audio_file: c.audio_file ? c.audio_file.replace(/\\/g, "/") : null,
      audio_duration_sec: c.audio_duration_sec || null,
      width: size.width || null,
      height: size.height || null,
    };
  });
  return {
    format: "manhua_timeline_v2",
    story_id: pack.story_id,
    chapter_id: pack.chapter_id,
    title: pack.title,
    resolution: pack.resolution || "768p横",
    total_duration_sec: t,
    clips: items,
    jianying_hint:
      "优先用工作台「导出剪映草稿」生成 draft；也可把 clips 按序导入剪映，字幕用同目录 .srt，配音见 audio_file",
  };
}

export function writeSrtBesideTimeline(
  timeline: Record<string, unknown>,
  timelineFile: string,
): string {
  const clips = (timeline.clips as Array<{ start_sec: number; end_sec: number; dialogue?: string | null }>) || [];
  const body = buildSrtFromClips(clips);
  const chapterId = String(timeline.chapter_id || "CH01");
  const out = path.join(path.dirname(timelineFile), `${chapterId}.srt`);
  fs.writeFileSync(out, body, "utf8");
  return out;
}

/** 出片叠化转场时长（秒）：exportChapter 与配音叠轨共用，保证音画同轴。
 *  0.5 仍偏硬；跨场景硬切感强时用 ~0.8–1.0 更顺。真连续仍需 bridge 过渡片。 */
export const TRANSITION_SEC = 0.85;

/** 按镜头 TTS 音轨拼成整章配音，再叠到成片（保留画面，替换音轨）。
 *  transitionSec > 0 时按叠化时间轴对齐：第 i 段起点 = Σdur[0..i-1] − i×T（adelay+amix 混合）。 */
export function muxChapterDub(opts: {
  videoFile: string;
  outFile: string;
  clips: Array<{ duration_sec: number; audio_file?: string | null }>;
  transitionSec?: number;
  srtFile?: string | null;
}): { out_file: string; note: string } {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("配音叠轨需要 ffmpeg");
  if (!fs.existsSync(opts.videoFile)) throw new Error(`成片不存在: ${opts.videoFile}`);
  const t = Math.max(0, opts.transitionSec || 0);

  step("配音叠轨", "正在按镜头对齐 TTS 音轨");
  const work = path.join(path.dirname(opts.outFile), `_dub_work_${Date.now()}`);
  ensureDir(work);
  try {
    const parts: string[] = [];
    for (let i = 0; i < opts.clips.length; i++) {
      const c = opts.clips[i];
      const dur = Math.max(0.1, c.duration_sec || 5);
      const part = path.join(work, `a${String(i).padStart(3, "0")}.wav`);
      if (c.audio_file && fs.existsSync(c.audio_file)) {
        const r = spawnSync(
          ffmpeg,
          ["-y", "-i", c.audio_file, "-af", `apad=whole_dur=${dur}`, "-t", String(dur), "-ar", "44100", "-ac", "2", part],
          { encoding: "utf8" },
        );
        if (r.status !== 0) {
          fail("配音叠轨", `镜头音轨处理失败 #${i}`, { error: r.stderr || r.stdout });
          throw new Error(`镜头音轨失败 #${i}: ${r.stderr || r.stdout}`);
        }
      } else {
        const r = spawnSync(
          ffmpeg,
          ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", String(dur), part],
          { encoding: "utf8" },
        );
        if (r.status !== 0) {
          throw new Error(`静音垫失败 #${i}: ${r.stderr || r.stdout}`);
        }
      }
      parts.push(part);
    }

    const fullAudio = path.join(work, "full.wav");
    if (t > 0 && parts.length > 1) {
      // 叠化时间轴：各段 adelay 到 (Σdur − i×T)，amix 混合
      const inputs = parts.flatMap((p) => ["-i", p]);
      const filters: string[] = [];
      const labels: string[] = [];
      let offset = 0;
      for (let i = 0; i < parts.length; i++) {
        const ms = Math.max(0, Math.round(offset * 1000));
        filters.push(`[${i}:a]adelay=${ms}|${ms}[d${i}]`);
        labels.push(`[d${i}]`);
        offset += Math.max(0.1, opts.clips[i].duration_sec || 5) - t;
      }
      filters.push(`${labels.join("")}amix=inputs=${parts.length}:normalize=0[aout]`);
      const mix = spawnSync(
        ffmpeg,
        ["-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[aout]", "-c:a", "pcm_s16le", fullAudio],
        { encoding: "utf8" },
      );
      if (mix.status !== 0) {
        fail("配音叠轨", "音轨混合失败", { error: (mix.stderr || mix.stdout || "").slice(-300) });
        throw new Error(`音轨混合失败: ${(mix.stderr || mix.stdout || "").slice(-300)}`);
      }
    } else {
      const listFile = path.join(work, "concat.txt");
      fs.writeFileSync(
        listFile,
        parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
        "utf8",
      );
      const concat = spawnSync(
        ffmpeg,
        ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "pcm_s16le", fullAudio],
        { encoding: "utf8" },
      );
      if (concat.status !== 0) {
        fail("配音叠轨", "音轨拼接失败", { error: concat.stderr || concat.stdout });
        throw new Error(`音轨拼接失败: ${concat.stderr || concat.stdout}`);
      }
    }

    ensureDir(path.dirname(opts.outFile));
    const args = ["-y", "-i", opts.videoFile, "-i", fullAudio];
    if (opts.srtFile && fs.existsSync(opts.srtFile)) {
      // soft subtitle stream (mov_text)；剪映侧仍以独立 SRT 为准
      args.push("-i", opts.srtFile, "-map", "0:v:0", "-map", "1:a:0", "-map", "2:0", "-c:v", "copy", "-c:a", "aac", "-c:s", "mov_text", "-shortest");
    } else {
      args.push("-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest");
    }
    args.push(opts.outFile);
    const mux = spawnSync(ffmpeg, args, { encoding: "utf8" });
    if (mux.status !== 0) {
      // 字幕封装失败时退化为仅配音
      if (opts.srtFile) {
        warn("配音叠轨", "软字幕封装失败，改为仅替换音轨", { error: (mux.stderr || "").slice(0, 240) });
        const retry = spawnSync(
          ffmpeg,
          ["-y", "-i", opts.videoFile, "-i", fullAudio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", opts.outFile],
          { encoding: "utf8" },
        );
        if (retry.status !== 0) {
          fail("配音叠轨", "音视频合成失败", { error: retry.stderr || retry.stdout });
          throw new Error(`配音合成失败: ${retry.stderr || retry.stdout}`);
        }
      } else {
        fail("配音叠轨", "音视频合成失败", { error: mux.stderr || mux.stdout });
        throw new Error(`配音合成失败: ${mux.stderr || mux.stdout}`);
      }
    }
    ok("配音叠轨", "已生成带对白音轨成片", { out_file: opts.outFile });
    return { out_file: opts.outFile, note: "已用 TTS 替换成片音轨" };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** 调用 scripts/export_jianying_draft.py 生成剪映草稿目录 */
export function exportJianyingDraft(opts: {
  timelineFile: string;
  draftDir?: string;
  draftName?: string;
  srtFile?: string;
}): { ok: boolean; draft_path?: string; draft_name?: string; note: string; raw?: string } {
  const python = findPython();
  if (!python) {
    fail("剪映草稿", "未找到 python");
    throw new Error("导出剪映草稿需要本机 Python，并 pip install pyJianYingDraft");
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dsh-manhua/src/production → repo root
  const repoRoot = path.resolve(here, "../../..");
  const scriptPath = path.join(repoRoot, "scripts", "export_jianying_draft.py");
  if (!fs.existsSync(scriptPath)) {
    fail("剪映草稿", "缺少 scripts/export_jianying_draft.py", { scriptPath });
    throw new Error(`找不到剪映导出脚本: ${scriptPath}`);
  }

  step("剪映草稿", "正在生成草稿", { timeline: opts.timelineFile });
  const args = [scriptPath, "--timeline", opts.timelineFile];
  if (opts.draftDir) args.push("--draft-dir", opts.draftDir);
  if (opts.draftName) args.push("--name", opts.draftName);
  if (opts.srtFile) args.push("--srt", opts.srtFile);

  const result = spawnSync(python, args, { encoding: "utf8" });
  const raw = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.status !== 0) {
    fail("剪映草稿", "脚本执行失败", { error: raw.slice(0, 500) });
    throw new Error(`剪映草稿失败: ${raw.slice(0, 400)}`);
  }
  let parsed: { draft_path?: string; draft_name?: string } = {};
  const lines = (result.stdout || "").trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      parsed = JSON.parse(lines[i]);
      break;
    } catch {
      /* continue */
    }
  }
  ok("剪映草稿", "草稿已生成", { draft_path: parsed.draft_path });
  return {
    ok: true,
    draft_path: parsed.draft_path,
    draft_name: parsed.draft_name,
    note: parsed.draft_path
      ? `草稿目录：${parsed.draft_path}（可拷到剪映草稿位置打开）`
      : "脚本已执行",
    raw,
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
