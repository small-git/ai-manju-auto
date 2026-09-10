/**
 * 漫剧工作台 — P0–P3 全模块 API
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RUNS_DIR, STORIES_DIR, ensureDir } from "../paths.js";
import { getProp, loadStory, listStyleLocks, saveStory, type StoryPack } from "../story.js";
import {
  approveTool,
  assetDirs,
  autodlVideoRef,
  autoBridgeTool,
  buildChapterPlan,
  characterSheetGpt,
  checkChapterReady,
  expandStoryTool,
  gateCheckTool,
  keysSetSettingsTool,
  keysSetTool,
  keysProbeTool,
  keysStatusTool,
  keysUnsetTool,
  listShotVideoFiles,
  loadManifest,
  planUpdateTool,
  promptPreviewTool,
  providersTool,
  resolveSelectedVideo,
  runChapterPipeline,
  selectGridCellTool,
  selectVersionTool,
  setStyleLockTool,
  shotStillGemini,
  shotTts,
  storyLoad,
  timelineExportTool,
  zipExportTool,
  zipImportTool,
  writingAdoptTool,
  writingApplySynopsisTool,
  writingExpandEpisodeTool,
  writingGenerateTool,
  writingGetTool,
  writingSeedTool,
} from "../tools/core.js";
import { resolvePlanPath } from "../production/plan.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.MANHUA_WORKBENCH_PORT || 3780);
const HOST = process.env.MANHUA_WORKBENCH_HOST || "127.0.0.1";

type Json = Record<string, unknown>;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res: http.ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function readJson(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Json;
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mp3") return "audio/mpeg";
  return "application/octet-stream";
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, "Not Found", "text/plain; charset=utf-8");
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function isHttp(url?: string | null): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

function mediaUrl(_storyId: string, absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  if (isHttp(absPath)) return absPath;
  const runsRoot = path.resolve(RUNS_DIR);
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(runsRoot + path.sep) && resolved !== runsRoot) return null;
  const rel = path.relative(runsRoot, resolved).replace(/\\/g, "/");
  return `/api/media/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

function resolveStillPreview(pack: StoryPack, dirs: ReturnType<typeof assetDirs>, shot: StoryPack["shots"][number]): string | null {
  const manifest = loadManifest(pack, dirs);
  const entry = manifest.shots[shot.shot_id];
  if (entry?.selected_still) {
    const versioned = path.join(dirs.assets, shot.shot_id, "stills", `${entry.selected_still}.png`);
    if (fs.existsSync(versioned)) return mediaUrl(pack.story_id, versioned);
    const alt = path.join(dirs.assets, shot.shot_id, "stills", `${entry.selected_still}.jpg`);
    if (fs.existsSync(alt)) return mediaUrl(pack.story_id, alt);
  }
  if (entry?.grid_path && fs.existsSync(entry.grid_path)) return mediaUrl(pack.story_id, entry.grid_path);
  if (isHttp(shot.still_url)) return shot.still_url!;
  if (shot.still_url && fs.existsSync(shot.still_url)) return mediaUrl(pack.story_id, shot.still_url);
  const stillLocal = path.join(dirs.assets, `${shot.shot_id}_still.png`);
  if (fs.existsSync(stillLocal)) return mediaUrl(pack.story_id, stillLocal);
  const gridLocal = path.join(dirs.assets, `${shot.shot_id}_grid.png`);
  if (fs.existsSync(gridLocal)) return mediaUrl(pack.story_id, gridLocal);
  return null;
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, "Not Found", "text/plain; charset=utf-8");
    return;
  }
  serveFile(res, filePath);
}

function listStories() {
  if (!fs.existsSync(STORIES_DIR)) return [];
  return fs
    .readdirSync(STORIES_DIR)
    .filter((name) => fs.existsSync(path.join(STORIES_DIR, name, "story.json")))
    .map((name) => {
      try {
        const pack = JSON.parse(fs.readFileSync(path.join(STORIES_DIR, name, "story.json"), "utf8")) as StoryPack;
        return {
          story_id: pack.story_id || name,
          title: pack.title,
          chapter_id: pack.chapter_id,
          style_lock: pack.style_lock,
          characters: pack.characters?.length || 0,
          props: pack.props?.length || 0,
          shots: pack.shots?.length || 0,
        };
      } catch {
        return { story_id: name, title: name, characters: 0, props: 0, shots: 0 };
      }
    });
}

function boardForStory(storyId: string) {
  const { pack, path: storyPath } = loadStory(storyId);
  const dirs = assetDirs(pack);
  const gate = checkChapterReady(pack);
  const plan = buildChapterPlan(pack);
  const manifest = loadManifest(pack, dirs);
  const gateByShot = Object.fromEntries(gate.shots.map((s) => [s.shot_id, s]));

  const characters = pack.characters.map((ch) => {
    const sheet = ch.ref_images?.sheet || "";
    const localGuess = path.join(dirs.assets, `${ch.id}_sheet.png`);
    const localExists = fs.existsSync(localGuess);
    return {
      id: ch.id,
      name: ch.name,
      role: ch.role || "",
      sheet_url: sheet || null,
      sheet_ready: !!(sheet || localExists),
      sheet_is_public: isHttp(sheet),
      approved: ch.approved !== false,
      local_path: localExists ? localGuess : sheet && !isHttp(sheet) ? sheet : null,
      identity_lock: ch.identity_lock,
    };
  });

  const props = (pack.props || []).map((p) => {
    const sheet = p.ref_images?.sheet || "";
    return {
      id: p.id,
      name: p.name,
      clue_lock: p.clue_lock,
      sheet_url: sheet || null,
      sheet_ready: !!sheet,
      sheet_is_public: isHttp(sheet),
    };
  });

  const shots = pack.shots.map((sh) => {
    const still = sh.still_url || "";
    const stillLocal = path.join(dirs.assets, `${sh.shot_id}_still.png`);
    const stillExists = fs.existsSync(stillLocal) || (still && !isHttp(still) && fs.existsSync(still));
    const videos = listShotVideoFiles(dirs, sh.shot_id);
    const selected = resolveSelectedVideo(pack, dirs, sh.shot_id);
    const g = gateByShot[sh.shot_id];
    const versions = manifest.shots[sh.shot_id] || null;
    const cam = (sh.camera || {}) as Record<string, string>;
    return {
      shot_id: sh.shot_id,
      environment_id: sh.environment_id,
      character_ids: sh.character_ids,
      prop_ids: sh.prop_ids || [],
      action: sh.action,
      duration: sh.duration || 5,
      emotion: sh.emotion || "",
      dialogue: sh.dialogue || null,
      camera: {
        shot_size: cam.shot_size || "",
        angle: cam.angle || "",
        move: cam.move || "",
      },
      plan_path: resolvePlanPath(sh),
      bridge_from: sh.bridge_from || null,
      needs_lipsync: !!sh.needs_lipsync,
      still_url: still || null,
      still_preview: resolveStillPreview(pack, dirs, sh),
      still_ready: !!(still || stillExists),
      still_is_public: isHttp(still),
      still_approved: sh.still_approved !== false,
      video_approved: sh.video_approved !== false,
      video_files: videos,
      video_ready: videos.length > 0,
      video_latest: selected,
      gate_ready: !!g?.ready,
      gate_issues: g?.issues || [],
      versions,
      grid_cell: sh.grid_cell || null,
      grid_preview:
        versions?.grid_path && fs.existsSync(String(versions.grid_path))
          ? mediaUrl(pack.story_id, String(versions.grid_path))
          : fs.existsSync(path.join(dirs.assets, `${sh.shot_id}_grid.png`))
            ? mediaUrl(pack.story_id, path.join(dirs.assets, `${sh.shot_id}_grid.png`))
            : null,
    };
  });

  const exportFile = path.join(dirs.exportDir, `${pack.chapter_id}_chapter_cut.mp4`);
  const timelineFile = path.join(dirs.exportDir, `${pack.chapter_id}_timeline.json`);
  const readySheets = characters.filter((c) => c.sheet_ready && c.approved).length;
  const readyStills = shots.filter((s) => s.still_ready && s.still_approved).length;
  const readyVideos = shots.filter((s) => s.video_ready).length;
  const readyGate = shots.filter((s) => s.gate_ready).length;

  return {
    ok: true,
    story_id: pack.story_id,
    chapter_id: pack.chapter_id,
    title: pack.title,
    style_lock: pack.style_lock,
    path: storyPath,
    resolution: pack.resolution || "768p横",
    logline: (pack.script as { logline?: string }).logline,
    directories: dirs,
    style_locks: listStyleLocks(),
    summary: {
      characters: characters.length,
      props: props.length,
      shots: shots.length,
      sheets_ready: readySheets,
      stills_ready: readyStills,
      videos_ready: readyVideos,
      gate_ready: readyGate,
      export_ready: fs.existsSync(exportFile),
      timeline_ready: fs.existsSync(timelineFile),
    },
    characters,
    props,
    shots,
    plan,
    gate,
    environments: pack.environments.map((e) => ({
      id: e.id,
      name: e.name,
      establishing: e.ref_images?.establishing || null,
    })),
    export: {
      file: fs.existsSync(exportFile) ? exportFile : null,
      timeline: fs.existsSync(timelineFile) ? timelineFile : null,
      ready: fs.existsSync(exportFile),
      missing_shots: shots.filter((s) => !s.video_ready).map((s) => s.shot_id),
    },
  };
}

async function boardAsync(storyId: string) {
  const board = boardForStory(storyId);
  const providers = await providersTool();
  return { ...board, providers: providers.providers, style_locks: providers.style_locks || board.style_locks };
}

function findFfmpeg(): string {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], {
    encoding: "utf8",
  });
  const line = (which.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (line && fs.existsSync(line)) return line;
  const guess = "C:\\ffmpeg-2026-06-29-git-de6bcf5c05-full_build\\bin\\ffmpeg.exe";
  if (fs.existsSync(guess)) return guess;
  throw new Error("未找到 ffmpeg，无法出片拼接");
}

function exportChapter(storyId: string) {
  const { pack } = loadStory(storyId);
  const dirs = assetDirs(pack);
  const board = boardForStory(storyId);
  const missing = board.export.missing_shots;
  if (missing.length) {
    throw new Error(`以下镜头还没有成片，无法出片：${missing.join(", ")}`);
  }
  const files = board.shots.map((s) => s.video_latest!).filter(Boolean);
  ensureDir(dirs.exportDir);
  const listFile = path.join(dirs.exportDir, `${pack.chapter_id}_concat.txt`);
  const outFile = path.join(dirs.exportDir, `${pack.chapter_id}_chapter_cut.mp4`);
  const listBody = files.map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(listFile, listBody, "utf8");
  const ffmpeg = findFfmpeg();
  const result = spawnSync(
    ffmpeg,
    ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outFile],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg 出片失败：${result.stderr || result.stdout || "unknown"}`);
  }
  return {
    ok: true,
    story_id: pack.story_id,
    chapter_id: pack.chapter_id,
    files_used: files,
    export_file: outFile,
    note: "已按镜头顺序拼接成章",
  };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  const method = req.method || "GET";
  try {
    if (method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true, name: "漫剧工作台", port: PORT });
      return;
    }
    if (method === "GET" && pathname.startsWith("/api/media/")) {
      const rel = decodeURIComponent(pathname.slice("/api/media/".length));
      const filePath = path.resolve(RUNS_DIR, rel);
      const root = path.resolve(RUNS_DIR);
      if (!filePath.startsWith(root + path.sep)) {
        sendJson(res, 403, { ok: false, error: "forbidden" });
        return;
      }
      serveFile(res, filePath);
      return;
    }
    if (method === "GET" && pathname === "/api/keys") {
      sendJson(res, 200, await keysStatusTool());
      return;
    }
    if (method === "POST" && pathname === "/api/keys") {
      const body = await readJson(req);
      sendJson(res, 200, await keysSetTool({ provider: String(body.provider || ""), value: String(body.value || "") }));
      return;
    }
    if (method === "DELETE" && pathname.startsWith("/api/keys/")) {
      sendJson(res, 200, await keysUnsetTool({ provider: decodeURIComponent(pathname.slice("/api/keys/".length)) }));
      return;
    }
    if (method === "POST" && pathname === "/api/keys/probe") {
      const body = await readJson(req);
      try {
        sendJson(res, 200, await keysProbeTool({ provider: String(body.provider || "") }));
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (method === "POST" && pathname === "/api/settings") {
      const body = await readJson(req);
      sendJson(
        res,
        200,
        await keysSetSettingsTool({
          autodl_base_url: body.autodl_base_url != null ? String(body.autodl_base_url) : undefined,
          openai_base_url: body.openai_base_url != null ? String(body.openai_base_url) : undefined,
          gemini_base_url: body.gemini_base_url != null ? String(body.gemini_base_url) : undefined,
          openai_image_model: body.openai_image_model != null ? String(body.openai_image_model) : undefined,
          openai_chat_model: body.openai_chat_model != null ? String(body.openai_chat_model) : undefined,
          gemini_image_model: body.gemini_image_model != null ? String(body.gemini_image_model) : undefined,
          default_resolution: body.default_resolution ? String(body.default_resolution) : undefined,
          video_workflow_id: body.video_workflow_id != null ? String(body.video_workflow_id) : undefined,
          public_asset_base_url: body.public_asset_base_url != null ? String(body.public_asset_base_url) : undefined,
        }),
      );
      return;
    }
    if (method === "GET" && pathname === "/api/stories") {
      sendJson(res, 200, { ok: true, stories: listStories() });
      return;
    }
    if (method === "GET" && pathname.startsWith("/api/board/")) {
      const storyId = decodeURIComponent(pathname.slice("/api/board/".length));
      sendJson(res, 200, await boardAsync(storyId));
      return;
    }
    if (method === "GET" && pathname.startsWith("/api/stories/")) {
      sendJson(res, 200, await storyLoad({ story_id: decodeURIComponent(pathname.slice("/api/stories/".length)) }));
      return;
    }
    if (method === "POST" && pathname === "/api/sheet") {
      const body = await readJson(req);
      const result = await characterSheetGpt({
        story_id: String(body.story_id || ""),
        character_id: String(body.character_id || ""),
        size: body.size ? String(body.size) : undefined,
      });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "POST" && pathname === "/api/still") {
      const body = await readJson(req);
      const result = await shotStillGemini({
        story_id: String(body.story_id || ""),
        shot_id: String(body.shot_id || ""),
        as_grid: !!body.as_grid,
      });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "POST" && pathname === "/api/grid-cell") {
      const body = await readJson(req);
      const result = await selectGridCellTool({
        story_id: String(body.story_id || ""),
        shot_id: String(body.shot_id || ""),
        cell: Number(body.cell),
      });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "POST" && pathname === "/api/video") {
      const body = await readJson(req);
      const result = await autodlVideoRef({
        story_id: String(body.story_id || ""),
        shot_id: String(body.shot_id || ""),
        duration: body.duration != null ? Number(body.duration) : undefined,
        resolution: body.resolution ? String(body.resolution) : undefined,
        workflow_id: body.workflow_id ? String(body.workflow_id) : undefined,
        force: !!body.force,
      });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "POST" && pathname === "/api/pipeline") {
      const body = await readJson(req);
      const result = await runChapterPipeline({
        story_id: String(body.story_id || ""),
        force: !!body.force,
        shot_ids: Array.isArray(body.shot_ids) ? body.shot_ids.map(String) : undefined,
      });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "POST" && pathname === "/api/tts") {
      const body = await readJson(req);
      const result = await shotTts({
        story_id: String(body.story_id || ""),
        shot_id: String(body.shot_id || ""),
        voice: body.voice ? String(body.voice) : undefined,
      });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "GET" && pathname.startsWith("/api/gate/")) {
      sendJson(res, 200, await gateCheckTool({ story_id: decodeURIComponent(pathname.slice("/api/gate/".length)) }));
      return;
    }
    if (method === "POST" && pathname === "/api/plan") {
      const body = await readJson(req);
      const result = await planUpdateTool({
        story_id: String(body.story_id || ""),
        shot_id: String(body.shot_id || ""),
        plan_path: body.plan_path as "video_ref" | "bridge" | "grid" | "lipsync" | undefined,
        bridge_from: body.bridge_from != null ? String(body.bridge_from) : undefined,
        needs_lipsync: body.needs_lipsync != null ? !!body.needs_lipsync : undefined,
        plan_notes: body.plan_notes ? String(body.plan_notes) : undefined,
      });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "POST" && pathname === "/api/auto-bridge") {
      const body = await readJson(req);
      const result = await autoBridgeTool({ story_id: String(body.story_id || "") });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "POST" && pathname === "/api/approve") {
      const body = await readJson(req);
      const result = await approveTool({
        story_id: String(body.story_id || ""),
        kind: body.kind as "character" | "still" | "video",
        id: String(body.id || ""),
        approved: !!body.approved,
      });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "POST" && pathname === "/api/select-version") {
      const body = await readJson(req);
      const result = await selectVersionTool({
        story_id: String(body.story_id || ""),
        shot_id: String(body.shot_id || ""),
        kind: body.kind as "still" | "video",
        version: String(body.version || ""),
      });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "POST" && pathname === "/api/prompt-preview") {
      const body = await readJson(req);
      sendJson(
        res,
        200,
        await promptPreviewTool({ story_id: String(body.story_id || ""), shot_id: String(body.shot_id || "") }),
      );
      return;
    }
    if (method === "POST" && pathname === "/api/prop") {
      const body = await readJson(req);
      const storyId = String(body.story_id || "");
      const { pack, path: storyPath } = loadStory(storyId);
      const propId = String(body.prop_id || "");
      const prop = getProp(pack, propId);
      if (body.sheet_url) {
        prop.ref_images = { ...(prop.ref_images || {}), sheet: String(body.sheet_url) };
        saveStory(pack, storyPath);
      }
      sendJson(res, 200, { ok: true, prop, board: await boardAsync(storyId) });
      return;
    }
    if (method === "POST" && pathname === "/api/export") {
      const body = await readJson(req);
      sendJson(res, 200, exportChapter(String(body.story_id || "")));
      return;
    }
    if (method === "POST" && pathname === "/api/timeline") {
      const body = await readJson(req);
      sendJson(res, 200, await timelineExportTool({ story_id: String(body.story_id || "") }));
      return;
    }
    if (method === "POST" && pathname === "/api/zip-export") {
      const body = await readJson(req);
      sendJson(res, 200, await zipExportTool({ story_id: String(body.story_id || "") }));
      return;
    }
    if (method === "POST" && pathname === "/api/zip-import") {
      const body = await readJson(req);
      sendJson(res, 200, await zipImportTool({ zip_path: String(body.zip_path || "") }));
      return;
    }
    if (method === "POST" && pathname === "/api/expand-story") {
      const body = await readJson(req);
      const result = await expandStoryTool({
        story_id: String(body.story_id || ""),
        logline: String(body.logline || ""),
        synopsis: String(body.synopsis || ""),
        title: body.title ? String(body.title) : undefined,
        style_lock: body.style_lock ? String(body.style_lock) : undefined,
      });
      sendJson(res, 200, result);
      return;
    }
    if (method === "GET" && pathname.startsWith("/api/writing/")) {
      const storyId = decodeURIComponent(pathname.slice("/api/writing/".length));
      sendJson(res, 200, await writingGetTool({ story_id: storyId }));
      return;
    }
    if (method === "POST" && pathname === "/api/writing/seed") {
      const body = await readJson(req);
      sendJson(
        res,
        200,
        await writingSeedTool({
          story_id: String(body.story_id || ""),
          source_text: String(body.source_text || ""),
          title: body.title ? String(body.title) : undefined,
          logline: body.logline ? String(body.logline) : undefined,
        }),
      );
      return;
    }
    if (method === "POST" && pathname === "/api/writing/generate") {
      const body = await readJson(req);
      sendJson(
        res,
        200,
        await writingGenerateTool({
          story_id: String(body.story_id || ""),
          kind: String(body.kind || "continue") as "continue" | "twist" | "revise",
          instruction: body.instruction ? String(body.instruction) : undefined,
          target_chars: body.target_chars != null ? Number(body.target_chars) : undefined,
        }),
      );
      return;
    }
    if (method === "POST" && pathname === "/api/writing/adopt") {
      const body = await readJson(req);
      sendJson(
        res,
        200,
        await writingAdoptTool({
          story_id: String(body.story_id || ""),
          draft_id: body.draft_id ? String(body.draft_id) : undefined,
          mode: body.mode === "append" ? "append" : "replace",
        }),
      );
      return;
    }
    if (method === "POST" && pathname === "/api/writing/apply-synopsis") {
      const body = await readJson(req);
      const result = await writingApplySynopsisTool({
        story_id: String(body.story_id || ""),
        draft_id: body.draft_id ? String(body.draft_id) : undefined,
      });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "POST" && pathname === "/api/writing/expand-episode") {
      const body = await readJson(req);
      const result = await writingExpandEpisodeTool({
        story_id: String(body.story_id || ""),
        draft_id: body.draft_id ? String(body.draft_id) : undefined,
        instruction: body.instruction ? String(body.instruction) : undefined,
        create_if_missing: body.create_if_missing !== false,
        title: body.title ? String(body.title) : undefined,
        style_lock: body.style_lock ? String(body.style_lock) : undefined,
      });
      let board = null;
      try {
        board = await boardAsync(String(body.story_id));
      } catch {
        /* ignore */
      }
      sendJson(res, 200, { ...result, board });
      return;
    }
    if (method === "POST" && pathname === "/api/style-lock") {
      const body = await readJson(req);
      const result = await setStyleLockTool({
        story_id: String(body.story_id || ""),
        style_lock: String(body.style_lock || ""),
      });
      sendJson(res, 200, { ...result, board: await boardAsync(String(body.story_id)) });
      return;
    }
    if (method === "POST" && pathname === "/api/providers") {
      const body = await readJson(req);
      sendJson(
        res,
        200,
        await providersTool({
          sheet: body.sheet as "openai" | "gemini" | undefined,
          still: body.still as "openai" | "gemini" | undefined,
        }),
      );
      return;
    }
    sendJson(res, 404, { ok: false, error: `未知接口: ${method} ${pathname}` });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    void handleApi(req, res, url.pathname);
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`[漫剧工作台] http://${HOST}:${PORT}`);
  console.log(`[漫剧工作台] 模块：密钥/文案/故事/定妆/道具/分镜/计划/成片/画布/出片`);
});
