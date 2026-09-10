import type { StoryPack } from "../story.js";
import { getCharacter, getEnvironment, getProp, loadStyleLock, withLocks } from "../story.js";
import { resolvePlanPath } from "./plan.js";

/** H3 九分节提示词预览（只编译，不改 identity_lock） */
export function compileH3PromptSections(pack: StoryPack, shotId: string): {
  shot_id: string;
  plan_path: string;
  sections: Record<string, string>;
  assembled: string;
} {
  const shot = pack.shots.find((s) => s.shot_id === shotId);
  if (!shot) throw new Error(`unknown shot_id: ${shotId}`);
  const style = loadStyleLock(pack.style_lock);
  const ch = getCharacter(pack, shot.character_ids[0]);
  const env = getEnvironment(pack, shot.environment_id);
  const cam = shot.camera || {};
  const duration = shot.duration || 5;
  const props = (shot.prop_ids || [])
    .map((pid) => {
      try {
        return getProp(pack, pid);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const sections: Record<string, string> = {
    A01_style: style || String(pack.style_lock || ""),
    A02_identity: ch.identity_lock,
    A03_scene: env.scene_card,
    A04_props: props.map((p) => `${p!.name}:${p!.clue_lock}`).join("；") || "无",
    A05_action: shot.action,
    A06_camera: [cam.shot_size && `景别${cam.shot_size}`, cam.angle && `机位${cam.angle}`, cam.move && `运镜${cam.move}`]
      .filter(Boolean)
      .join("，") || "默认",
    A07_emotion: shot.emotion || "",
    A08_dialogue: shot.dialogue || "",
    A09_timing: `时长${duration}秒；路径${resolvePlanPath(shot)}`,
  };

  const actionLine =
    `0-${duration}秒：${shot.action}` +
    (sections.A06_camera !== "默认" ? `，${sections.A06_camera}` : "") +
    (shot.emotion ? `，情绪：${shot.emotion}` : "");

  return {
    shot_id: shotId,
    plan_path: resolvePlanPath(shot),
    sections,
    assembled: withLocks(actionLine, style, ch.identity_lock),
  };
}
