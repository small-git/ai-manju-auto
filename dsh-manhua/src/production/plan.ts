import type { StoryPack } from "../story.js";
import { saveStory } from "../story.js";

export type PlanPath = "video_ref" | "bridge" | "grid" | "lipsync";

export type ShotPlanRow = {
  shot_id: string;
  plan_path: PlanPath;
  bridge_from: string | null;
  needs_lipsync: boolean;
  dialogue: string | null;
  environment_id: string;
  notes?: string;
};

export function resolvePlanPath(shot: StoryPack["shots"][number]): PlanPath {
  const raw = String(shot.plan_path || "").trim();
  if (raw === "bridge" || raw === "grid" || raw === "lipsync" || raw === "video_ref") return raw;
  if (shot.needs_lipsync) return "lipsync";
  if (shot.bridge_from) return "bridge";
  return "video_ref";
}

/** 全章计划预审表 */
export function buildChapterPlan(pack: StoryPack): ShotPlanRow[] {
  return pack.shots.map((sh) => ({
    shot_id: sh.shot_id,
    plan_path: resolvePlanPath(sh),
    bridge_from: (sh.bridge_from as string | null | undefined) || null,
    needs_lipsync: !!sh.needs_lipsync,
    dialogue: (sh.dialogue as string | null | undefined) || null,
    environment_id: sh.environment_id,
    notes: typeof sh.plan_notes === "string" ? sh.plan_notes : undefined,
  }));
}

export function setShotPlan(
  pack: StoryPack,
  shotId: string,
  plan: { plan_path?: PlanPath; bridge_from?: string | null; needs_lipsync?: boolean; plan_notes?: string },
  filePath?: string,
): StoryPack {
  const shot = pack.shots.find((s) => s.shot_id === shotId);
  if (!shot) throw new Error(`unknown shot_id: ${shotId}`);
  if (plan.plan_path) shot.plan_path = plan.plan_path;
  if (plan.bridge_from !== undefined) shot.bridge_from = plan.bridge_from;
  if (plan.needs_lipsync !== undefined) shot.needs_lipsync = plan.needs_lipsync;
  if (plan.plan_notes !== undefined) shot.plan_notes = plan.plan_notes;
  if (filePath) saveStory(pack, filePath);
  return pack;
}

/**
 * 自动 bridge 编排：相邻镜同场景且无硬切 → 填 bridge_from。
 * segment_break / hard_cut 为 true 时跳过。
 */
export function autoBridgeChapter(pack: StoryPack, filePath?: string): {
  pack: StoryPack;
  updated: string[];
} {
  const updated: string[] = [];
  for (let i = 1; i < pack.shots.length; i++) {
    const prev = pack.shots[i - 1];
    const cur = pack.shots[i];
    if (cur.segment_break || cur.hard_cut) continue;
    if (cur.environment_id !== prev.environment_id) continue;
    if (cur.bridge_from) continue;
    if (resolvePlanPath(cur) === "lipsync") continue;
    cur.bridge_from = prev.shot_id;
    if (!cur.plan_path || cur.plan_path === "video_ref") cur.plan_path = "bridge";
    updated.push(cur.shot_id);
  }
  if (filePath) saveStory(pack, filePath);
  return { pack, updated };
}

/** 默认 steps：有 bridge/lipsync 计划时自动展开 */
export function resolveSteps(pack: StoryPack): Array<"video" | "bridge" | "lipsync"> {
  const configured = (pack.steps || ["video"]) as Array<"video" | "bridge" | "lipsync">;
  if (configured.length > 1 || configured[0] !== "video") return configured;
  const hasBridge = pack.shots.some((s) => resolvePlanPath(s) === "bridge" || s.bridge_from);
  const hasLipsync = pack.shots.some((s) => resolvePlanPath(s) === "lipsync" || s.needs_lipsync);
  const steps: Array<"video" | "bridge" | "lipsync"> = ["video"];
  if (hasBridge) steps.push("bridge");
  if (hasLipsync) steps.push("lipsync");
  return steps;
}
