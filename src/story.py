# -*- coding: utf-8 -*-
"""StoryPack: 剧本 → 人物 → 环境 → 分镜 → ShotJob。"""
from __future__ import annotations

from typing import Any


class StoryError(ValueError):
    pass


def _nonempty_urls(*values: str | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for v in values:
        if not v or not str(v).strip():
            continue
        u = str(v).strip()
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def index_by_id(items: list[dict[str, Any]], key: str = "id") -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for it in items:
        iid = it.get(key)
        if not iid:
            raise StoryError(f"missing {key} in item: {it}")
        if iid in out:
            raise StoryError(f"duplicate {key}: {iid}")
        out[str(iid)] = it
    return out


def validate_story_pack(pack: dict[str, Any]) -> list[str]:
    """Return human-readable issues; empty list means OK."""
    issues: list[str] = []
    if not pack.get("story_id"):
        issues.append("missing story_id（一故事一剧本，成片必须引用）")
    if not pack.get("project_id"):
        issues.append("missing project_id")
    if not pack.get("chapter_id"):
        issues.append("missing chapter_id（如 CH01）")
    script = pack.get("script") or {}
    if not script.get("logline"):
        issues.append("script.logline required")
    if not script.get("synopsis"):
        issues.append("script.synopsis required")
    if not script.get("episodes"):
        issues.append("script.episodes required")

    chars = index_by_id(list(pack.get("characters") or []))
    envs = index_by_id(list(pack.get("environments") or []))
    props = index_by_id(list(pack.get("props") or []))
    shots = list(pack.get("shots") or [])
    if not chars:
        issues.append("characters required")
    if not envs:
        issues.append("environments required")
    if not shots:
        issues.append("shots required")

    ep_ids = {e.get("episode_id") for e in (script.get("episodes") or [])}
    shot_ids: set[str] = set()
    for sh in shots:
        sid = sh.get("shot_id")
        if not sid:
            issues.append("shot missing shot_id")
            continue
        if sid in shot_ids:
            issues.append(f"duplicate shot_id: {sid}")
        shot_ids.add(sid)
        if sh.get("episode_id") not in ep_ids:
            issues.append(f"{sid}: episode_id not in script.episodes")
        if sh.get("environment_id") not in envs:
            issues.append(f"{sid}: unknown environment_id {sh.get('environment_id')}")
        for cid in sh.get("character_ids") or []:
            if cid not in chars:
                issues.append(f"{sid}: unknown character_id {cid}")
        for pid in sh.get("prop_ids") or []:
            if pid not in props:
                issues.append(f"{sid}: unknown prop_id {pid}")
        if not (sh.get("action") or sh.get("video_prompt")):
            issues.append(f"{sid}: need action or video_prompt")
        plan = sh.get("plan_path")
        if plan and plan not in ("video_ref", "bridge", "grid", "lipsync"):
            issues.append(f"{sid}: invalid plan_path {plan}")
        for url in sh.get("ref_images") or []:
            if url == "":
                issues.append(f"{sid}: empty string in ref_images (forbidden)")

    for sh in shots:
        bf = sh.get("bridge_from")
        if bf and bf not in shot_ids:
            issues.append(f"{sh.get('shot_id')}: bridge_from unknown {bf}")

    return issues


def character_identity_lock(chars: dict[str, dict[str, Any]], character_ids: list[str]) -> str:
    parts: list[str] = []
    for cid in character_ids:
        ch = chars.get(cid)
        if not ch:
            raise StoryError(f"unknown character_id: {cid}")
        lock = (ch.get("identity_lock") or "").strip()
        if not lock:
            raise StoryError(f"character {cid} missing identity_lock")
        parts.append(lock)
    return "；".join(parts)


def assemble_ref_images(
    pack: dict[str, Any],
    shot: dict[str, Any],
    chars: dict[str, dict[str, Any]],
    envs: dict[str, dict[str, Any]],
) -> list[str]:
    if shot.get("ref_images"):
        return _nonempty_urls(*list(shot["ref_images"]))

    urls: list[str] = []
    for cid in shot.get("character_ids") or []:
        refs = (chars[cid].get("ref_images") or {}) if cid in chars else {}
        urls.extend(
            _nonempty_urls(
                refs.get("sheet"),
                refs.get("face"),
                refs.get("full"),
                refs.get("costume"),
            )
        )
    props = index_by_id(list(pack.get("props") or []))
    for pid in shot.get("prop_ids") or []:
        prefs = (props[pid].get("ref_images") or {}) if pid in props else {}
        urls.extend(_nonempty_urls(prefs.get("sheet"), prefs.get("detail")))
    still = shot.get("still_url")
    if still:
        urls.extend(_nonempty_urls(still))
    env = envs.get(shot.get("environment_id") or "")
    if env:
        erefs = env.get("ref_images") or {}
        urls.extend(_nonempty_urls(erefs.get("establishing"), erefs.get("detail")))
    # also allow pack-level shared refs
    urls.extend(_nonempty_urls(*(pack.get("ref_images") or [])))
    return _nonempty_urls(*urls)


def compile_camera_action(shot: dict[str, Any]) -> str:
    if shot.get("video_prompt"):
        return str(shot["video_prompt"]).strip()
    duration = int(shot.get("duration") or 5)
    cam = shot.get("camera") or {}
    bits = [
        f"0-{duration}秒",
        shot.get("action") or "",
    ]
    size = cam.get("shot_size")
    move = cam.get("move")
    angle = cam.get("angle")
    cam_bits = [x for x in [size and f"景别{size}", move and f"运镜{move}", angle and f"机位{angle}"] if x]
    if cam_bits:
        bits.append("，".join(cam_bits))
    if shot.get("emotion"):
        bits.append(f"情绪：{shot['emotion']}")
    if shot.get("dialogue"):
        bits.append(f"对白：「{shot['dialogue']}」")
    return "：".join([bits[0], "，".join(b for b in bits[1:] if b)])


def compile_still_prompt(
    shot: dict[str, Any],
    env: dict[str, Any],
    identity_lock: str,
) -> str:
    if shot.get("still_prompt"):
        return str(shot["still_prompt"]).strip()
    cam = shot.get("camera") or {}
    parts = [
        env.get("scene_card") or "",
        shot.get("action") or "",
        identity_lock,
    ]
    if cam.get("shot_size"):
        parts.insert(0, f"{cam['shot_size']}景")
    if shot.get("emotion"):
        parts.append(f"情绪：{shot['emotion']}")
    return "。".join(p for p in parts if p)


def expand_shot(
    pack: dict[str, Any],
    shot: dict[str, Any],
    *,
    chars: dict[str, dict[str, Any]] | None = None,
    envs: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Expand one story shot into a runnable video ShotJob (+ metadata)."""
    chars = chars or index_by_id(list(pack.get("characters") or []))
    envs = envs or index_by_id(list(pack.get("environments") or []))
    env_id = shot.get("environment_id")
    if env_id not in envs:
        raise StoryError(f"unknown environment_id: {env_id}")
    env = envs[env_id]
    cids = list(shot.get("character_ids") or [])
    identity = character_identity_lock(chars, cids)
    refs = assemble_ref_images(pack, shot, chars, envs)
    duration = int(shot.get("duration") or 5)
    video_prompt = compile_camera_action(shot)
    still_prompt = compile_still_prompt(shot, env, identity)

    job: dict[str, Any] = {
        "shot_id": shot["shot_id"],
        "id": shot["shot_id"],
        "episode_id": shot.get("episode_id"),
        "scene_id": shot.get("scene_id"),
        "beat_id": shot.get("beat_id"),
        "environment_id": env_id,
        "character_ids": cids,
        "prop_ids": list(shot.get("prop_ids") or []),
        "duration": duration,
        "resolution": pack.get("resolution") or "768p横",
        "workflow": shot.get("workflow") or pack.get("video_workflow") or "manhua_video_ref",
        "plan_path": shot.get("plan_path") or "video_ref",
        "prompt": video_prompt,
        "still_prompt": still_prompt,
        "identity_lock": identity,
        "ref_images": refs,
        "tail_frame_note": shot.get("tail_frame_note"),
        "state": dict(shot.get("state") or {}),
        "bridge_from": shot.get("bridge_from"),
        "needs_lipsync": bool(shot.get("needs_lipsync")),
        "dialogue": shot.get("dialogue"),
    }
    if shot.get("seed") is not None:
        job["seed"] = shot["seed"]
    if shot.get("ref_audios"):
        job["ref_audios"] = list(shot["ref_audios"])
    if shot.get("first_frame"):
        job["first_frame"] = shot["first_frame"]
    if shot.get("last_frame"):
        job["last_frame"] = shot["last_frame"]
    # continuity defaults from environment
    st = job["state"]
    st.setdefault("location", env.get("name"))
    if env.get("time_of_day"):
        st.setdefault("time_of_day", env["time_of_day"])
    if env.get("weather"):
        st.setdefault("weather", env["weather"])
    return job


def expand_story_pack(pack: dict[str, Any]) -> dict[str, Any]:
    issues = validate_story_pack(pack)
    if issues:
        raise StoryError("story pack invalid:\n- " + "\n- ".join(issues))
    chars = index_by_id(list(pack["characters"]))
    envs = index_by_id(list(pack["environments"]))
    jobs = [expand_shot(pack, sh, chars=chars, envs=envs) for sh in pack["shots"]]
    return {
        "story_id": pack["story_id"],
        "chapter_id": pack.get("chapter_id"),
        "project_id": pack["project_id"],
        "title": pack.get("title"),
        "style_lock": pack.get("style_lock") or "manhua_ink",
        "resolution": pack.get("resolution") or "768p横",
        "video_workflow": pack.get("video_workflow") or "manhua_video_ref",
        "steps": pack.get("steps") or ["video"],
        "script": pack["script"],
        "shot_jobs": jobs,
    }
