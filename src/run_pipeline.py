# -*- coding: utf-8 -*-
"""
Manhua pipeline over AutoDL.art hosted ComfyUI API.

Story mode (recommended):
  --story <story_id>  必须显式引用故事，才能成片（一故事一剧本，防串戏）
  stories/<story_id>/story.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from autodl_client import AutodlClient  # noqa: E402
from compile import (  # noqa: E402
    ensure_env,
    load_style_lock,
    load_workflow_config,
    run_shot,
)
from story import StoryError, expand_story_pack, validate_story_pack  # noqa: E402
from story_registry import (  # noqa: E402
    assert_story_bound_for_video,
    register_story,
    resolve_story_pack,
)


def _is_story_pack(pack: dict[str, Any]) -> bool:
    return bool(pack.get("script") and pack.get("characters") and pack.get("shots"))


def _dump_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def run_legacy_project(pack: dict[str, Any], out_root: Path) -> dict[str, Any]:
    steps = pack.get("steps") or ["video"]
    style = load_style_lock(pack.get("style_lock", "manhua_ink"))
    identity = pack.get("identity_lock") or ""
    project_id = pack.get("project_id") or "manhua"
    out_root.mkdir(parents=True, exist_ok=True)

    client = AutodlClient()
    cfg = load_workflow_config()
    report: dict[str, Any] = {"project_id": project_id, "kind": "legacy", "steps": {}, "assets": {}}

    refs = list(pack.get("ref_images") or [])
    report["assets"]["ref_images"] = refs

    if "video" in steps:
        vid = dict(pack.get("video") or {})
        vid.setdefault("id", f"{project_id}_vid")
        vid.setdefault("shot_id", vid["id"])
        vid.setdefault("workflow", pack.get("video_workflow") or "manhua_video_ref")
        vid.setdefault("resolution", pack.get("resolution") or "768p横")
        if refs and not vid.get("ref_images"):
            vid["ref_images"] = refs
        if pack.get("ref_audios") and not vid.get("ref_audios"):
            vid["ref_audios"] = pack["ref_audios"]
        out = out_root / "03_video"
        out.mkdir(parents=True, exist_ok=True)
        meta = run_shot(client, vid, out, cfg=cfg, style_lock=style, identity_lock=identity)
        report["steps"]["video"] = meta

    _dump_json(out_root / "pipeline_report.json", report)
    print(f"report → {out_root / 'pipeline_report.json'}")
    return report


def run_story_project(
    pack: dict[str, Any],
    out_root: Path,
    *,
    story_id: str,
    shot_ids: list[str] | None = None,
) -> dict[str, Any]:
    assert_story_bound_for_video(pack, story_id)
    expanded = expand_story_pack(pack)
    style = load_style_lock(expanded.get("style_lock", "manhua_ink"))
    steps = list(expanded.get("steps") or ["video"])
    out_root.mkdir(parents=True, exist_ok=True)
    _dump_json(out_root / "expanded_shot_jobs.json", expanded)

    jobs = expanded["shot_jobs"]
    if shot_ids:
        allow = set(shot_ids)
        jobs = [j for j in jobs if j["shot_id"] in allow]

    client = AutodlClient()
    cfg = load_workflow_config()
    report: dict[str, Any] = {
        "story_id": story_id,
        "chapter_id": expanded.get("chapter_id"),
        "project_id": expanded["project_id"],
        "kind": "story_pack",
        "title": expanded.get("title"),
        "steps": steps,
        "shots": {},
    }

    if "video" in steps:
        video_dir = out_root / "03_video"
        video_dir.mkdir(parents=True, exist_ok=True)
        for job in jobs:
            wf = job.get("workflow") or ""
            if (not job.get("ref_images")) and wf.startswith("manhua_video_ref"):
                raise StoryError(
                    f"{job['shot_id']}: 多参考成片需要 ref_images/still_url。"
                    "请先生图填参考，或本镜临时改用 manhua_video_t2v 预览。"
                )
            meta = run_shot(
                client,
                job,
                video_dir,
                cfg=cfg,
                style_lock=style,
                identity_lock=job.get("identity_lock") or "",
            )
            report["shots"].setdefault(job["shot_id"], {})["video"] = meta

    if "bridge" in steps:
        bridge_dir = out_root / "04_bridge"
        bridge_dir.mkdir(parents=True, exist_ok=True)
        for job in jobs:
            if not job.get("bridge_from"):
                continue
            br = {
                "shot_id": f"{job['shot_id']}_bridge",
                "workflow": "manhua_bridge",
                "resolution": job.get("resolution") or "768p横",
                "duration": job.get("duration") or 5,
                "prompt": job.get("prompt") or "",
                "first_frame": job.get("first_frame"),
                "last_frame": job.get("last_frame"),
            }
            if not br["first_frame"] or not br["last_frame"]:
                report["shots"].setdefault(job["shot_id"], {})["bridge"] = {
                    "skipped": True,
                    "reason": "need first_frame + last_frame public URLs",
                    "bridge_from": job.get("bridge_from"),
                }
                continue
            meta = run_shot(
                client,
                br,
                bridge_dir,
                cfg=cfg,
                style_lock=style,
                identity_lock=job.get("identity_lock") or "",
            )
            report["shots"].setdefault(job["shot_id"], {})["bridge"] = meta

    _dump_json(out_root / "pipeline_report.json", report)
    print(f"report → {out_root / 'pipeline_report.json'}")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Run AutoDL manhua pipeline (story-bound)")
    parser.add_argument(
        "project_json",
        type=Path,
        nargs="?",
        default=None,
        help="可选；不传则按 --story 从 stories/<id>/story.json 加载",
    )
    parser.add_argument(
        "--story",
        required=False,
        default="",
        help="必填（成片时）：故事 ID，一故事一剧本，必须显式引用",
    )
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--steps", default="", help="comma list override, e.g. video,bridge")
    parser.add_argument("--shots", default="", help="comma shot_id filter for story packs")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--expand-only", action="store_true")
    parser.add_argument("--register-only", action="store_true", help="校验并注册到 stories/index.json")
    args = parser.parse_args()

    ensure_env()
    story_id = (args.story or "").strip() or None

    if story_id and not args.project_json:
        pack, pack_path = resolve_story_pack(story_id)
    elif args.project_json:
        pack_path = args.project_json
        pack = json.loads(pack_path.read_text(encoding="utf-8"))
        if _is_story_pack(pack) and story_id and pack.get("story_id") != story_id:
            raise SystemExit(
                f"故事引用不匹配：--story={story_id} vs file story_id={pack.get('story_id')}"
            )
    else:
        raise SystemExit("请提供 project_json 或 --story <story_id>")

    if args.steps:
        pack["steps"] = [s.strip() for s in args.steps.split(",") if s.strip()]

    out = args.out or (
        ROOT
        / "runs"
        / (pack.get("story_id") or "story")
        / (pack.get("chapter_id") or pack.get("project_id") or "run")
    )

    if _is_story_pack(pack):
        issues = validate_story_pack(pack)
        if issues:
            print("INVALID story pack:")
            for i in issues:
                print(f"  - {i}")
            raise SystemExit(2)
        register_story(pack, pack_path)
        if args.register_only or args.validate_only:
            print(f"OK: story_id={pack['story_id']} chapter={pack.get('chapter_id')} registered")
            return
        if args.expand_only:
            # expand 允许只读展开，但仍建议带 --story
            if story_id and pack.get("story_id") != story_id:
                raise SystemExit("故事引用不匹配")
            expanded = expand_story_pack(pack)
            path = out / "expanded_shot_jobs.json"
            _dump_json(path, expanded)
            print(f"expanded → {path} ({len(expanded['shot_jobs'])} shots)")
            return
        # 成片硬门禁：必须显式 --story
        try:
            assert_story_bound_for_video(pack, story_id)
        except StoryError as e:
            print(e)
            raise SystemExit(2) from e

        shot_ids = [s.strip() for s in args.shots.split(",") if s.strip()] or None
        try:
            run_story_project(pack, out, story_id=story_id, shot_ids=shot_ids)
        except StoryError as e:
            print(e)
            raise SystemExit(2) from e
        return

    # legacy
    run_legacy_project(pack, out)


if __name__ == "__main__":
    main()
