# -*- coding: utf-8 -*-
"""compile_body：ShotJob → AutoDL workflow body 的编译测试。"""
from __future__ import annotations

import pytest

from autodl_client import AutodlError
from compile import compile_body, load_workflow_config, resolve_workflow, with_style

CFG = load_workflow_config()


def test_compile_body_multi_ref_flattens_slots():
    shot = {
        "shot_id": "S1",
        "workflow": "manhua_video_ref",
        "prompt": "动作",
        "ref_images": ["http://x/0.png", "http://x/1.png"],
    }
    alias, workflow_id, body = compile_body(CFG, shot)
    assert alias == "manhua_video_ref"
    assert workflow_id == "minimax_h3_lightx2v_v5"
    assert body["ref_image_0"] == "http://x/0.png"
    assert body["ref_image_1"] == "http://x/1.png"
    assert "ref_image_2" not in body  # 未用槽位不传空串
    assert body["resolution"] == "768p横"
    assert body["duration"] == 5


def test_compile_body_style_and_identity_prepended():
    shot = {"workflow": "manhua_video_ref", "prompt": "动作", "ref_images": ["http://x/0.png"]}
    _, _, body = compile_body(CFG, shot, style_lock="画风锁", identity_lock="身份锁")
    assert body["prompt"] == "画风锁。身份锁。动作"


def test_compile_body_missing_required_raises():
    with pytest.raises(AutodlError):
        compile_body(CFG, {"workflow": "manhua_video_t2v", "prompt": ""})


def test_compile_body_ref_required_raises():
    with pytest.raises(AutodlError):
        compile_body(CFG, {"workflow": "manhua_video_ref", "prompt": "动作"})


def test_compile_body_bridge_requires_frames():
    shot = {"workflow": "manhua_bridge", "prompt": "衔接", "first_frame": "http://x/f.png"}
    with pytest.raises(AutodlError):
        compile_body(CFG, shot)


def test_resolve_workflow_stage_mapping():
    alias, wf = resolve_workflow(CFG, {"stage": "manhua_preview"})
    assert alias == "manhua_video_t2v"
    assert wf["kind"] == "t2v"


def test_resolve_workflow_unknown_alias_raises():
    with pytest.raises(AutodlError):
        resolve_workflow(CFG, {"workflow": "nope"})


def test_with_style_skips_empty_parts():
    assert with_style("动作", "", "") == "动作"
    assert with_style("动作", "画风锁") == "画风锁。动作"


def test_compile_body_tts_text_and_voice():
    shot = {
        "workflow": "manhua_tts",
        "dialogue": "天亮前必须离开这座城。",
        "emotion": "决意",
        "ref_audios": ["http://x/voice.mp3"],
    }
    alias, workflow_id, body = compile_body(CFG, shot)
    assert alias == "manhua_tts"
    assert workflow_id == "indextts2-v1"
    assert body["prompt_text"] == "天亮前必须离开这座城。"
    assert body["prompt_simple"] == "http://x/voice.mp3"
    assert body["emo_control_method"] == "与音色参考音频相同"
    # 决意 → calm 0.5 + angry 0.3
    assert body["emo_calm"] == 0.5
    assert body["emo_angry"] == 0.3


def test_compile_body_tts_melancholic_weights(monkeypatch):
    monkeypatch.delenv("PUBLIC_ASSET_BASE_URL", raising=False)
    shot = {"workflow": "manhua_tts", "dialogue": "别走。", "emotion": "克制的不舍与紧张", "ref_audios": ["http://x/v.mp3"]}
    _, _, body = compile_body(CFG, shot)
    assert body["emo_control_method"] == "与音色参考音频相同"
    assert body["emo_melancholic"] == 0.9
    assert body["emo_calm"] == 0.3


def test_compile_body_tts_emo_ref_audio(monkeypatch):
    monkeypatch.setenv("PUBLIC_ASSET_BASE_URL", "https://cdn.example/api/media")
    shot = {"workflow": "manhua_tts", "dialogue": "别走。", "emotion": "不舍", "ref_audios": ["http://x/v.mp3"]}
    _, _, body = compile_body(CFG, shot)
    assert body["emo_control_method"] == "使用情感参考音频"
    assert body["emo_ref_audio"] == "https://cdn.example/api/media/runs/shared/tts/emo_sad.wav"


def test_compile_body_tts_missing_text_raises():
    with pytest.raises(AutodlError):
        compile_body(CFG, {"workflow": "manhua_tts"})


def test_compile_body_tts_missing_voice_ref_raises():
    with pytest.raises(AutodlError):
        compile_body(CFG, {"workflow": "manhua_tts", "dialogue": "你好"})


def test_submit_and_finalize_split(tmp_path):
    """submit_shot/finalize_shot 拆分后可独立复用（并发基础）。"""

    class FakeClient:
        def submit(self, workflow_id, body):
            assert workflow_id == "minimax_h3_lightx2v_v5"
            return "task_x"

        def download_results(self, data, out_dir, stem):
            p = tmp_path / f"{stem}_0.mp4"
            p.write_bytes(b"x")
            return [p]

    from compile import finalize_shot, submit_shot

    shot = {"shot_id": "S1", "workflow": "manhua_video_ref", "prompt": "动作", "ref_images": ["http://x/0.png"]}
    pending = submit_shot(FakeClient(), shot, cfg=CFG)
    assert pending["task_id"] == "task_x"
    meta = finalize_shot(FakeClient(), pending, {"status": "SUCCESS", "duration": 5, "results": ["http://x/v.mp4"]}, tmp_path)
    assert meta["status"] == "SUCCESS"
    assert (tmp_path / "S1_meta.json").exists()
