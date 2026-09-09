# -*- coding: utf-8 -*-
"""AutoDL.art ComfyUI API client: submit → poll → download."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests


class AutodlError(RuntimeError):
    pass


class AutodlClient:
    def __init__(
        self,
        base_url: str | None = None,
        api_token: str | None = None,
        poll_interval: float | None = None,
        poll_timeout: float | None = None,
    ) -> None:
        self.base_url = (base_url or os.getenv("AUTODL_BASE_URL", "https://autodl.art")).rstrip("/")
        self.api_token = api_token if api_token is not None else os.getenv("AUTODL_API_TOKEN", "")
        if not self.api_token:
            raise AutodlError("AUTODL_API_TOKEN is required (ComfyUI token group)")
        self.poll_interval = float(poll_interval or os.getenv("POLL_INTERVAL_SEC", "3"))
        self.poll_timeout = float(poll_timeout or os.getenv("POLL_TIMEOUT_SEC", "1800"))
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": self.api_token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )

    def submit(self, workflow_id: str, body: dict[str, Any]) -> str:
        url = f"{self.base_url}/api/v1/comfyui/comfyui_workflow/{workflow_id}"
        resp = self.session.post(url, json=body, timeout=120)
        data = self._parse(resp, f"POST {url}")
        task_id = (data.get("data") or {}).get("task_id")
        if not task_id:
            raise AutodlError(f"submit missing task_id: {data}")
        return str(task_id)

    def result(self, task_id: str) -> dict[str, Any]:
        url = f"{self.base_url}/api/v1/comfyui/comfyui_workflow/result/{task_id}"
        resp = self.session.get(url, timeout=60)
        data = self._parse(resp, f"GET {url}")
        return data.get("data") or data

    def wait_result(self, task_id: str) -> dict[str, Any]:
        deadline = time.time() + self.poll_timeout
        while time.time() < deadline:
            data = self.result(task_id)
            status = str(data.get("status") or "").upper()
            duration = data.get("duration")
            print(f"task={task_id} status={status} duration={duration}")
            if status in {"SUCCESS", "COMPLETED", "DONE"}:
                return data
            if status in {"FAILED", "ERROR", "CANCELLED"}:
                raise AutodlError(f"task failed: {data}")
            time.sleep(self.poll_interval)
        raise AutodlError(f"poll timeout after {self.poll_timeout}s task_id={task_id}")

    def download(self, url: str, dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        # result URLs are short-lived — download ASAP without auth usually
        with requests.get(url, stream=True, timeout=180) as resp:
            resp.raise_for_status()
            with dest.open("wb") as f:
                for chunk in resp.iter_content(chunk_size=1024 * 256):
                    if chunk:
                        f.write(chunk)
        return dest

    def download_results(self, data: dict[str, Any], out_dir: Path, stem: str) -> list[Path]:
        results = data.get("results") or []
        saved: list[Path] = []
        for i, item in enumerate(results):
            if isinstance(item, str):
                url = item
                ext = Path(urlparse(url).path).suffix or ".bin"
            elif isinstance(item, dict):
                url = item.get("url") or item.get("file_url") or ""
                ext = (
                    Path(urlparse(url).path).suffix
                    or ("." + (item.get("file_type") or "bin").lstrip("."))
                )
            else:
                continue
            if not url:
                continue
            path = out_dir / f"{stem}_{i}{ext}"
            self.download(url, path)
            saved.append(path)
            print(f"saved {path}")
        return saved

    @staticmethod
    def _parse(resp: requests.Response, label: str) -> Any:
        try:
            data = resp.json()
        except Exception as e:
            raise AutodlError(f"{label} non-JSON HTTP {resp.status_code}: {resp.text[:400]}") from e
        if resp.status_code >= 400:
            raise AutodlError(f"{label} HTTP {resp.status_code}: {data}")
        code = str(data.get("code") or "")
        if code and code.lower() not in {"success", "0", "ok"}:
            raise AutodlError(f"{label} API error: {data}")
        return data
