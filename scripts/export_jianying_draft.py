#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""根据 timeline JSON 生成剪映草稿（明文 draft_content.json）。

用法:
  python scripts/export_jianying_draft.py --timeline runs/.../CH01_timeline.json
  python scripts/export_jianying_draft.py --timeline ... --draft-dir "D:/JianyingPro Drafts"

说明:
  - 新建草稿（不读加密模板），剪映 5.9+ / 新版通常都能打开。
  - 若指定 --draft-dir 为剪映「草稿位置」，打开剪映即可看到草稿。
  - 未指定则写到 timeline 同级 05_jianying/ 下，可手动拷贝到草稿目录。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def zh(msg: str) -> None:
    print(msg, flush=True)


def resolution_wh(label: str, clips: list) -> tuple[int, int]:
    # Prefer first clip probe if present
    for c in clips:
        w, h = c.get("width"), c.get("height")
        if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0:
            return w, h
    text = (label or "").strip()
    if "竖" in text:
        return 768, 1344
    return 1344, 768


def main() -> int:
    ap = argparse.ArgumentParser(description="导出剪映草稿")
    ap.add_argument("--timeline", required=True, help="CH0x_timeline.json 路径")
    ap.add_argument("--draft-dir", default="", help="剪映草稿根目录；空则写到 05_jianying/")
    ap.add_argument("--name", default="", help="草稿名；默认 story_chapter")
    ap.add_argument("--srt", default="", help="可选 SRT；默认同目录 chapter.srt")
    args = ap.parse_args()

    try:
        import pyJianYingDraft as draft
        from pyJianYingDraft import Timerange, SEC
    except ImportError:
        zh("[失败][剪映草稿] 未安装 pyJianYingDraft，请先: pip install pyJianYingDraft")
        return 2

    timeline_path = Path(args.timeline).resolve()
    if not timeline_path.is_file():
        zh(f"[失败][剪映草稿] timeline 不存在: {timeline_path}")
        return 1

    data = json.loads(timeline_path.read_text(encoding="utf-8"))
    clips = data.get("clips") or []
    if not clips:
        zh("[失败][剪映草稿] timeline 无 clips")
        return 1

    story_id = str(data.get("story_id") or "story")
    chapter_id = str(data.get("chapter_id") or "CH01")
    draft_name = args.name or f"{story_id}_{chapter_id}"
    width, height = resolution_wh(str(data.get("resolution") or ""), clips)

    export_root = timeline_path.parent
    if args.draft_dir.strip():
        folder = Path(args.draft_dir).expanduser().resolve()
    else:
        folder = (export_root / "05_jianying").resolve()
    folder.mkdir(parents=True, exist_ok=True)

    srt_path = Path(args.srt).resolve() if args.srt else (export_root / f"{chapter_id}.srt")
    if not srt_path.is_file():
        # also try story_chapter naming
        alt = export_root / f"{story_id}_{chapter_id}.srt"
        if alt.is_file():
            srt_path = alt

    zh(f"[进行中][剪映草稿] 正在创建草稿 {draft_name} @ {folder} ({width}x{height})")
    draft_folder = draft.DraftFolder(str(folder))
    script = draft_folder.create_draft(draft_name, width, height, allow_replace=True)
    script.append_track(draft.TrackSpec(draft.TrackType.video))
    script.append_track(draft.TrackSpec(draft.TrackType.audio))
    script.append_track(draft.TrackSpec(draft.TrackType.text, name="subtitle"))

    cursor_us = 0
    missing_video = []
    for i, c in enumerate(clips):
        file_path = str(c.get("file") or "").strip()
        dur_sec = float(c.get("duration_sec") or c.get("duration") or 5)
        dur_us = max(1, int(round(dur_sec * SEC)))
        if not file_path or not os.path.isfile(file_path):
            missing_video.append(c.get("shot_id") or file_path or f"#{i}")
            cursor_us += dur_us
            continue
        # 用微秒整数，避免 5.166667→5.167 四舍五入造成镜间重叠
        try:
            mat = draft.VideoMaterial(file_path)
            dur_us = min(dur_us, int(mat.duration))
        except Exception:
            pass
        script.add_segment(draft.VideoSegment(file_path, Timerange(cursor_us, dur_us)))

        audio = str(c.get("audio_file") or "").strip()
        if audio and os.path.isfile(audio):
            a_dur = float(c.get("audio_duration_sec") or dur_sec)
            a_us = max(1, min(int(round(a_dur * SEC)), dur_us))
            script.add_segment(draft.AudioSegment(audio, Timerange(cursor_us, a_us)))
        cursor_us += dur_us

    if missing_video:
        zh(f"[警告][剪映草稿] 缺视频素材已跳过: {', '.join(map(str, missing_video))}")

    if srt_path.is_file():
        zh(f"[进行中][剪映草稿] 正在导入字幕 {srt_path.name}")
        script.import_srt(str(srt_path), track_name="subtitle", time_offset=0.0)
    else:
        zh("[警告][剪映草稿] 未找到 SRT，仅导出视频/音频轨")

    script.save()
    draft_path = folder / draft_name
    zh(f"[完成][剪映草稿] 已写入 {draft_path}")
    print(json.dumps({"ok": True, "draft_path": str(draft_path), "draft_name": draft_name}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
