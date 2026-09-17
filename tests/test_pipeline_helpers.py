# -*- coding: utf-8 -*-
"""run_pipeline 辅助：断点续跑、并发执行器、timeline/SRT。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from autodl_client import AutodlError
from compile import load_workflow_config
from run_pipeline import _load_existing_meta, _run_jobs_concurrent
from timeline import build_srt, build_timeline, first_result_url

CFG = load_workflow_config()


class FakeClient:
    """按脚本回放任务状态：每次 submit 取一段状态序列，弹空后恒 SUCCESS。"""

    poll_interval = 0.01

    def __init__(self, scripts, poll_timeout: float = 10):
        self.scripts = scripts
        self.poll_timeout = poll_timeout
        self.tasks: dict[str, list[str]] = {}
        self.n = 0

    def submit(self, workflow_id, body):
        self.n += 1
        tid = f"task{self.n}"
        self.tasks[tid] = list(self.scripts[self.n - 1])
        return tid

    def result(self, task_id):
        seq = self.tasks[task_id]
        status = seq.pop(0) if seq else "SUCCESS"
        if status == "SUCCESS":
            return {"status": "SUCCESS", "duration": 42, "results": ["http://x/v.mp4"]}
        return {"status": status}

    def download_results(self, data, out_dir, stem):
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        p = out_dir / f"{stem}_0.mp4"
        p.write_bytes(b"fake")
        return [p]


def _job(sid: str) -> dict:
    return {
        "shot_id": sid,
        "workflow": "manhua_video_ref",
        "prompt": "动作",
        "ref_images": ["http://x/0.png"],
    }


def test_concurrent_two_shots_succeed(tmp_path):
    client = FakeClient([["RUNNING", "SUCCESS"], ["SUCCESS"]])
    failures: dict[str, str] = {}
    metas = _run_jobs_concurrent(
        client, [_job("A"), _job("B")], tmp_path,
        cfg=CFG, style_lock="", retries=1, keep_going=False, failures=failures,
    )
    assert set(metas) == {"A", "B"}
    assert metas["A"]["duration"] == 42
    assert (tmp_path / "A_0.mp4").exists()
    assert failures == {}


def test_concurrent_retry_after_task_failed(tmp_path):
    client = FakeClient([["FAILED"], ["SUCCESS"]], poll_timeout=30)  # 退避 10s 后重提，预算需覆盖
    failures: dict[str, str] = {}
    metas = _run_jobs_concurrent(
        client, [_job("A")], tmp_path,
        cfg=CFG, style_lock="", retries=1, keep_going=False, failures=failures,
    )
    assert "A" in metas
    assert client.n == 2  # 失败整任务重提了一次


def test_concurrent_keep_going_records_failure(tmp_path):
    client = FakeClient([["FAILED"], ["FAILED"]], poll_timeout=0.5)  # 重提后预算耗尽，快速终态
    failures: dict[str, str] = {}
    metas = _run_jobs_concurrent(
        client, [_job("A")], tmp_path,
        cfg=CFG, style_lock="", retries=1, keep_going=True, failures=failures,
    )
    assert metas == {}
    assert "A" in failures


def test_concurrent_raises_when_not_keep_going(tmp_path):
    client = FakeClient([["FAILED"]])
    with pytest.raises(AutodlError):
        _run_jobs_concurrent(
            client, [_job("A")], tmp_path,
            cfg=CFG, style_lock="", retries=0, keep_going=False, failures={},
        )


def test_load_existing_meta_hit(tmp_path):
    f = tmp_path / "S1_0.mp4"
    f.write_bytes(b"x")
    meta = {"status": "SUCCESS", "files": [str(f)]}
    (tmp_path / "S1_meta.json").write_text(json.dumps(meta), encoding="utf-8")
    assert _load_existing_meta(tmp_path, "S1") is not None


def test_load_existing_meta_miss_when_file_gone(tmp_path):
    meta = {"status": "SUCCESS", "files": [str(tmp_path / "gone.mp4")]}
    (tmp_path / "S1_meta.json").write_text(json.dumps(meta), encoding="utf-8")
    assert _load_existing_meta(tmp_path, "S1") is None


def test_load_existing_meta_miss_when_failed(tmp_path):
    (tmp_path / "S1_meta.json").write_text(
        json.dumps({"status": "FAILED", "files": []}), encoding="utf-8"
    )
    assert _load_existing_meta(tmp_path, "S1") is None


def test_build_srt_cumulative_timing():
    jobs = [
        {"shot_id": "A", "duration": 5, "dialogue": "第一句"},
        {"shot_id": "B", "duration": 5, "dialogue": ""},
        {"shot_id": "C", "duration": 5, "dialogue": "第二句"},
    ]
    srt = build_srt(jobs)
    assert "00:00:00,000 --> 00:00:05,000" in srt
    assert "00:00:10,000 --> 00:00:15,000" in srt  # B 无对白但仍占位时间轴
    assert "第一句" in srt and "第二句" in srt


def test_build_timeline_uses_report_files():
    expanded = {
        "story_id": "s",
        "chapter_id": "CH01",
        "resolution": "768p横",
        "shot_jobs": [{"shot_id": "A", "duration": 5}],
    }
    report = {
        "shots": {
            "A": {
                "video": {"files": ["runs/A_0.mp4"]},
                "audio": {"files": ["runs/A_tts_0.wav"]},
            }
        }
    }
    clip = build_timeline(expanded, report)["clips"][0]
    assert clip["file"] == "runs/A_0.mp4"
    assert clip["audio_file"] == "runs/A_tts_0.wav"
    assert clip["duration_sec"] == 5.0


def test_first_result_url():
    assert first_result_url({"results": [{"url": "http://x/a.mp3"}]}) == "http://x/a.mp3"
    assert first_result_url({"results": ["http://x/b.mp3"]}) == "http://x/b.mp3"
    assert first_result_url(None) is None
    assert first_result_url({"results": []}) is None
