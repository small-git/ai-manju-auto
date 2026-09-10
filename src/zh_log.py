# -*- coding: utf-8 -*-
"""中文运行日志：标明当前跑到哪一步、哪里出问题。"""
from __future__ import annotations

import sys
from typing import Any


def _ensure_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass


_ensure_utf8_stdio()


def step(module: str, msg: str, **extra: Any) -> None:
    _print(f"[进行中][{module}] {msg}{_fmt(extra)}")


def info(module: str, msg: str, **extra: Any) -> None:
    _print(f"[信息][{module}] {msg}{_fmt(extra)}")


def ok(module: str, msg: str, **extra: Any) -> None:
    _print(f"[完成][{module}] {msg}{_fmt(extra)}")


def fail(module: str, msg: str, **extra: Any) -> None:
    _print(f"[失败][{module}] 失败于：{msg}{_fmt(extra)}", err=True)


def warn(module: str, msg: str, **extra: Any) -> None:
    _print(f"[警告][{module}] {msg}{_fmt(extra)}", err=True)


def _fmt(extra: dict[str, Any]) -> str:
    if not extra:
        return ""
    parts = [f"{k}={v}" for k, v in extra.items()]
    return " | " + " ".join(parts)


def _print(line: str, *, err: bool = False) -> None:
    stream = sys.stderr if err else sys.stdout
    try:
        print(line, flush=True, file=stream)
    except UnicodeEncodeError:
        enc = getattr(stream, "encoding", None) or "utf-8"
        stream.buffer.write((line + "\n").encode(enc, errors="replace"))
        stream.buffer.flush()
