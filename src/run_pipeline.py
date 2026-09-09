# -*- coding: utf-8 -*-
"""
Manhua pipeline over AutoDL.art hosted ComfyUI API.

Asset stages (定妆/静帧) need public image URLs — generate via Zealman panel
or any image tool, then feed into multi-ref / bridge / lipsync stages.

Project pack example:
{
  "project_id": "demo",
  "style_lock": "manhua_ink",
  "identity_lock": "...",
  "video_workflow": "manhua_video_ref",
  "steps": ["video"],
  "ref_images": ["https://.../char.png", "https://.../still.png"],
  "video": { "id": "...", "prompt": "...", "duration": 5 }
}
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from autodl_client import AutodlClient  # noqa: E402
from compile import (  # noqa: E402
    ensure_env,
    load_style_lock,
    load_workflow_config,
    run_shot,
)


def run_project(pack: dict[str, Any], out_root: Path) -> dict[str, Any]:
    steps = pack.get("steps") or ["video"]
    style = load_style_lock(pack.get("style_lock", "manhua_ink"))
    identity = pack.get("identity_lock") or ""
    project_id = pack.get("project_id") or "manhua"
    out_root.mkdir(parents=True, exist_ok=True)

    client = AutodlClient()
    cfg = load_workflow_config()
    report: dict[str, Any] = {"project_id": project_id, "steps": {}, "assets": {}}

    refs = list(pack.get("ref_images") or [])
    report["assets"]["ref_images"] = refs

    if "video" in steps:
        vid = dict(pack.get("video") or {})
        vid.setdefault("id", f"{project_id}_vid")
        vid.setdefault("shot_id", vid["id"])
        vid.setdefault("workflow", pack.get("video_workflow") or "manhua_video_ref")
        vid.setdefault("resolution", pack.get("resolution") or "768p横")
        if refs and not vid.get("ref_images"):
            vid["ref_images"] = refs
        if pack.get("ref_audios") and not vid.get("ref_audios"):
            vid["ref_audios"] = pack["ref_audios"]
        out = out_root / "03_video"
        out.mkdir(parents=True, exist_ok=True)
        meta = run_shot(
            client,
            vid,
            out,
            cfg=cfg,
            style_lock=style,
            identity_lock=identity,
        )
        report["steps"]["video"] = meta

    if "bridge" in steps:
        br = dict(pack.get("bridge") or {})
        br.setdefault("id", f"{project_id}_bridge")
        br.setdefault("shot_id", br["id"])
        br.setdefault("workflow", "manhua_bridge")
        br.setdefault("resolution", pack.get("resolution") or "768p横")
        out = out_root / "04_bridge"
        out.mkdir(parents=True, exist_ok=True)
        meta = run_shot(client, br, out, cfg=cfg, style_lock=style, identity_lock=identity)
        report["steps"]["bridge"] = meta

    if "lipsync" in steps:
        ls = dict(pack.get("lipsync") or {})
        ls.setdefault("id", f"{project_id}_lipsync")
        ls.setdefault("shot_id", ls["id"])
        ls.setdefault("workflow", "manhua_lipsync")
        ls.setdefault("resolution", pack.get("resolution") or "768p横")
        out = out_root / "05_lipsync"
        out.mkdir(parents=True, exist_ok=True)
        meta = run_shot(client, ls, out, cfg=cfg, style_lock=style, identity_lock=identity)
        report["steps"]["lipsync"] = meta

    report_path = out_root / "pipeline_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"report → {report_path}")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Run AutoDL manhua pipeline pack")
    parser.add_argument("project_json", type=Path)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--steps", default="", help="comma list override, e.g. video,bridge")
    args = parser.parse_args()

    ensure_env()
    pack = json.loads(args.project_json.read_text(encoding="utf-8"))
    if args.steps:
        pack["steps"] = [s.strip() for s in args.steps.split(",") if s.strip()]
    out = args.out or (ROOT / "runs" / (pack.get("project_id") or "manhua"))
    run_project(pack, out)


if __name__ == "__main__":
    main()
