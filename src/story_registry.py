# -*- coding: utf-8 -*-
"""Story isolation: one story_id = one script universe."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from story import StoryError, validate_story_pack
    from zh_log import fail, info, ok, step, warn
except ImportError:  # 包方式导入（import src.story_registry）
    from .story import StoryError, validate_story_pack
    from .zh_log import fail, info, ok, step, warn

ROOT = Path(__file__).resolve().parents[1]
STORIES_DIR = ROOT / "stories"
INDEX_PATH = STORIES_DIR / "index.json"


def _to_repo_relative(pack_path: Path | None) -> str | None:
    """Always store portable relative paths in stories/index.json."""
    if pack_path is None:
        return None
    resolved = pack_path.resolve()
    try:
        return resolved.relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        warn("故事注册", "路径不在仓库内，仍写入相对尝试值", path=str(resolved))
        return pack_path.as_posix()


def load_index() -> dict[str, Any]:
    if not INDEX_PATH.exists():
        return {"stories": {}}
    return json.loads(INDEX_PATH.read_text(encoding="utf-8"))


def save_index(data: dict[str, Any]) -> None:
    STORIES_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def register_story(pack: dict[str, Any], pack_path: Path | None = None) -> None:
    story_id = pack.get("story_id")
    if not story_id:
        fail("故事注册", "缺少 story_id")
        raise StoryError("pack missing story_id")
    rel = _to_repo_relative(pack_path)
    idx = load_index()
    stories = idx.setdefault("stories", {})
    stories[story_id] = {
        "title": pack.get("title") or story_id,
        "chapter_id": pack.get("chapter_id"),
        "project_id": pack.get("project_id"),
        "path": rel,
        "logline": (pack.get("script") or {}).get("logline"),
    }
    save_index(idx)
    ok("故事注册", "已写入索引", story_id=story_id, path=rel)


def resolve_story_pack(story_id: str, pack_path: Path | None = None) -> tuple[dict[str, Any], Path]:
    """Load a story pack only by explicit story_id (and optional path)."""
    if not story_id or not str(story_id).strip():
        fail("故事加载", "未指定 --story")
        raise StoryError("必须显式指定 --story <story_id>，禁止无引用跨故事生成")

    step("故事加载", "正在解析故事包", story_id=story_id)
    path: Path | None = pack_path
    if path is None:
        idx = load_index()
        meta = (idx.get("stories") or {}).get(story_id)
        if not meta or not meta.get("path"):
            # fallback: stories/<story_id>/story.json or ch*.json
            cand = STORIES_DIR / story_id / "story.json"
            if cand.exists():
                path = cand
                info("故事加载", "索引缺失，改用默认路径", path=str(cand))
            else:
                fail("故事加载", "故事未注册且找不到默认文件", story_id=story_id)
                raise StoryError(
                    f"故事未注册且找不到默认文件: {story_id}。"
                    f"请先把剧本放到 stories/{story_id}/story.json 并校验注册。"
                )
        else:
            path = Path(meta["path"])
            if not path.is_absolute():
                path = ROOT / path
            if not path.exists():
                # stale absolute path from another machine → fallback
                cand = STORIES_DIR / story_id / "story.json"
                if cand.exists():
                    warn("故事加载", "索引路径失效，回退默认文件", stale=str(path), fallback=str(cand))
                    path = cand

    if not path.exists():
        fail("故事加载", "故事包文件不存在", path=str(path))
        raise StoryError(f"story pack not found: {path}")

    pack = json.loads(path.read_text(encoding="utf-8"))
    if pack.get("story_id") != story_id:
        fail(
            "故事加载",
            "故事引用不匹配",
            story=story_id,
            file_story_id=pack.get("story_id"),
        )
        raise StoryError(
            f"故事引用不匹配：命令 --story={story_id}，文件 story_id={pack.get('story_id')}。"
            "禁止用 A 故事引用生成 B 故事成片。"
        )
    issues = validate_story_pack(pack)
    if issues:
        fail("故事加载", "故事包校验失败", story_id=story_id)
        raise StoryError("story pack invalid:\n- " + "\n- ".join(issues))
    ok("故事加载", "故事包已加载", story_id=story_id, path=str(path))
    return pack, path


def assert_story_bound_for_video(pack: dict[str, Any], story_id: str | None) -> None:
    """Hard gate: video steps require an explicit story reference."""
    if not story_id:
        fail("成片门禁", "生成视频前必须引用故事 --story")
        raise StoryError(
            "生成视频前必须引用故事：请加 --story <story_id>。"
            "每个故事是独立剧本宇宙，避免剧情串戏。"
        )
    if pack.get("story_id") != story_id:
        fail("成片门禁", "引用故事与剧本不一致", story=story_id, pack=pack.get("story_id"))
        raise StoryError(
            f"拒绝成片：引用故事 {story_id} 与剧本 story_id={pack.get('story_id')} 不一致"
        )
