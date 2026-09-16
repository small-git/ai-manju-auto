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
import time
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
from constants import DEFAULT_RESOLUTION  # noqa: E402
from story import (  # noqa: E402
    StoryError,
    derive_bridge_frames,
    expand_story_pack,
    validate_story_pack,
)
from story_registry import (  # noqa: E402
    assert_story_bound_for_video,
    register_story,
    resolve_story_pack,
)
from zh_log import fail, info, ok, step, warn  # noqa: E402


def _is_story_pack(pack: dict[str, Any]) -> bool:
    return bool(pack.get("script") and pack.get("characters") and pack.get("shots"))


def _dump_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_existing_meta(out_dir: Path, shot_id: str) -> dict[str, Any] | None:
    """断点续跑：已有成功产物（meta 记录成功且文件齐全）则复用，否则重跑。"""
    meta_path = out_dir / f"{shot_id}_meta.json"
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    status = str(meta.get("status") or "").upper()
    files = [Path(f) for f in meta.get("files") or []]
    if status in {"SUCCESS", "COMPLETED", "DONE"} and files and all(p.exists() for p in files):
        return meta
    return None


def _run_with_retry(
    client: AutodlClient,
    job: dict[str, Any],
    out_dir: Path,
    *,
    cfg: dict[str, Any],
    style_lock: str,
    retries: int,
    identity_lock: str = "",
) -> dict[str, Any]:
    """单镜执行 + 指数退避重试；StoryError 属确定性数据错误，不重试。"""
    attempt = 0
    while True:
        try:
            return run_shot(
                client, job, out_dir, cfg=cfg, style_lock=style_lock, identity_lock=identity_lock
            )
        except StoryError:
            raise
        except Exception:
            attempt += 1
            if attempt > retries:
                raise
            wait = min(2**attempt * 5, 60)
            warn(
                "流水线",
                "单镜失败，准备重试",
                shot_id=job.get("shot_id"),
                attempt=attempt,
                wait_sec=wait,
            )
            time.sleep(wait)


def run_legacy_project(pack: dict[str, Any], out_root: Path) -> dict[str, Any]:
    steps = pack.get("steps") or ["video"]
    style = load_style_lock(pack.get("style_lock", "live_action"))
    identity = pack.get("identity_lock") or ""
    project_id = pack.get("project_id") or "manhua"
    out_root.mkdir(parents=True, exist_ok=True)
    step("流水线", "进入旧版工程模式", project_id=project_id, steps=steps)

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
        vid.setdefault("resolution", pack.get("resolution") or DEFAULT_RESOLUTION)
        if refs and not vid.get("ref_images"):
            vid["ref_images"] = refs
        if pack.get("ref_audios") and not vid.get("ref_audios"):
            vid["ref_audios"] = pack["ref_audios"]
        out = out_root / "03_video"
        out.mkdir(parents=True, exist_ok=True)
        meta = run_shot(client, vid, out, cfg=cfg, style_lock=style, identity_lock=identity)
        report["steps"]["video"] = meta

    _dump_json(out_root / "pipeline_report.json", report)
    ok("流水线", "旧版工程报告已写出", path=str(out_root / "pipeline_report.json"))
    return report


def run_story_project(
    pack: dict[str, Any],
    out_root: Path,
    *,
    story_id: str,
    shot_ids: list[str] | None = None,
    force: bool = False,
    retries: int = 1,
    keep_going: bool = False,
) -> dict[str, Any]:
    step("流水线", "进入故事成片", story_id=story_id)
    assert_story_bound_for_video(pack, story_id)
    expanded = expand_story_pack(pack)
    style = load_style_lock(expanded.get("style_lock", "live_action"))
    steps = list(expanded.get("steps") or ["video"])
    out_root.mkdir(parents=True, exist_ok=True)
    _dump_json(out_root / "expanded_shot_jobs.json", expanded)
    ok("流水线", "故事包已展开", shots=len(expanded["shot_jobs"]), out=str(out_root))

    jobs = expanded["shot_jobs"]
    if shot_ids:
        allow = set(shot_ids)
        jobs = [j for j in jobs if j["shot_id"] in allow]
        info("流水线", "已按镜号过滤", keep=len(jobs), filter=",".join(shot_ids))

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

    failures: dict[str, str] = {}

    if "video" in steps:
        video_dir = out_root / "03_video"
        video_dir.mkdir(parents=True, exist_ok=True)
        step("流水线", "开始批量成片", count=len(jobs))
        for job in jobs:
            try:
                wf = job.get("workflow") or ""
                if (not job.get("ref_images")) and wf.startswith("manhua_video_ref"):
                    raise StoryError(
                        f"{job['shot_id']}: 多参考成片需要 ref_images/still_url。"
                        "请先生图填参考，或本镜临时改用 manhua_video_t2v 预览。"
                    )
                if not force:
                    existing = _load_existing_meta(video_dir, job["shot_id"])
                    if existing:
                        info("流水线", "跳过已有成片（--force 可重跑）", shot_id=job["shot_id"])
                        report["shots"].setdefault(job["shot_id"], {})["video"] = {
                            **existing,
                            "skipped_existing": True,
                        }
                        continue
                meta = _run_with_retry(
                    client,
                    job,
                    video_dir,
                    cfg=cfg,
                    style_lock=style,
                    retries=retries,
                    identity_lock=job.get("identity_lock") or "",
                )
            except Exception as e:
                if not keep_going:
                    fail("流水线", "故事成片中断", shot_id=job.get("shot_id"), error=e)
                    raise
                failures[job["shot_id"]] = str(e)
                warn("流水线", "单镜失败，继续后续镜头", shot_id=job["shot_id"], error=e)
                report["shots"].setdefault(job["shot_id"], {})["video"] = {
                    "status": "FAILED",
                    "error": str(e),
                }
                continue
            report["shots"].setdefault(job["shot_id"], {})["video"] = meta

    if "bridge" in steps:
        bridge_dir = out_root / "04_bridge"
        bridge_dir.mkdir(parents=True, exist_ok=True)
        step("流水线", "开始镜间 Bridge")
        jobs_by_id = {j["shot_id"]: j for j in expanded["shot_jobs"]}
        for job in jobs:
            if not job.get("bridge_from"):
                continue
            first_frame, last_frame = derive_bridge_frames(job, jobs_by_id)
            br = {
                "shot_id": f"{job['shot_id']}_bridge",
                "workflow": "manhua_bridge",
                "resolution": job.get("resolution") or DEFAULT_RESOLUTION,
                "duration": job.get("duration") or 5,
                "prompt": job.get("prompt") or "",
                "first_frame": first_frame,
                "last_frame": last_frame,
            }
            if not br["first_frame"] or not br["last_frame"]:
                warn(
                    "流水线",
                    f"{job['shot_id']} 跳过 Bridge（缺首尾帧：显式帧或相邻镜 still_url）",
                    bridge_from=job.get("bridge_from"),
                )
                report["shots"].setdefault(job["shot_id"], {})["bridge"] = {
                    "skipped": True,
                    "reason": "need first_frame + last_frame（可显式填写或由相邻镜 still_url 派生）",
                    "bridge_from": job.get("bridge_from"),
                }
                continue
            try:
                if not force:
                    existing = _load_existing_meta(bridge_dir, br["shot_id"])
                    if existing:
                        info("流水线", "跳过已有 Bridge（--force 可重跑）", shot_id=br["shot_id"])
                        report["shots"].setdefault(job["shot_id"], {})["bridge"] = {
                            **existing,
                            "skipped_existing": True,
                        }
                        continue
                meta = _run_with_retry(
                    client,
                    br,
                    bridge_dir,
                    cfg=cfg,
                    style_lock=style,
                    retries=retries,
                    identity_lock=job.get("identity_lock") or "",
                )
            except Exception as e:
                if not keep_going:
                    fail("流水线", "Bridge 中断", shot_id=br["shot_id"], error=e)
                    raise
                failures[br["shot_id"]] = str(e)
                warn("流水线", "Bridge 失败，继续后续镜头", shot_id=br["shot_id"], error=e)
                report["shots"].setdefault(job["shot_id"], {})["bridge"] = {
                    "status": "FAILED",
                    "error": str(e),
                }
                continue
            report["shots"].setdefault(job["shot_id"], {})["bridge"] = meta

    if failures:
        report["failures"] = failures
        warn("流水线", "存在失败镜头", failed=",".join(failures))

    _dump_json(out_root / "pipeline_report.json", report)
    ok("流水线", "故事成片报告已写出", path=str(out_root / "pipeline_report.json"))
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
    parser.add_argument("--force", action="store_true", help="忽略已有产物，全部重跑")
    parser.add_argument("--retries", type=int, default=1, help="单镜失败重试次数（指数退避）")
    parser.add_argument("--keep-going", action="store_true", help="单镜失败不中断，记录报告后继续")
    args = parser.parse_args()

    ensure_env()
    story_id = (args.story or "").strip() or None
    step("流水线", "启动", story=story_id or "(未指定)", file=str(args.project_json or ""))

    if story_id and not args.project_json:
        pack, pack_path = resolve_story_pack(story_id)
        ok("流水线", "已按 story_id 加载故事包", path=str(pack_path))
    elif args.project_json:
        pack_path = args.project_json
        pack = json.loads(pack_path.read_text(encoding="utf-8"))
        if _is_story_pack(pack) and story_id and pack.get("story_id") != story_id:
            fail(
                "流水线",
                "故事引用不匹配",
                story=story_id,
                file_story_id=pack.get("story_id"),
            )
            raise SystemExit(
                f"故事引用不匹配：--story={story_id} vs file story_id={pack.get('story_id')}"
            )
        ok("流水线", "已从文件加载工程", path=str(pack_path))
    else:
        fail("流水线", "未提供 project_json 也未提供 --story")
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
        step("流水线", "正在校验故事包", story_id=pack.get("story_id"))
        issues = validate_story_pack(pack)
        if issues:
            fail("流水线", "故事包校验未通过")
            for i in issues:
                info("流水线", f"校验问题：{i}")
            raise SystemExit(2)
        register_story(pack, pack_path)
        ok("流水线", "故事包校验通过并已注册", story_id=pack["story_id"], chapter=pack.get("chapter_id"))
        if args.register_only or args.validate_only:
            return
        if args.expand_only:
            # expand 允许只读展开，但仍建议带 --story
            if story_id and pack.get("story_id") != story_id:
                fail("流水线", "展开前故事引用不匹配")
                raise SystemExit("故事引用不匹配")
            step("流水线", "仅展开 ShotJob，不成片")
            expanded = expand_story_pack(pack)
            path = out / "expanded_shot_jobs.json"
            _dump_json(path, expanded)
            ok("流水线", "展开完成", path=str(path), shots=len(expanded["shot_jobs"]))
            return
        # 成片硬门禁：必须显式 --story
        try:
            assert_story_bound_for_video(pack, story_id)
        except StoryError as e:
            fail("流水线", "成片门禁未通过（必须显式 --story）", error=e)
            raise SystemExit(2) from e

        shot_ids = [s.strip() for s in args.shots.split(",") if s.strip()] or None
        try:
            report = run_story_project(
                pack,
                out,
                story_id=story_id,
                shot_ids=shot_ids,
                force=args.force,
                retries=args.retries,
                keep_going=args.keep_going,
            )
        except StoryError as e:
            fail("流水线", "故事成片中断", error=e)
            raise SystemExit(2) from e
        if report.get("failures"):
            fail("流水线", "部分镜头失败", failed=",".join(report["failures"]))
            raise SystemExit(3)
        return

    # legacy
    run_legacy_project(pack, out)


if __name__ == "__main__":
    main()
