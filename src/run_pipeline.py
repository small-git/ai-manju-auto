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

from autodl_client import AutodlClient, AutodlError  # noqa: E402
from compile import (  # noqa: E402
    ensure_env,
    finalize_shot,
    load_style_lock,
    load_workflow_config,
    run_shot,
    submit_shot,
)
from constants import DEFAULT_RESOLUTION  # noqa: E402
from story import (  # noqa: E402
    StoryError,
    assert_production_approved,
    derive_bridge_frames,
    expand_story_pack,
    validate_story_pack,
    validate_state_continuity,
)
from timeline import build_srt, build_timeline, first_result_url  # noqa: E402
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


def _run_jobs_concurrent(
    client: AutodlClient,
    jobs: list[dict[str, Any]],
    out_dir: Path,
    *,
    cfg: dict[str, Any],
    style_lock: str,
    retries: int,
    keep_going: bool,
    failures: dict[str, str],
) -> dict[str, dict[str, Any]]:
    """并发执行：先全部提交（GPU 时间重叠），再统一轮询、成功即下载。

    失败任务整任务重提（指数退避）；keep_going=False 时首个终态失败即抛 AutodlError。
    """
    metas: dict[str, dict[str, Any]] = {}
    pending: dict[str, dict[str, Any]] = {}

    def _terminal_fail(sid: str, reason: str) -> None:
        if not keep_going:
            fail("流水线", "任务失败", shot_id=sid, error=reason)
            raise AutodlError(f"{sid}: {reason}")
        failures[sid] = reason
        warn("流水线", "任务失败，继续后续", shot_id=sid, error=reason)

    def _retry_or_terminal(rec: dict[str, Any], sid: str, reason: str) -> bool:
        """可重试则重提并返回 True（仍 pending）；否则终态失败返回 False。"""
        rec["attempts"] += 1
        if rec["attempts"] <= retries:
            wait = min(2 ** rec["attempts"] * 5, 60)
            warn(
                "流水线",
                "任务失败，退避后重提",
                shot_id=sid,
                attempt=rec["attempts"],
                wait_sec=wait,
                reason=reason,
            )
            try:
                rec["pending"] = submit_shot(
                    client,
                    rec["job"],
                    cfg=cfg,
                    style_lock=style_lock,
                    identity_lock=rec["job"].get("identity_lock") or "",
                )
                rec["next_at"] = time.time() + wait
                rec["poll_errors"] = 0
                return True
            except Exception as e:
                reason = f"{reason}; resubmit failed: {e}"
        _terminal_fail(sid, reason)
        return False

    for job in jobs:
        sid = str(job.get("shot_id"))
        try:
            p = submit_shot(
                client, job, cfg=cfg, style_lock=style_lock,
                identity_lock=job.get("identity_lock") or "",
            )
            pending[sid] = {"job": job, "pending": p, "attempts": 0, "poll_errors": 0, "next_at": 0.0}
        except Exception as e:
            _terminal_fail(sid, str(e))

    deadline = time.time() + client.poll_timeout
    while pending and time.time() < deadline:
        for sid, rec in list(pending.items()):
            if time.time() < rec["next_at"]:
                continue
            try:
                data = client.result(rec["pending"]["task_id"])
            except Exception as e:
                rec["poll_errors"] += 1
                warn("流水线", "轮询异常", shot_id=sid, count=rec["poll_errors"], error=e)
                if rec["poll_errors"] >= 5 and not _retry_or_terminal(rec, sid, f"poll error: {e}"):
                    pending.pop(sid, None)
                continue
            status = str(data.get("status") or "").upper()
            info("流水线", "轮询中", shot_id=sid, status=status)
            if status in {"SUCCESS", "COMPLETED", "DONE"}:
                try:
                    metas[sid] = finalize_shot(client, rec["pending"], data, out_dir)
                except Exception as e:
                    if not _retry_or_terminal(rec, sid, f"download error: {e}"):
                        continue
                pending.pop(sid, None)
            elif status in {"FAILED", "ERROR", "CANCELLED"}:
                if not _retry_or_terminal(rec, sid, f"task status={status}"):
                    pending.pop(sid, None)
        if pending:
            time.sleep(client.poll_interval)

    for sid in list(pending):
        _terminal_fail(sid, f"poll timeout after {client.poll_timeout}s")
    return metas


def _execute_jobs(
    client: AutodlClient,
    items: list[tuple[str, str, dict[str, Any]]],
    out_dir: Path,
    *,
    cfg: dict[str, Any],
    style_lock: str,
    retries: int,
    keep_going: bool,
    force: bool,
    serial: bool,
    report: dict[str, Any],
    failures: dict[str, str],
) -> None:
    """统一执行一个阶段的任务：跳过已有 → 并发/串行 → 写报告与失败表。

    items: (report_shot_id, report_key, job) 三元组。
    """
    todo: list[tuple[str, str, dict[str, Any]]] = []
    for rid, key, job in items:
        if not force:
            existing = _load_existing_meta(out_dir, str(job["shot_id"]))
            if existing:
                info("流水线", "跳过已有产物（--force 可重跑）", shot_id=job["shot_id"])
                report["shots"].setdefault(rid, {})[key] = {**existing, "skipped_existing": True}
                continue
        todo.append((rid, key, job))
    if not todo:
        return

    if serial or len(todo) == 1:
        for rid, key, job in todo:
            try:
                meta = _run_with_retry(
                    client,
                    job,
                    out_dir,
                    cfg=cfg,
                    style_lock=style_lock,
                    retries=retries,
                    identity_lock=job.get("identity_lock") or "",
                )
            except Exception as e:
                if not keep_going:
                    fail("流水线", "执行中断", shot_id=job["shot_id"], error=e)
                    raise
                failures[str(job["shot_id"])] = str(e)
                warn("流水线", "任务失败，继续后续", shot_id=job["shot_id"], error=e)
                report["shots"].setdefault(rid, {})[key] = {"status": "FAILED", "error": str(e)}
                continue
            report["shots"].setdefault(rid, {})[key] = meta
        return

    step("流水线", "并发模式：全部提交后统一轮询", count=len(todo))
    metas = _run_jobs_concurrent(
        client,
        [job for _, _, job in todo],
        out_dir,
        cfg=cfg,
        style_lock=style_lock,
        retries=retries,
        keep_going=keep_going,
        failures=failures,
    )
    for rid, key, job in todo:
        sid = str(job["shot_id"])
        if sid in metas:
            report["shots"].setdefault(rid, {})[key] = metas[sid]
        elif sid in failures:
            report["shots"].setdefault(rid, {})[key] = {"status": "FAILED", "error": failures[sid]}


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
    serial: bool = False,
) -> dict[str, Any]:
    step("流水线", "进入故事成片", story_id=story_id)
    assert_story_bound_for_video(pack, story_id)
    assert_production_approved(pack, shot_ids)
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

    # ---- audio：TTS 配音（对白 → 音频；产物 URL 链接给 lipsync）----
    if "audio" in steps:
        audio_dir = out_root / "02_audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        step("流水线", "开始 TTS 配音")
        audio_items: list[tuple[str, str, dict[str, Any]]] = []
        for job in jobs:
            if not str(job.get("dialogue") or "").strip():
                continue
            tts: dict[str, Any] = {
                "shot_id": f"{job['shot_id']}_tts",
                "workflow": "manhua_tts",
                "dialogue": job["dialogue"],
                "emotion": job.get("emotion") or "",
            }
            voice = job.get("voice_ref") or ((job.get("ref_audios") or [None])[0])
            if voice:
                tts["ref_audios"] = [voice]
            audio_items.append((job["shot_id"], "audio", tts))
        if audio_items:
            _execute_jobs(
                client,
                audio_items,
                audio_dir,
                cfg=cfg,
                style_lock=style,
                retries=retries,
                keep_going=keep_going,
                force=force,
                serial=serial,
                report=report,
                failures=failures,
            )
            # 产物 URL 链接：供 lipsync 参考音频（短时 URL，同轮次有效）
            for job in jobs:
                ameta = (report["shots"].get(job["shot_id"]) or {}).get("audio")
                url = first_result_url(ameta)
                if url:
                    job["ref_audios"] = [url]
        else:
            info("流水线", "无对白镜头，跳过 TTS")

    # ---- video：多参考成片 ----
    if "video" in steps:
        video_dir = out_root / "03_video"
        video_dir.mkdir(parents=True, exist_ok=True)
        step("流水线", "开始批量成片", count=len(jobs))
        video_items: list[tuple[str, str, dict[str, Any]]] = []
        for job in jobs:
            wf = job.get("workflow") or ""
            if (not job.get("ref_images")) and wf.startswith("manhua_video_ref"):
                msg = (
                    f"{job['shot_id']}: 多参考成片需要 ref_images/still_url。"
                    "请先生图填参考，或本镜临时改用 manhua_video_t2v 预览。"
                )
                if not keep_going:
                    fail("流水线", f"{job['shot_id']} 缺少参考图，无法走多参考成片", workflow=wf)
                    raise StoryError(msg)
                failures[job["shot_id"]] = msg
                warn("流水线", "单镜缺参考图，记录后继续", shot_id=job["shot_id"])
                report["shots"].setdefault(job["shot_id"], {})["video"] = {
                    "status": "FAILED",
                    "error": msg,
                }
                continue
            video_items.append((job["shot_id"], "video", job))
        _execute_jobs(
            client,
            video_items,
            video_dir,
            cfg=cfg,
            style_lock=style,
            retries=retries,
            keep_going=keep_going,
            force=force,
            serial=serial,
            report=report,
            failures=failures,
        )

    # ---- bridge：镜间首尾帧衔接 ----
    if "bridge" in steps:
        bridge_dir = out_root / "04_bridge"
        bridge_dir.mkdir(parents=True, exist_ok=True)
        step("流水线", "开始镜间 Bridge")
        jobs_by_id = {j["shot_id"]: j for j in expanded["shot_jobs"]}
        bridge_items: list[tuple[str, str, dict[str, Any]]] = []
        for job in jobs:
            if not job.get("bridge_from"):
                continue
            first_frame, last_frame = derive_bridge_frames(job, jobs_by_id)
            if not first_frame or not last_frame:
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
            br = {
                "shot_id": f"{job['shot_id']}_bridge",
                "workflow": "manhua_bridge",
                "resolution": job.get("resolution") or DEFAULT_RESOLUTION,
                "duration": job.get("duration") or 5,
                "prompt": job.get("prompt") or "",
                "first_frame": first_frame,
                "last_frame": last_frame,
            }
            bridge_items.append((job["shot_id"], "bridge", br))
        _execute_jobs(
            client,
            bridge_items,
            bridge_dir,
            cfg=cfg,
            style_lock=style,
            retries=retries,
            keep_going=keep_going,
            force=force,
            serial=serial,
            report=report,
            failures=failures,
        )

    # ---- lipsync：图+音频对口型 ----
    if "lipsync" in steps:
        lip_dir = out_root / "05_lipsync"
        lip_dir.mkdir(parents=True, exist_ok=True)
        step("流水线", "开始对口型")
        lip_items: list[tuple[str, str, dict[str, Any]]] = []
        for job in jobs:
            if not job.get("needs_lipsync"):
                continue
            img = job.get("still_url") or ((job.get("ref_images") or [None])[0])
            aud = (job.get("ref_audios") or [None])[0]
            if not img or not aud:
                warn(
                    "流水线",
                    f"{job['shot_id']} 跳过 lipsync（缺静帧或参考音频）",
                    needs_lipsync=True,
                )
                report["shots"].setdefault(job["shot_id"], {})["lipsync"] = {
                    "skipped": True,
                    "reason": "need still_url/ref_images[0] + ref_audios[0]（先跑 audio 步骤或填 ref_audios）",
                }
                continue
            lip = {
                "shot_id": f"{job['shot_id']}_lipsync",
                "workflow": "manhua_lipsync",
                "resolution": job.get("resolution") or DEFAULT_RESOLUTION,
                "audio_duration": job.get("audio_duration") or job.get("duration") or 5,
                "ref_images": [img],
                "ref_audios": [aud],
            }
            lip_items.append((job["shot_id"], "lipsync", lip))
        if lip_items:
            _execute_jobs(
                client,
                lip_items,
                lip_dir,
                cfg=cfg,
                style_lock=style,
                retries=retries,
                keep_going=keep_going,
                force=force,
                serial=serial,
                report=report,
                failures=failures,
            )
        else:
            info("流水线", "无 needs_lipsync 镜头，跳过对口型")

    # ---- export：timeline + SRT（有 video 步骤时自动产出，供剪映草稿导出）----
    if "video" in steps:
        try:
            export_dir = out_root / "04_export"
            export_dir.mkdir(parents=True, exist_ok=True)
            chapter = expanded.get("chapter_id") or "CH"
            tl_path = export_dir / f"{chapter}_timeline.json"
            _dump_json(tl_path, build_timeline(expanded, report))
            srt = build_srt(expanded["shot_jobs"])
            srt_path = None
            if srt.strip():
                srt_path = export_dir / f"{chapter}.srt"
                srt_path.write_text(srt, encoding="utf-8")
            ok("流水线", "时间线与字幕已导出", timeline=str(tl_path), srt=str(srt_path or "无对白"))
        except Exception as e:
            warn("流水线", "导出 timeline/SRT 失败（不影响成片）", error=e)

    # ---- summary：聚合统计 ----
    summary: dict[str, Any] = {
        "shots": len(jobs),
        "tasks_ok": 0,
        "tasks_failed": len(failures),
        "skipped_existing": 0,
        "api_duration_sec": 0.0,
        "files": 0,
    }
    for rep in report["shots"].values():
        for meta in rep.values():
            if not isinstance(meta, dict):
                continue
            if meta.get("skipped_existing"):
                summary["skipped_existing"] += 1
            if str(meta.get("status") or "").upper() in {"SUCCESS", "COMPLETED", "DONE"}:
                summary["tasks_ok"] += 1
            d = meta.get("duration")
            if isinstance(d, (int, float)):
                summary["api_duration_sec"] += d
            summary["files"] += len(meta.get("files") or [])
    report["summary"] = summary

    if failures:
        report["failures"] = failures
        warn("流水线", "存在失败镜头", failed=",".join(failures))

    _dump_json(out_root / "pipeline_report.json", report)
    ok("流水线", "故事成片报告已写出", path=str(out_root / "pipeline_report.json"), summary=summary)
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
    parser.add_argument("--serial", action="store_true", help="强制串行逐镜执行（默认并发：全部提交后统一轮询）")
    parser.add_argument("--chapter", default="", help="章节 ID（如 CH02）；缺省用默认章 story.json")
    args = parser.parse_args()

    ensure_env()
    story_id = (args.story or "").strip() or None
    chapter_id = (args.chapter or "").strip() or None
    step("流水线", "启动", story=story_id or "(未指定)", chapter=chapter_id or "(默认章)", file=str(args.project_json or ""))

    if story_id and not args.project_json:
        pack, pack_path = resolve_story_pack(story_id, chapter_id=chapter_id)
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
        if _is_story_pack(pack) and chapter_id and pack.get("chapter_id") != chapter_id:
            fail(
                "流水线",
                "章节引用不匹配",
                chapter=chapter_id,
                file_chapter_id=pack.get("chapter_id"),
            )
            raise SystemExit(
                f"章节引用不匹配：--chapter={chapter_id} vs file chapter_id={pack.get('chapter_id')}"
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
        for w in validate_state_continuity(pack):
            warn("连续性", w)
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
                serial=args.serial,
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
