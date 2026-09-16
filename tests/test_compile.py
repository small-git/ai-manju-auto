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
