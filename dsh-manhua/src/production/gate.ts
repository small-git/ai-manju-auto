import type { StoryPack } from "../story.js";
import { getCharacter, getEnvironment, getProp } from "../story.js";

export type GateIssue = {
  level: "error" | "warn";
  code: string;
  shot_id?: string;
  character_id?: string;
  prop_id?: string;
  message: string;
};

function isHttp(url?: string | null): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

/** 成片前齐套检查：缺公网资产 / 未审批 / 空串槽 → error */
export function checkShotReady(pack: StoryPack, shotId: string): GateIssue[] {
  const shot = pack.shots.find((s) => s.shot_id === shotId);
  if (!shot) return [{ level: "error", code: "unknown_shot", shot_id: shotId, message: `未知镜头 ${shotId}` }];

  const issues: GateIssue[] = [];
  const plan = String(shot.plan_path || "video_ref");

  for (const cid of shot.character_ids || []) {
    const ch = getCharacter(pack, cid);
    const sheet = ch.ref_images?.sheet;
    if (!isHttp(sheet)) {
      issues.push({
        level: "error",
        code: "missing_sheet",
        shot_id: shotId,
        character_id: cid,
        message: `角色 ${cid} 缺少公网定妆 sheet`,
      });
    }
    if (ch.approved === false) {
      issues.push({
        level: "error",
        code: "sheet_unapproved",
        shot_id: shotId,
        character_id: cid,
        message: `角色 ${cid} 定妆尚未批准`,
      });
    }
  }

  const strictProps = !!(pack as { strict_props?: boolean }).strict_props;
  for (const pid of shot.prop_ids || []) {
    try {
      const prop = getProp(pack, pid);
      const sheet = prop.ref_images?.sheet;
      if (!isHttp(sheet)) {
        issues.push({
          // 默认 warn：道具可后补；story.strict_props=true 时硬拦
          level: strictProps ? "error" : "warn",
          code: "missing_prop_sheet",
          shot_id: shotId,
          prop_id: pid,
          message: `道具 ${pid} 缺少公网 sheet${strictProps ? "" : "（warn；设 strict_props 可硬拦）"}`,
        });
      }
    } catch {
      issues.push({
        level: "error",
        code: "unknown_prop",
        shot_id: shotId,
        prop_id: pid,
        message: `未知道具 ${pid}`,
      });
    }
  }

  const env = getEnvironment(pack, shot.environment_id);
  const est = env.ref_images?.establishing;
  if (!isHttp(shot.still_url) && !isHttp(est) && !(shot.ref_images || []).some(isHttp)) {
    issues.push({
      level: "error",
      code: "missing_still_or_env",
      shot_id: shotId,
      message: `${shotId} 需要公网 still_url、环境 establishing 或显式 ref_images`,
    });
  }

  if (shot.still_approved === false) {
    issues.push({
      level: "error",
      code: "still_unapproved",
      shot_id: shotId,
      message: `${shotId} 静帧尚未批准`,
    });
  }

  if (plan === "lipsync" || shot.needs_lipsync) {
    const audios = (shot.ref_audios || []).filter(Boolean);
    if (!audios.length && !shot.dialogue) {
      issues.push({
        level: "error",
        code: "missing_audio",
        shot_id: shotId,
        message: `${shotId} lipsync 需要 dialogue 或 ref_audios`,
      });
    }
  }

  if (plan === "bridge" && !shot.bridge_from) {
    issues.push({
      level: "warn",
      code: "bridge_missing_from",
      shot_id: shotId,
      message: `${shotId} 计划为 bridge 但未填 bridge_from（可用自动编排补全）`,
    });
  }

  for (const url of shot.ref_images || []) {
    if (url === "") {
      issues.push({
        level: "error",
        code: "empty_ref_slot",
        shot_id: shotId,
        message: `${shotId} ref_images 含空串（禁止）`,
      });
    }
  }

  return issues;
}

export function checkChapterReady(pack: StoryPack): {
  ok: boolean;
  issues: GateIssue[];
  shots: Array<{ shot_id: string; ready: boolean; issues: GateIssue[] }>;
} {
  const shots = pack.shots.map((sh) => {
    const issues = checkShotReady(pack, sh.shot_id);
    return {
      shot_id: sh.shot_id,
      ready: !issues.some((i) => i.level === "error"),
      issues,
    };
  });
  const issues = shots.flatMap((s) => s.issues);
  return {
    ok: shots.every((s) => s.ready),
    issues,
    shots,
  };
}

export function assertShotReady(pack: StoryPack, shotId: string): void {
  const errors = checkShotReady(pack, shotId).filter((i) => i.level === "error");
  if (errors.length) {
    throw new Error(`齐套未通过 ${shotId}:\n- ` + errors.map((e) => e.message).join("\n- "));
  }
}
