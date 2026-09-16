# -*- coding: utf-8 -*-
"""AutoDL large-model image generations (Qwen-Image / Z-Image-Turbo)."""
from __future__ import annotations

import base64
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests

try:
    from autodl_client import AutodlError
except ImportError:  # 包方式导入（import src.image_client）
    from .autodl_client import AutodlError


class ImageClient:
    def __init__(self, api_token: str | None = None, base_url: str | None = None) -> None:
        # Prefer dedicated image token; fall back to ComfyUI token
        self.api_token = (
            api_token
            or os.getenv("AUTODL_IMAGE_API_TOKEN")
            or os.getenv("AUTODL_API_TOKEN")
            or ""
        )
        if not self.api_token:
            raise AutodlError("AUTODL_API_TOKEN or AUTODL_IMAGE_API_TOKEN required for image gen")
        self.base_url = (base_url or os.getenv("AUTODL_BASE_URL", "https://www.autodl.art")).rstrip("/")
        self.session = requests.Session()
        # Docs show raw API_KEY; also try Bearer for OpenAI-style gateways
        self.session.headers.update(
            {
                "Authorization": self.api_token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )

    def generate(
        self,
        prompt: str,
        *,
        model: str = "Qwen-Image",
        size: str = "1664x928",
        n: int = 1,
    ) -> dict[str, Any]:
        url = f"{self.base_url}/api/v1/images/generations"
        body = {"model": model, "prompt": prompt, "size": size, "n": n}
        resp = self.session.post(url, json=body, timeout=300)
        try:
            data = resp.json()
        except Exception as e:
            raise AutodlError(f"image gen non-JSON HTTP {resp.status_code}: {resp.text[:400]}") from e
        if resp.status_code >= 400:
            # retry with Bearer if unauthorized-like
            if resp.status_code in (401, 403) and not self.api_token.lower().startswith("bearer "):
                self.session.headers["Authorization"] = f"Bearer {self.api_token}"
                resp2 = self.session.post(url, json=body, timeout=300)
                data = resp2.json()
                if resp2.status_code >= 400:
                    raise AutodlError(f"image gen HTTP {resp2.status_code}: {data}")
                return data
            raise AutodlError(f"image gen HTTP {resp.status_code}: {data}")
        return data

    def save_first(self, data: dict[str, Any], dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        items = data.get("data") or data.get("results") or []
        if isinstance(data.get("data"), dict):
            items = [data["data"]]
        if not items and data.get("url"):
            items = [data]
        if not items:
            raise AutodlError(f"image gen missing data: {data}")
        item = items[0]
        if isinstance(item, str):
            return self._write_url_or_b64(item, dest)
        b64 = item.get("b64_json") or item.get("base64")
        url = item.get("url")
        if b64:
            raw = base64.b64decode(b64)
            if dest.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
                dest = dest.with_suffix(".png")
            dest.write_bytes(raw)
            return dest
        if url:
            return self._write_url_or_b64(url, dest)
        raise AutodlError(f"image item has no url/b64: {item}")

    def _write_url_or_b64(self, value: str, dest: Path) -> Path:
        if value.startswith("data:") and "base64," in value:
            raw = base64.b64decode(value.split("base64,", 1)[1])
            dest.write_bytes(raw)
            return dest
        if value.startswith("http"):
            ext = Path(urlparse(value).path).suffix or ".png"
            if dest.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
                dest = dest.with_suffix(ext)
            with requests.get(value, timeout=180) as r:
                r.raise_for_status()
                dest.write_bytes(r.content)
            return dest
        # bare base64
        if re.fullmatch(r"[A-Za-z0-9+/=\s]+", value[:80] or ""):
            dest.write_bytes(base64.b64decode(value))
            return dest
        raise AutodlError(f"unsupported image payload prefix: {value[:40]}")
