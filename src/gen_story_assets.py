# -*- coding: utf-8 -*-
"""Generate still refs for a story via Qwen-Image, then optionally run one video shot."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from compile import ensure_env, load_style_lock, with_style  # noqa: E402
from image_client import ImageClient  # noqa: E402
from story import expand_story_pack, index_by_id  # noqa: E402
from story_registry import register_story, resolve_story_pack  # noqa: E402


def gen_one(client: ImageClient, prompt: str, *, model: str, size: str, dest: Path) -> str | None:
    """生图并保存；返回公网 URL（无 URL 时仅落盘并告警）。"""
    print("gen...", prompt[:120])
    data = client.generate(prompt, model=model, size=size)
    path = client.save_first(data, dest)
    print("saved", path)
    items = data.get("data") or []
    if items and isinstance(items[0], dict) and items[0].get("url"):
        return str(items[0]["url"])
    print(f"WARNING: no public url for {dest.name}; 视频步骤需要可托管的公网 URL")
    return None


def run_batch_assets(args, pack, pack_path: Path, out_dir: Path) -> None:
    """--assets：批量补齐所有缺失资产（角色 sheet / 道具 sheet / 环境 establishing / 各镜静帧）。"""
    style = load_style_lock(pack.get("style_lock"))
    chars = index_by_id(list(pack["characters"]))
    envs = index_by_id(list(pack["environments"]))
    client = ImageClient()
    changed = False

    for ch in pack["characters"]:
        if (ch.get("ref_images") or {}).get("sheet"):
            continue
        prompt = with_style(ch.get("sheet_prompt") or ch["identity_lock"], style, "")
        url = gen_one(client, prompt, model=args.model, size="1328x1328", dest=out_dir / f"{ch['id']}_sheet.png")
        if url:
            ch.setdefault("ref_images", {})["sheet"] = url
            changed = True

    for prop in pack.get("props") or []:
        if (prop.get("ref_images") or {}).get("sheet"):
            continue
        url = gen_one(client, with_style(prop["clue_lock"], style, ""), model=args.model, size="1328x1328", dest=out_dir / f"{prop['id']}_sheet.png")
        if url:
            prop.setdefault("ref_images", {})["sheet"] = url
            changed = True

    for env in pack["environments"]:
        if (env.get("ref_images") or {}).get("establishing"):
            continue
        url = gen_one(client, with_style(env["scene_card"], style, ""), model=args.model, size=args.size, dest=out_dir / f"{env['id']}_establishing.png")
        if url:
            env.setdefault("ref_images", {})["establishing"] = url
            changed = True

    for shot in pack["shots"]:
        if shot.get("still_url"):
            continue
        env = envs[shot["environment_id"]]
        identity = chars[shot["character_ids"][0]]["identity_lock"]
        prompt = with_style(
            shot.get("still_prompt") or f"{env.get('scene_card')}。{shot.get('action')}。{identity}",
            style,
            "",
        )
        url = gen_one(client, prompt, model=args.model, size=args.size, dest=out_dir / f"{shot['shot_id']}_still.png")
        if url:
            shot["still_url"] = url
            changed = True

    if changed:
        pack_path.write_text(json.dumps(pack, ensure_ascii=False, indent=2), encoding="utf-8")
        print("updated story pack assets")
    else:
        print("all assets present, nothing to do")


def run_single_shot(args, pack, pack_path: Path, out_dir: Path) -> None:
    style = load_style_lock(pack.get("style_lock"))
    chars = index_by_id(list(pack["characters"]))
    envs = index_by_id(list(pack["environments"]))
    shot = next((s for s in pack["shots"] if s["shot_id"] == args.shot), None)
    if not shot:
        raise SystemExit(f"shot not found: {args.shot}")

    client = ImageClient()
    asset_urls: dict[str, str] = {}
    if args.also_sheet:
        cid = shot["character_ids"][0]
        ch = chars[cid]
        prompt = with_style(ch.get("sheet_prompt") or ch["identity_lock"], style, "")
        url = gen_one(client, prompt, model=args.model, size="1328x1328", dest=out_dir / f"{cid}_sheet.png")
        if url:
            ch.setdefault("ref_images", {})["sheet"] = url
            asset_urls["sheet"] = url

    env = envs[shot["environment_id"]]
    identity = chars[shot["character_ids"][0]]["identity_lock"]
    still_prompt = with_style(
        shot.get("still_prompt") or f"{env.get('scene_card')}。{shot.get('action')}。{identity}",
        style,
        "",
    )
    still_path = out_dir / f"{args.shot}_still.png"
    url = gen_one(client, still_prompt, model=args.model, size=args.size, dest=still_path)
    if url:
        shot["still_url"] = url
        asset_urls["still"] = url
        pack_path.write_text(json.dumps(pack, ensure_ascii=False, indent=2), encoding="utf-8")
        print("updated story pack still_url")

    expanded = expand_story_pack(pack)
    print("shot refs after expand:", next(j for j in expanded["shot_jobs"] if j["shot_id"] == args.shot).get("ref_images"))
    print("assets", asset_urls)


def main() -> None:
    parser = argparse.ArgumentParser(description="生成故事定妆/静帧参考图（Qwen-Image）")
    parser.add_argument("--story", required=True)
    parser.add_argument("--shot", default="", help="shot_id to generate still for")
    parser.add_argument("--assets", action="store_true", help="批量补齐所有缺失资产（角色/道具/环境/各镜静帧）")
    parser.add_argument("--model", default="Qwen-Image")
    parser.add_argument("--size", default="1664x928")
    parser.add_argument("--also-sheet", action="store_true", help="also generate character sheet")
    args = parser.parse_args()

    if not args.shot and not args.assets:
        raise SystemExit("请指定 --shot <shot_id> 或 --assets")

    ensure_env()
    pack, pack_path = resolve_story_pack(args.story)
    register_story(pack, pack_path)

    out_dir = ROOT / "runs" / pack["story_id"] / pack["chapter_id"] / "01_assets"
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.assets:
        run_batch_assets(args, pack, pack_path, out_dir)
    else:
        run_single_shot(args, pack, pack_path, out_dir)


if __name__ == "__main__":
    main()
