# -*- coding: utf-8 -*-
"""Compile ShotJob → AutoDL workflow body + run helpers."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

try:
    from autodl_client import AutodlClient, AutodlError
    from constants import DEFAULT_DURATION, DEFAULT_RESOLUTION, DEFAULT_WORKFLOW
    from zh_log import fail, ok, step
except ImportError:  # 包方式导入（import src.compile）
    from .autodl_client import AutodlClient, AutodlError
    from .constants import DEFAULT_DURATION, DEFAULT_RESOLUTION, DEFAULT_WORKFLOW
    from .zh_log import fail, ok, step

ROOT = Path(__file__).resolve().parents[1]


def ensure_env() -> None:
    load_dotenv(ROOT / ".env")


def load_workflow_config() -> dict[str, Any]:
    path = ROOT / "config" / "workflows.yaml"
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_style_lock(name: str | None) -> str:
    if not name:
        return ""
    p = ROOT / "templates" / "style_locks" / f"{name}.txt"
    if p.exists():
        return p.read_text(encoding="utf-8").strip()
    return str(name).strip()


_EMO_WEIGHTS: list[tuple[re.Pattern[str], dict[str, float | str]]] = [
    (re.compile(r"(不舍|悲伤|难过|沉重|压抑|沉默|忧郁)"), {"emo_melancholic": 0.9, "emo_calm": 0.3}),
    (re.compile(r"(羞怯|不安|拘谨|害怕|紧张|警惕|焦虑|茫然)"), {"emo_afraid": 0.7}),
    (re.compile(r"(愤怒|生气|激动)"), {"emo_angry": 0.9}),
    (re.compile(r"(开心|欢快|喜悦|兴奋|高兴)"), {"emo_happy": 1.0}),
    (re.compile(r"(厌恶|嫌弃)"), {"emo_disgusted": 0.8}),
    (re.compile(r"(惊讶|震惊)"), {"emo_surprised": "1"}),
    (re.compile(r"(坚定|决意|勇敢)"), {"emo_calm": 0.5, "emo_angry": 0.3}),
    (re.compile(r"(平静|安定|温柔|温暖|安宁|希望|克制)"), {"emo_calm": 0.6}),
]


def emotion_to_weights(emotion: str) -> dict[str, float | str]:
    """情绪文本 → IndexTTS2 情绪权重向量（首个命中生效）。"""
    for pattern, weights in _EMO_WEIGHTS:
        if pattern.search(emotion):
            return dict(weights)
    return {}


_EMO_REF_FILES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(不舍|悲伤|难过|沉重|压抑|沉默|忧郁|留恋)"), "emo_sad.wav"),
    (re.compile(r"(愤怒|生气|激动|憎恨)"), "emo_hate.wav"),
]


def _emo_ref_audio(emotion: str) -> str | None:
    """情绪 → 官方情感参考音频公网 URL（runs/shared/tts 经隧道/静态服务暴露）。"""
    base = os.getenv("PUBLIC_ASSET_BASE_URL", "").rstrip("/")
    if not base:
        return None
    for pattern, fname in _EMO_REF_FILES:
        if pattern.search(emotion) and (ROOT / "runs" / "shared" / "tts" / fname).exists():
            return f"{base}/runs/shared/tts/{fname}"
    return None


def resolve_workflow(cfg: dict[str, Any], shot: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    alias = shot.get("workflow")
    if not alias and shot.get("stage"):
        alias = (cfg.get("stages") or {}).get(shot["stage"])
    if not alias:
        alias = os.getenv("DEFAULT_WORKFLOW", DEFAULT_WORKFLOW)
    wf = (cfg.get("workflows") or {}).get(alias)
    if not wf:
        raise AutodlError(f"unknown workflow alias: {alias}")
    return alias, wf


def with_style(prompt: str, style_lock: str, identity_lock: str = "") -> str:
    parts = [p for p in [style_lock, identity_lock, prompt] if p]
    return "。".join(parts) if parts else prompt


def compile_body(cfg: dict[str, Any], shot: dict[str, Any], style_lock: str = "", identity_lock: str = "") -> tuple[str, str, dict[str, Any]]:
    alias, wf = resolve_workflow(cfg, shot)
    global_defaults = cfg.get("defaults") or {}
    local_defaults = wf.get("defaults") or {}

    resolution = (
        shot.get("resolution")
        or local_defaults.get("resolution")
        or global_defaults.get("resolution")
        or os.getenv("DEFAULT_RESOLUTION", DEFAULT_RESOLUTION)
    )
    duration = shot.get("duration")
    if duration is None:
        duration = local_defaults.get("duration") or global_defaults.get("duration") or int(
            os.getenv("DEFAULT_DURATION", str(DEFAULT_DURATION))
        )

    body: dict[str, Any] = {}
    prompt = with_style(shot.get("prompt") or "", style_lock, identity_lock)
    if prompt:
        body["prompt"] = prompt
    if shot.get("seed") is not None:
        body["seed"] = shot["seed"]

    kind = wf.get("kind")
    if kind in {"multi_ref_video", "multi_ref_av", "t2v", "flf_video"}:
        body["resolution"] = resolution
        body["duration"] = int(duration)
    if kind == "lipsync":
        body["resolution"] = resolution
        ad = shot.get("audio_duration")
        if ad is None:
            ad = local_defaults.get("audio_duration", duration)
        body["audio_duration"] = int(ad)
    if kind == "tts":
        text = str(shot.get("dialogue") or shot.get("text") or "").strip()
        if text:
            body["prompt_text"] = text
        emo_ref = _emo_ref_audio(str(shot.get("emotion") or ""))
        if emo_ref:
            body["emo_control_method"] = "使用情感参考音频"
            body["emo_ref_audio"] = emo_ref
        else:
            body["emo_control_method"] = "与音色参考音频相同"
            body.update(emotion_to_weights(str(shot.get("emotion") or "")))

    refs = list(shot.get("ref_images") or [])
    prefix = wf.get("ref_image_prefix", "ref_image_")
    slots = int(wf.get("ref_image_slots") or 0)
    for i, url in enumerate(refs[: slots or len(refs)]):
        if url:
            body[f"{prefix}{i}"] = url

    audios = list(shot.get("ref_audios") or [])
    if kind != "tts":
        ap = wf.get("ref_audio_prefix", "ref_audio_")
        aslots = int(wf.get("ref_audio_slots") or 0)
        for i, url in enumerate(audios[: aslots or len(audios)]):
            if url:
                body[f"{ap}{i}"] = url
    elif audios:
        # IndexTTS2：音色参考音频为必填单槽 prompt_simple
        body["prompt_simple"] = audios[0]

    if shot.get("first_frame"):
        body["first_frame"] = shot["first_frame"]
    if shot.get("last_frame"):
        body["last_frame"] = shot["last_frame"]

    # lipsync single slots
    if kind == "lipsync":
        if refs:
            body["ref_image_0"] = refs[0]
        if audios:
            body["ref_audio_0"] = audios[0]

    for key in wf.get("required") or []:
        if key not in body or body[key] in (None, ""):
            raise AutodlError(f"missing required field `{key}` for alias={alias}")

    return alias, wf["workflow_id"], body


def submit_shot(
    client: AutodlClient,
    shot: dict[str, Any],
    *,
    cfg: dict[str, Any] | None = None,
    style_lock: str = "",
    identity_lock: str = "",
) -> dict[str, Any]:
    """编译并提交单镜，返回 pending 记录（供并发轮询复用）。"""
    cfg = cfg or load_workflow_config()
    alias, workflow_id, body = compile_body(cfg, shot, style_lock, identity_lock)
    shot_id = shot.get("shot_id") or shot.get("id") or "shot"
    step(
        "成片",
        "提交单镜",
        shot_id=shot_id,
        alias=alias,
        workflow_id=workflow_id,
        body_keys=list(body.keys()),
    )
    task_id = client.submit(workflow_id, body)
    return {
        "shot_id": shot_id,
        "workflow_alias": alias,
        "workflow_id": workflow_id,
        "task_id": task_id,
        "request_body": body,
    }


def finalize_shot(
    client: AutodlClient,
    pending: dict[str, Any],
    data: dict[str, Any],
    out_dir: Path,
) -> dict[str, Any]:
    """任务成功后：下载产物 + 写 meta。"""
    shot_id = pending["shot_id"]
    files = client.download_results(data, out_dir, stem=str(shot_id))
    meta = {
        **pending,
        "status": data.get("status"),
        "duration": data.get("duration"),
        "results": data.get("results"),
        "files": [str(p) for p in files],
    }
    meta_path = out_dir / f"{shot_id}_meta.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    ok("成片", "单镜完成", shot_id=shot_id, files=len(files), meta=str(meta_path))
    return meta


def run_shot(
    client: AutodlClient,
    shot: dict[str, Any],
    out_dir: Path,
    *,
    cfg: dict[str, Any] | None = None,
    style_lock: str = "",
    identity_lock: str = "",
) -> dict[str, Any]:
    shot_id = shot.get("shot_id") or shot.get("id") or "shot"
    try:
        pending = submit_shot(client, shot, cfg=cfg, style_lock=style_lock, identity_lock=identity_lock)
        data = client.wait_result(pending["task_id"])
        return finalize_shot(client, pending, data, out_dir)
    except Exception as e:
        fail("成片", f"单镜 {shot_id} 执行中断", error=e)
        raise
