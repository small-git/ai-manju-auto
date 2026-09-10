import fs from "node:fs";
import path from "node:path";
import { ensureDir, loadConfig, sleep } from "../config.js";
import { requireKey } from "../keys.js";

export type AutodlVideoResult = {
  taskId: string;
  status: string;
  files: string[];
  results: unknown;
  workflowId: string;
  requestBody: Record<string, unknown>;
};

async function headers(): Promise<Record<string, string>> {
  const token = await requireKey("autodl");
  return {
    Authorization: token,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export async function submitWorkflow(
  workflowId: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const cfg = loadConfig();
  const url = `${cfg.autodlBaseUrl}/api/v1/comfyui/comfyui_workflow/${workflowId}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify(body),
    signal,
  });
  const data = (await resp.json()) as {
    code?: string;
    data?: { task_id?: string };
    msg?: string;
  };
  if (!resp.ok || (data.code && String(data.code).toLowerCase() !== "success")) {
    throw new Error(`AutoDL submit failed: ${JSON.stringify(data)}`);
  }
  const taskId = data.data?.task_id;
  if (!taskId) throw new Error(`AutoDL missing task_id: ${JSON.stringify(data)}`);
  return taskId;
}

export async function waitResult(taskId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const deadline = Date.now() + cfg.pollTimeoutSec * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    const url = `${cfg.autodlBaseUrl}/api/v1/comfyui/comfyui_workflow/result/${taskId}`;
    const resp = await fetch(url, { headers: await headers(), signal });
    const json = (await resp.json()) as { data?: Record<string, unknown>; code?: string };
    const data = (json.data || json) as Record<string, unknown>;
    const status = String(data.status || "").toUpperCase();
    process.stdout.write(`task=${taskId} status=${status} duration=${data.duration}\n`);
    if (["SUCCESS", "COMPLETED", "DONE"].includes(status)) return data;
    if (["FAILED", "ERROR", "CANCELLED"].includes(status)) {
      throw new Error(`AutoDL task failed: ${JSON.stringify(data)}`);
    }
    await sleep(cfg.pollIntervalSec * 1000);
  }
  throw new Error(`AutoDL poll timeout task_id=${taskId}`);
}

async function download(url: string, dest: string, signal?: AbortSignal): Promise<string> {
  ensureDir(path.dirname(dest));
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`download HTTP ${resp.status}: ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

export async function downloadResults(
  data: Record<string, unknown>,
  outDir: string,
  stem: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const results = (data.results as Array<string | { url?: string; file_type?: string }>) || [];
  const saved: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const url = typeof item === "string" ? item : item.url;
    if (!url) continue;
    let ext = ".bin";
    try {
      ext = path.extname(new URL(url).pathname) || (typeof item === "object" && item.file_type ? `.${item.file_type}` : ".mp4");
    } catch {
      ext = ".mp4";
    }
    const dest = path.join(outDir, `${stem}_${i}${ext}`);
    saved.push(await download(url, dest, signal));
  }
  return saved;
}

async function runAndDownload(opts: {
  storyId: string;
  shotId: string;
  workflowId: string;
  body: Record<string, unknown>;
  outDir: string;
  stem?: string;
  signal?: AbortSignal;
}): Promise<AutodlVideoResult> {
  const taskId = await submitWorkflow(opts.workflowId, opts.body, opts.signal);
  const data = await waitResult(taskId, opts.signal);
  ensureDir(opts.outDir);
  const stem = opts.stem || opts.shotId;
  const files = await downloadResults(data, opts.outDir, stem, opts.signal);
  const meta = {
    story_id: opts.storyId,
    shot_id: opts.shotId,
    workflow_id: opts.workflowId,
    task_id: taskId,
    request_body: opts.body,
    status: data.status,
    duration: data.duration,
    results: data.results,
    files,
  };
  fs.writeFileSync(path.join(opts.outDir, `${stem}_meta.json`), JSON.stringify(meta, null, 2), "utf8");
  return {
    taskId,
    status: String(data.status),
    files,
    results: data.results,
    workflowId: opts.workflowId,
    requestBody: opts.body,
  };
}

export async function runMultiRefVideo(opts: {
  storyId: string;
  shotId: string;
  prompt: string;
  refImages: string[];
  duration?: number;
  resolution?: string;
  workflowId?: string;
  outDir: string;
  signal?: AbortSignal;
}): Promise<AutodlVideoResult> {
  const cfg = loadConfig();
  const refs = opts.refImages.filter((u) => !!u && u.trim());
  if (!refs.length) {
    throw new Error("autodl.video_ref 需要至少 1 张公网参考图 URL（定妆/静帧）");
  }
  if (refs.some((u) => u === "")) {
    throw new Error("禁止空字符串占位 ref 槽");
  }

  const workflowId = opts.workflowId || cfg.defaultVideoWorkflowId;
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    duration: opts.duration ?? 5,
    resolution: opts.resolution || cfg.defaultResolution,
  };
  refs.slice(0, 9).forEach((url, i) => {
    body[`ref_image_${i}`] = url;
  });

  return runAndDownload({
    storyId: opts.storyId,
    shotId: opts.shotId,
    workflowId,
    body,
    outDir: opts.outDir,
    signal: opts.signal,
  });
}

/** 首尾帧衔接 manhua_bridge → minimax_h3_lightx2v */
export async function runBridgeVideo(opts: {
  storyId: string;
  shotId: string;
  prompt: string;
  firstFrame: string;
  lastFrame: string;
  duration?: number;
  resolution?: string;
  workflowId?: string;
  outDir: string;
  signal?: AbortSignal;
}): Promise<AutodlVideoResult> {
  const cfg = loadConfig();
  if (!opts.firstFrame || !opts.lastFrame) {
    throw new Error("bridge 需要 first_frame 与 last_frame 公网 URL");
  }
  const workflowId = opts.workflowId || process.env.AUTODL_BRIDGE_WORKFLOW_ID || "minimax_h3_lightx2v";
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    duration: opts.duration ?? 5,
    resolution: opts.resolution || cfg.defaultResolution,
    first_frame: opts.firstFrame,
    last_frame: opts.lastFrame,
  };
  return runAndDownload({
    storyId: opts.storyId,
    shotId: opts.shotId,
    workflowId,
    body,
    outDir: opts.outDir,
    stem: `${opts.shotId}_bridge`,
    signal: opts.signal,
  });
}

/** 对口型 manhua_lipsync → minimax_h3_image_audio_to_video */
export async function runLipsyncVideo(opts: {
  storyId: string;
  shotId: string;
  prompt: string;
  imageUrl: string;
  audioUrl: string;
  duration?: number;
  resolution?: string;
  workflowId?: string;
  outDir: string;
  signal?: AbortSignal;
}): Promise<AutodlVideoResult> {
  const cfg = loadConfig();
  if (!opts.imageUrl || !opts.audioUrl) {
    throw new Error("lipsync 需要 image + audio 公网 URL");
  }
  const workflowId =
    opts.workflowId || process.env.AUTODL_LIPSYNC_WORKFLOW_ID || "minimax_h3_image_audio_to_video";
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    duration: opts.duration ?? 5,
    resolution: opts.resolution || cfg.defaultResolution,
    image: opts.imageUrl,
    audio: opts.audioUrl,
  };
  return runAndDownload({
    storyId: opts.storyId,
    shotId: opts.shotId,
    workflowId,
    body,
    outDir: opts.outDir,
    stem: `${opts.shotId}_lipsync`,
    signal: opts.signal,
  });
}
