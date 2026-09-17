# -*- coding: utf-8 -*-
"""story_registry：章节寻址与故事→章节两级索引。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import story_registry
from story import StoryError


def _pack(story_id="demo", chapter_id="CH01", **over):
    pack = {
        "story_id": story_id,
        "chapter_id": chapter_id,
        "project_id": f"{story_id}_{chapter_id.lower()}",
        "script": {
            "logline": "l",
            "synopsis": "s",
            "episodes": [
                {"episode_id": "E01", "title": "t", "beats": [{"beat_id": "B01", "summary": "b"}]}
            ],
        },
        "characters": [{"id": "C01", "name": "甲", "identity_lock": "lock"}],
        "environments": [{"id": "ENV01", "name": "e", "scene_card": "card"}],
        "shots": [
            {
                "shot_id": "E01_S01_SH01",
                "episode_id": "E01",
                "environment_id": "ENV01",
                "character_ids": ["C01"],
                "action": "act",
            }
        ],
    }
    pack.update(over)
    return pack


@pytest.fixture
def stories_dir(tmp_path, monkeypatch):
    d = tmp_path / "stories"
    d.mkdir()
    monkeypatch.setattr(story_registry, "STORIES_DIR", d)
    monkeypatch.setattr(story_registry, "INDEX_PATH", d / "index.json")
    return d


def _write(p: Path, data: dict):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def test_chapter_pack_path_prefers_chapters_dir(stories_dir):
    _write(stories_dir / "demo" / "chapters" / "CH02.json", _pack(chapter_id="CH02"))
    _write(stories_dir / "demo" / "story.json", _pack(chapter_id="CH01"))
    assert story_registry.chapter_pack_path("demo", "CH02").name == "CH02.json"


def test_chapter_pack_path_falls_back_to_default_chapter(stories_dir):
    _write(stories_dir / "demo" / "story.json", _pack(chapter_id="CH01"))
    assert story_registry.chapter_pack_path("demo", "CH01").name == "story.json"


def test_chapter_pack_path_missing_raises(stories_dir):
    _write(stories_dir / "demo" / "story.json", _pack(chapter_id="CH01"))
    with pytest.raises(StoryError):
        story_registry.chapter_pack_path("demo", "CH99")


def test_resolve_with_chapter_id(stories_dir):
    _write(stories_dir / "demo" / "chapters" / "CH02.json", _pack(chapter_id="CH02"))
    pack, path = story_registry.resolve_story_pack("demo", chapter_id="CH02")
    assert pack["chapter_id"] == "CH02"
    assert path.name == "CH02.json"


def test_resolve_chapter_mismatch_raises(stories_dir):
    p = stories_dir / "demo" / "story.json"
    _write(p, _pack(chapter_id="CH01"))
    with pytest.raises(StoryError):
        story_registry.resolve_story_pack("demo", pack_path=p, chapter_id="CH02")


def test_register_story_writes_two_level_index(stories_dir):
    story_registry.register_story(_pack(chapter_id="CH01"), stories_dir / "demo" / "story.json")
    story_registry.register_story(
        _pack(chapter_id="CH02"), stories_dir / "demo" / "chapters" / "CH02.json"
    )
    idx = json.loads((stories_dir / "index.json").read_text(encoding="utf-8"))
    entry = idx["stories"]["demo"]
    assert set(entry["chapters"]) == {"CH01", "CH02"}
    assert entry["chapters"]["CH02"]["path"].endswith("chapters/CH02.json")
