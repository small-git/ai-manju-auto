# -*- coding: utf-8 -*-
"""章节交付：timeline JSON + SRT 字幕（供 scripts/export_jianying_draft.py 消费）。"""
from __future__ import annotations

from typing import Any

try:
    from constants import DEFAULT_DURATION
except ImportError:  # 包方式导入（import src.timeline）
    from .constants import DEFAULT_DURATION


def _ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_srt(shot_jobs: list[dict[str, Any]]) -> str:
    """按分镜顺序累积时长生成 SRT；无对白的镜头只占位时间轴。"""
    blocks: list[str] = []
    cursor = 0.0
    idx = 1
    for job in shot_jobs:
        dur = float(job.get("duration") or DEFAULT_DURATION)
        dialogue = str(job.get("dialogue") or "").strip()
        if dialogue:
            blocks.append(f"{idx}\n{_ts(cursor)} --> {_ts(cursor + dur)}\n{dialogue}")
            idx += 1
        cursor += dur
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def first_result_url(meta: dict[str, Any] | None) -> str | None:
    """从阶段 meta 取第一个产物 URL（短时有效，仅供同轮次链接下游）。"""
    if not meta:
        return None
    for item in meta.get("results") or []:
        if isinstance(item, str) and item:
            return item
        if isinstance(item, dict):
            url = item.get("url") or item.get("file_url")
            if url:
                return str(url)
    return None


def first_result_file(meta: dict[str, Any] | None) -> str:
    files = (meta or {}).get("files") or []
    return str(files[0]) if files else ""


def build_timeline(expanded: dict[str, Any], report: dict[str, Any]) -> dict[str, Any]:
    """汇总各镜视频/音频产物为剪映时间线 JSON（clips 顺序 = 分镜顺序）。"""
    shots_rep = report.get("shots") or {}
    clips: list[dict[str, Any]] = []
    for job in expanded.get("shot_jobs") or []:
        sid = job.get("shot_id")
        rep = shots_rep.get(sid) or {}
        dur = float(job.get("duration") or DEFAULT_DURATION)
        clips.append(
            {
                "shot_id": sid,
                "file": first_result_file(rep.get("video")),
                "duration_sec": dur,
                "audio_file": first_result_file(rep.get("audio")),
                "audio_duration_sec": dur,
            }
        )
    return {
        "story_id": expanded.get("story_id"),
        "chapter_id": expanded.get("chapter_id"),
        "resolution": expanded.get("resolution"),
        "clips": clips,
    }
