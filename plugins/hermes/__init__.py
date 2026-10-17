"""Hermes tools backed by the installed pplx CLI."""
from __future__ import annotations

import json
import os
import re
import subprocess
import signal
import time
from pathlib import Path
from typing import Any

RECENCIES = ("hour", "day", "week", "month", "year")


def _interrupted() -> bool:
    # Resolve lazily and poll on the handler thread: Hermes interrupts are
    # thread-scoped (including its acting_for_tid context).
    try:
        from tools.interrupt import is_interrupted
    except ImportError:
        return False  # Standalone use has timeout protection, not host cancellation.
    return is_interrupted()


def _stop(child: subprocess.Popen) -> None:
    def send(sig: int) -> None:
        try:
            if os.name == "posix":
                os.killpg(child.pid, sig)  # Only our start_new_session group.
            else:
                child.terminate() if sig == signal.SIGTERM else child.kill()
        except ProcessLookupError:
            pass
    send(signal.SIGTERM)
    try:
        child.communicate(timeout=0.3)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # Also remove descendants that outlive the wrapper or close its pipes.
        send(signal.SIGKILL)
        child.communicate()


def _invoke(command: str, *args: str) -> Any:
    name = "PI_PERPLEXITY_RESEARCH_TIMEOUT_MS" if command == "research" else "PI_PERPLEXITY_ASK_TIMEOUT_MS"
    default = 600_000 if command == "research" else 90_000
    try:
        ms = float(os.environ.get(name, default))
        seconds = ms / 1000 if 0 < ms < float("inf") else default / 1000
    except ValueError:
        seconds = default / 1000
    if _interrupted():
        raise RuntimeError("Perplexity request cancelled")
    try:
        child = subprocess.Popen(["pplx", command, *args], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                 start_new_session=os.name == "posix")
    except FileNotFoundError as error:
        raise RuntimeError("Install pplx and ensure it is on PATH") from error
    deadline = time.monotonic() + seconds
    try:
        while True:
            if _interrupted():
                raise RuntimeError("Perplexity request cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("Perplexity request timed out; retry or increase " + name)
            try:
                stdout, _ = child.communicate(timeout=min(0.1, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
        if _interrupted():
            raise RuntimeError("Perplexity request cancelled")
    except BaseException:
        _stop(child)
        raise
    result = child
    if result.returncode == 2:
        raise RuntimeError("Perplexity authentication required. Run `pplx login` in a terminal, then retry")
    if result.returncode:
        raise RuntimeError(f"pplx exited with status {result.returncode}; run pplx in a terminal for diagnostics")
    try:
        data = json.loads(stdout)
    except ValueError as error:
        raise RuntimeError("pplx returned invalid JSON or no output") from error
    if isinstance(data, dict) and "error" in data:
        raise RuntimeError("pplx reported an error; run pplx in a terminal for diagnostics")
    return data


def _toon(data: dict[str, Any]) -> str:
    """Encode the flat tool-result shape as TOON (quoted JSON scalars)."""
    scalar = lambda item: json.dumps(item, ensure_ascii=False)
    lines: list[str] = []
    for key, value in data.items():
        if isinstance(value, dict):
            lines.append(f"{key}:")
            lines.extend(f"  {field}: {scalar(item)}" for field, item in value.items())
        elif isinstance(value, list):
            if value and all(isinstance(row, dict) and tuple(row) == tuple(value[0]) for row in value):
                fields = list(value[0])
                lines.append(f"{key}[{len(value)}]{{{','.join(fields)}}}:")
                lines.extend("  " + ",".join(scalar(row[field]) for field in fields) for row in value)
            else:
                items = ",".join(scalar(item) for item in value)
                lines.append(f"{key}[{len(value)}]:" + (f" {items}" if items else ""))
        else:
            lines.append(f"{key}: {scalar(value)}")
    return "\n".join(lines)


def _validate(args: Any) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise ValueError("arguments must be an object")
    allowed = {"query", "model", "sources", "limit", "files", "recency", "thread", "continue", "space", "persistent", "save", "save_images"}
    if set(args) - allowed:
        raise ValueError(f"unsupported arguments: {', '.join(sorted(set(args) - allowed))}")
    if not isinstance(args.get("query"), str) or not args["query"].strip():
        raise ValueError("query must be a non-empty string")
    for key in ("sources", "files"):
        if key in args and (not isinstance(args[key], list) or not all(isinstance(v, str) and v.strip() for v in args[key])):
            raise ValueError(f"{key} must be an array of non-empty strings")
    if args.get("sources") == []:
        raise ValueError("sources must not be empty; use [\"web\"] for web-only scope")
    for key in ("model", "thread", "space", "save", "save_images"):
        if key in args and (not isinstance(args[key], str) or not args[key].strip()):
            raise ValueError(f"{key} must be a non-empty string")
    if "recency" in args and args["recency"] not in RECENCIES:
        raise ValueError("recency must be hour, day, week, month, or year")
    for key in ("continue", "persistent"):
        if key in args and not isinstance(args[key], bool):
            raise ValueError(f"{key} must be a boolean")
    if "limit" in args and (type(args["limit"]) is not int or not 1 <= args["limit"] <= 50):
        raise ValueError("limit must be an integer from 1 to 50")
    if args.get("thread") and args.get("continue"):
        raise ValueError("thread and continue cannot be combined")
    return args


def _flags(args: dict[str, Any]) -> list[str]:
    flags = ["--json"]
    for key in ("model", "recency", "thread", "space"):
        if key in args:
            flags.extend((f"--{key}", args[key]))
    for key, flag in (("sources", "--sources"), ("files", "--attach")):
        for item in args.get(key, []):
            flags.extend((flag, item))
    if args.get("continue"):
        flags.append("--continue")
    if args.get("persistent") is True:
        flags.append("--no-incognito")
    for key, flag in (("save", "--save"), ("save_images", "--save-images")):
        if key in args:
            flags.extend((flag, str(Path(args[key]).expanduser().resolve())))
    # yargs does not bind tokens after -- to required <query..>. Its handler
    # trims positional text, so this preserves option-looking query semantics.
    query = args["query"]
    flags.append(" " + query if query.startswith("-") else query)
    return flags


def _result(data: dict[str, Any], args: dict[str, Any], mode: str) -> str:
    sources = data.get("sources") or []
    if not isinstance(sources, list):
        sources = []
    refs = [{"title": row.get("name") or row.get("title") or "", "url": row.get("url") or "",
             "snippet": row.get("snippet") or "", "timestamp": row.get("timestamp") or ""}
            for row in sources[:args.get("limit", 50)] if isinstance(row, dict)]
    files: list[dict[str, Any]] = []
    for image in data.get("images") or []:
        if not isinstance(image, dict) or not isinstance(image.get("url"), str):
            continue
        path = ""
        if "save_images" in args and isinstance(image.get("filename"), str):
            safe = re.sub(r'[/\\?%*:|"<>]', "_", image["filename"])
            candidate = Path(args["save_images"]).expanduser().resolve() / safe
            if candidate.is_file():
                path = str(candidate)
        files.append({"kind": "image", "url": image["url"], "path": path, "saved": bool(path)})
    if "save" in args:
        saved = Path(args["save"]).expanduser().resolve()
        if saved.is_file():
            files.append({"kind": "reply", "url": "", "path": str(saved), "saved": True})
    return _toon({"message": data["answer"], "references": refs,
                  "metadata": {"model": data.get("model") or "", "thread_url": data.get("threadUrl") or "",
                               "mode": mode, "source_count": len(sources)}, "file_references": files})


def _run(args: Any, mode: str) -> str:
    try:
        params = _validate(args)
        data = _invoke(mode, *_flags(params))
        if not isinstance(data, dict) or not isinstance(data.get("answer"), str):
            raise RuntimeError("pplx returned an unexpected result shape")
        return _result(data, params, mode)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        return _toon({"error": str(error), "metadata": {"mode": mode}})


def perplexity_ask(args: Any) -> str:
    return _run(args, "ask")


def perplexity_research(args: Any) -> str:
    return _run(args, "research")


def _schema(mode: str) -> dict[str, Any]:
    description = ("Deep research" if mode == "research" else "Ask Perplexity") + ". Sources: web, scholar, social, finance; GitHub connector when connected. Returns TOON."
    return {"name": f"perplexity_{mode}",
            "description": description,
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Question or research task"},
                "model": {"type": "string", "description": "Explicit CLI model override; omitted inherits CLI settings"},
                "sources": {"type": "array", "minItems": 1, "items": {"type": "string"}, "description": "Source or connector IDs; omitted inherits CLI settings"},
                "recency": {"type": "string", "enum": list(RECENCIES), "description": "Filter results by age"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Maximum references returned"},
                "files": {"type": "array", "items": {"type": "string"}, "description": "Local files to upload"},
                "thread": {"type": "string", "description": "Thread slug or URL to continue"},
                "continue": {"type": "boolean", "description": "Continue most recent temp thread"},
                "space": {"type": "string", "description": "Space title or UUID"},
                "persistent": {"type": "boolean", "description": "Save conversation to history; default is temporary incognito"},
                "save": {"type": "string", "description": "Save JSON reply to this file"},
                "save_images": {"type": "string", "description": "Download generated images into this directory"},
            }, "required": ["query"], "additionalProperties": False}}


def register(ctx: Any) -> None:
    """Register tools without network calls or reading user configuration."""
    for mode, handler in (("ask", perplexity_ask), ("research", perplexity_research)):
        ctx.register_tool(name=f"perplexity_{mode}", toolset="pi_perplexity", schema=_schema(mode), handler=handler)


__all__ = ["perplexity_ask", "perplexity_research", "register"]
