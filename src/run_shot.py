# -*- coding: utf-8 -*-
"""Run a single ShotJob against AutoDL.art."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from autodl_client import AutodlClient  # noqa: E402
from compile import ensure_env, load_style_lock, load_workflow_config, run_shot  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one AutoDL manhua shot")
    parser.add_argument("shot_json", type=Path)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--style-lock", default="")
    args = parser.parse_args()

    ensure_env()
    shot = json.loads(args.shot_json.read_text(encoding="utf-8"))
    out = args.out or (ROOT / "runs" / "shots" / (shot.get("shot_id") or "shot"))
    out.mkdir(parents=True, exist_ok=True)

    style = load_style_lock(args.style_lock or shot.get("style_lock"))
    client = AutodlClient()
    cfg = load_workflow_config()
    meta = run_shot(client, shot, out, cfg=cfg, style_lock=style)
    print(json.dumps({"ok": True, "files": meta["files"], "task_id": meta["task_id"], "alias": meta["workflow_alias"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
