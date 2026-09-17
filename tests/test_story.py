# -*- coding: utf-8 -*-
"""StoryPack 校验 / 展开 / Bridge 帧派生的核心契约测试。"""
from __future__ import annotations

import copy

import pytest

from story import (
    StoryError,
    assert_production_approved,
    derive_bridge_frames,
    expand_story_pack,
    validate_state_continuity,
    validate_story_pack,
)


def make_pack(**over):
    pack = {
        "story_id": "demo",
        "chapter_id": "CH01",
        "project_id": "demo_p",
        "script": {
            "logline": "一句话",
            "synopsis": "梗概",
            "episodes": [
                {
                    "episode_id": "E01",
                    "title": "集",
                    "beats": [{"beat_id": "B01", "summary": "拍"}],
                }
            ],
        },
        "characters": [
            {
                "id": "C01",
                "name": "甲",
                "identity_lock": "身份锁全文",
                "ref_images": {
                    "sheet": "http://x/sheet.png",
                    "face": "http://x/face.png",
                },
            }
        ],
        "environments": [
            {
                "id": "ENV01",
                "name": "场景",
                "scene_card": "场景卡",
                "ref_images": {"establishing": "http://x/env.png"},
            }
        ],
        "props": [
            {
                "id": "P01",
                "name": "道具",
                "clue_lock": "道具锁",
                "ref_images": {"sheet": "http://x/prop.png"},
            }
        ],
        "shots": [
            {
                "shot_id": "E01_S01_SH01",
                "episode_id": "E01",
                "environment_id": "ENV01",
                "character_ids": ["C01"],
                "prop_ids": ["P01"],
                "action": "动作",
            }
        ],
    }
    pack.update(over)
    return pack


def test_validate_ok():
    assert validate_story_pack(make_pack()) == []


def test_validate_unknown_character():
    pack = make_pack()
    pack["shots"][0]["character_ids"] = ["C99"]
    issues = validate_story_pack(pack)
    assert any("unknown character_id" in i for i in issues)


def test_validate_duplicate_shot_id():
    pack = make_pack()
    pack["shots"].append(copy.deepcopy(pack["shots"][0]))
    issues = validate_story_pack(pack)
    assert any("duplicate shot_id" in i for i in issues)


def test_validate_empty_ref_image_string_forbidden():
    pack = make_pack()
    pack["shots"][0]["ref_images"] = [""]
    issues = validate_story_pack(pack)
    assert any("empty string in ref_images" in i for i in issues)


def test_validate_invalid_bridge_from():
    pack = make_pack()
    pack["shots"][0]["bridge_from"] = "NOPE"
    issues = validate_story_pack(pack)
    assert any("bridge_from unknown" in i for i in issues)


def test_expand_assembles_identity_and_refs():
    expanded = expand_story_pack(make_pack())
    job = expanded["shot_jobs"][0]
    assert job["identity_lock"] == "身份锁全文"
    assert job["resolution"] == "768p横"
    assert job["workflow"] == "manhua_video_ref"
    refs = job["ref_images"]
    # 人物 sheet/face + 道具 sheet + 环境 establishing 自动组装且去重
    assert refs == [
        "http://x/sheet.png",
        "http://x/face.png",
        "http://x/prop.png",
        "http://x/env.png",
    ]


def test_expand_carries_still_url_for_bridge():
    pack = make_pack()
    pack["shots"][0]["still_url"] = "http://x/still.png"
    job = expand_story_pack(pack)["shot_jobs"][0]
    assert job["still_url"] == "http://x/still.png"
    assert "http://x/still.png" in job["ref_images"]


def test_expand_missing_identity_lock_raises():
    pack = make_pack()
    pack["characters"][0]["identity_lock"] = ""
    with pytest.raises(StoryError):
        expand_story_pack(pack)


def test_expand_invalid_pack_raises():
    pack = make_pack()
    del pack["environments"]
    with pytest.raises(StoryError):
        expand_story_pack(pack)


def test_derive_bridge_frames_from_still_url():
    job_a = {"shot_id": "A", "still_url": "http://x/a.png"}
    job_b = {"shot_id": "B", "bridge_from": "A", "still_url": "http://x/b.png"}
    first, last = derive_bridge_frames(job_b, {"A": job_a, "B": job_b})
    assert first == "http://x/a.png"
    assert last == "http://x/b.png"


def test_derive_bridge_frames_explicit_wins():
    job_a = {"shot_id": "A", "still_url": "http://x/a.png", "last_frame": "http://x/a_tail.png"}
    job_b = {
        "shot_id": "B",
        "bridge_from": "A",
        "still_url": "http://x/b.png",
        "first_frame": "http://x/b_head.png",
    }
    first, last = derive_bridge_frames(job_b, {"A": job_a, "B": job_b})
    assert first == "http://x/b_head.png"
    assert last == "http://x/b.png"


def test_derive_bridge_frames_missing_returns_none():
    job_b = {"shot_id": "B", "bridge_from": "A"}
    first, last = derive_bridge_frames(job_b, {})
    assert first is None
    assert last is None


def test_gate_blocks_unapproved_character():
    pack = make_pack()
    pack["characters"][0]["approved"] = False
    with pytest.raises(StoryError):
        assert_production_approved(pack)


def test_gate_blocks_unapproved_still():
    pack = make_pack()
    pack["shots"][0]["still_url"] = "http://x/still.png"
    pack["shots"][0]["still_approved"] = False
    with pytest.raises(StoryError):
        assert_production_approved(pack)


def test_gate_passes_and_respects_shot_filter():
    assert_production_approved(make_pack())  # 默认全批准，不抛
    pack = make_pack()
    pack["characters"][0]["approved"] = False
    assert_production_approved(pack, shot_ids=["NOT_SELECTED"])  # 未选中镜头不触发


def test_validate_grid_cell_requires_grid_plan():
    pack = make_pack()
    pack["shots"][0]["grid_cell"] = 3
    issues = validate_story_pack(pack)
    assert any("grid_cell" in i for i in issues)
    pack["shots"][0]["plan_path"] = "grid"
    assert validate_story_pack(pack) == []


def test_state_continuity_warning():
    pack = make_pack()
    sh2 = copy.deepcopy(pack["shots"][0])
    sh2["shot_id"] = "E01_S01_SH02"
    pack["shots"][0]["state"] = {"wardrobe": "青衣", "holding": "竹简"}
    sh2["state"] = {"wardrobe": "青衣", "holding": "长剑"}
    pack["shots"].append(sh2)
    warns = validate_state_continuity(pack)
    assert any("holding" in w and "不连续" in w for w in warns)


def test_state_continuity_ok_when_same():
    pack = make_pack()
    sh2 = copy.deepcopy(pack["shots"][0])
    sh2["shot_id"] = "E01_S01_SH02"
    pack["shots"][0]["state"] = {"holding": "竹简"}
    sh2["state"] = {"holding": "竹简"}
    pack["shots"].append(sh2)
    assert validate_state_continuity(pack) == []


def test_expand_injects_state_prev():
    pack = make_pack()
    sh2 = copy.deepcopy(pack["shots"][0])
    sh2["shot_id"] = "E01_S01_SH02"
    pack["shots"][0]["state"] = {"holding": "竹简"}
    pack["shots"].append(sh2)
    jobs = expand_story_pack(pack)["shot_jobs"]
    assert "state_prev" not in jobs[0]
    assert jobs[1]["state_prev"]["holding"] == "竹简"


def test_expand_carries_voice_ref():
    pack = make_pack()
    pack["characters"][0]["voice_ref"] = "http://x/voice.mp3"
    job = expand_story_pack(pack)["shot_jobs"][0]
    assert job["voice_ref"] == "http://x/voice.mp3"
