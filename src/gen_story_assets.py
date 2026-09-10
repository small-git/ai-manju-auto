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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--story", required=True)
    parser.add_argument("--shot", required=True, help="shot_id to generate still for")
    parser.add_argument("--model", default="Qwen-Image")
    parser.add_argument("--size", default="1664x928")
    parser.add_argument("--also-sheet", action="store_true", help="also generate character sheet")
    args = parser.parse_args()

    ensure_env()
    pack, pack_path = resolve_story_pack(args.story)
    register_story(pack, pack_path)

    style = load_style_lock(pack.get("style_lock"))
    chars = index_by_id(list(pack["characters"]))
    envs = index_by_id(list(pack["environments"]))
    shot = next((s for s in pack["shots"] if s["shot_id"] == args.shot), None)
    if not shot:
        raise SystemExit(f"shot not found: {args.shot}")

    out_dir = ROOT / "runs" / pack["story_id"] / pack["chapter_id"] / "01_assets"
    out_dir.mkdir(parents=True, exist_ok=True)
    client = ImageClient()

    asset_urls: dict[str, str] = {}
    # Prefer saving local + using file URL is not accepted by AutoDL video API.
    # We keep local files; for video we need a public URL. If response includes url, reuse it.
    if args.also_sheet:
        cid = shot["character_ids"][0]
        ch = chars[cid]
        prompt = with_style(ch.get("sheet_prompt") or ch["identity_lock"], style, "")
        print("gen sheet...", prompt[:120])
        data = client.generate(prompt, model=args.model, size="1328x1328")
        path = client.save_first(data, out_dir / f"{cid}_sheet.png")
        print("saved", path)
        # extract url if any
        items = data.get("data") or []
        if items and isinstance(items[0], dict) and items[0].get("url"):
            ch.setdefault("ref_images", {})["sheet"] = items[0]["url"]
            asset_urls["sheet"] = items[0]["url"]

    env = envs[shot["environment_id"]]
    identity = chars[shot["character_ids"][0]]["identity_lock"]
    still_prompt = with_style(
        shot.get("still_prompt")
        or f"{env.get('scene_card')}。{shot.get('action')}。{identity}",
        style,
        "",
    )
    print("gen still...", still_prompt[:160])
    data = client.generate(still_prompt, model=args.model, size=args.size)
    still_path = client.save_first(data, out_dir / f"{args.shot}_still.png")
    print("saved", still_path)
    items = data.get("data") or []
    still_url = None
    if items and isinstance(items[0], dict) and items[0].get("url"):
        still_url = items[0]["url"]
    if still_url:
        shot["still_url"] = still_url
        asset_urls["still"] = still_url
        pack_path.write_text(json.dumps(pack, ensure_ascii=False, indent=2), encoding="utf-8")
        print("updated story pack still_url")
    else:
        meta = {"local_still": str(still_path), "raw": data}
        (out_dir / f"{args.shot}_still_meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print("WARNING: no public url in image response; video step needs a hostable URL")

    expanded = expand_story_pack(pack)
    print("shot refs after expand:", next(j for j in expanded["shot_jobs"] if j["shot_id"] == args.shot).get("ref_images"))
    print("assets", asset_urls)


if __name__ == "__main__":
    main()
