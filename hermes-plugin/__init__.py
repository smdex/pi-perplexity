"""Hermes tools backed by the standalone Bun pplx CLI."""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

BUILTIN_SOURCES = ("web", "scholar", "social", "finance")
RECENCIES = ("hour", "day", "week", "month", "year")


def _config_path() -> Path:
    return Path.home() / ".config/pi-perplexity/config.json"


def _config() -> dict[str, Any]:
    try:
        data = json.loads(_config_path().read_text())
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise ValueError("Perplexity config must be a JSON object")
    return data


def _save_model(model: str | None) -> None:
    path = _config_path()
    data = _config()
    if model is None:
        data.pop("model", None)
    else:
        data["model"] = model
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".config-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(data, out, indent=2)
            out.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _home() -> Path:
    if os.environ.get("PI_PERPLEXITY_HOME"):
        return Path(os.environ["PI_PERPLEXITY_HOME"]).expanduser().resolve()
    for parent in Path(__file__).resolve().parents:
        if (parent / "cli/src/index.ts").is_file():
            return parent
    raise FileNotFoundError("Set PI_PERPLEXITY_HOME to the checkout containing cli/src/index.ts")


def build_cli_command(home: Path | str, command: str, *args: str) -> list[str]:
    if command not in ("ask", "research", "models", "connectors"):
        raise ValueError("unsupported pplx subcommand")
    return [os.environ.get("PI_PERPLEXITY_BUN", "bun"), str(Path(home) / "cli/src/index.ts"), command, *args]


def _invoke(home: Path, command: str, *args: str, timeout: float | None = None) -> Any:
    name = "PI_PERPLEXITY_RESEARCH_TIMEOUT_MS" if command == "research" else "PI_PERPLEXITY_ASK_TIMEOUT_MS"
    default = 600_000 if command == "research" else 90_000
    try:
        ms = float(os.environ.get(name, default))
        seconds = ms / 1000 if 0 < ms < float("inf") else default / 1000
    except ValueError:
        seconds = default / 1000
    result = subprocess.run(build_cli_command(home, command, *args), cwd=str(home / "cli"),
                            capture_output=True, text=True, check=False, timeout=timeout or seconds)
    try:
        data = json.loads(result.stdout)
    except (ValueError, TypeError) as error:
        raise RuntimeError("pplx returned invalid JSON or no output") from error
    if result.returncode or (isinstance(data, dict) and "error" in data):
        message = data.get("error") if isinstance(data, dict) else None
        raise RuntimeError(str(message or f"pplx exited with status {result.returncode}"))
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
    allowed = {"query", "sources", "limit", "files", "recency", "thread", "continue", "space", "persistent", "save", "save_images"}
    if set(args) - allowed:
        raise ValueError(f"unsupported arguments: {', '.join(sorted(set(args) - allowed))}")
    if not isinstance(args.get("query"), str) or not args["query"].strip():
        raise ValueError("query must be a non-empty string")
    for key in ("sources", "files"):
        if key in args and (not isinstance(args[key], list) or not all(isinstance(v, str) and v.strip() for v in args[key])):
            raise ValueError(f"{key} must be an array of non-empty strings")
    for key in ("thread", "space", "save", "save_images"):
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
    for key in ("recency", "thread", "space"):
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
    # yargs requires a positional query; prefix option-like queries rather than
    # letting them be interpreted as flags.
    query = args["query"]
    flags.append(f" {query}" if query.startswith("-") else query)
    return flags


def _effective_flags(args: dict[str, Any], mode: str) -> list[str]:
    flags = _flags(args)
    if mode == "ask":
        model = _config().get("model")
        if isinstance(model, str) and model.strip():
            flags[1:1] = ["--model", model]
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
        data = _invoke(_home(), mode, *_effective_flags(params, mode))
        if not isinstance(data, dict) or not isinstance(data.get("answer"), str):
            raise RuntimeError("pplx returned an unexpected result shape")
        return _result(data, params, mode)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        return _toon({"error": str(error), "metadata": {"mode": mode}})


def perplexity_ask(args: Any) -> str:
    return _run(args, "ask")


def perplexity_research(args: Any) -> str:
    return _run(args, "research")


def _schema(mode: str, sources: list[str]) -> dict[str, Any]:
    description = ("Deep research" if mode == "research" else "Ask Perplexity") + ". Sources: web, scholar, social, finance; GitHub connector when connected. Returns TOON."
    return {"name": f"perplexity_{mode}",
            "description": description,
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Question or research task"},
                "sources": {"type": "array", "items": {"type": "string", **({"enum": sources} if sources else {})}, "description": "Source or connected connector IDs; default web"},
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


def _config_command(models: dict[str, str]):
    preferred = ("gpt6_sol", "gemini38flash", "kimik3thinking", "claude50sonnet", "grok47", "claude55opus")

    def handle(raw_args: str) -> str:
        arg = raw_args.strip()
        try:
            if not arg:
                return f"Perplexity search model: {_config().get('model') or 'CLI default'}. /perplexity-config list | <model-id> | reset"
            if arg in ("list", "all"):
                entries = (list(models) if arg == "all" else [key for key in preferred if key in models])
                return "Available search models:\n" + "\n".join(f"{models[key]} — {key}" for key in entries) if entries else "Model catalog unavailable; retry after restarting Hermes."
            if arg == "reset":
                _save_model(None)
                return "Perplexity search model reset to CLI default."
            if arg not in models:
                return "Unknown model. Use /perplexity-config list."
            _save_model(arg)
            return f"Perplexity search model: {models[arg]} ({arg}). Research always uses pplx_alpha."
        except (OSError, ValueError) as error:
            return f"Perplexity config error: {error}"

    return handle


def register(ctx: Any) -> None:
    """Cache connected connectors and models at plugin startup."""
    models: dict[str, str] = {}
    sources: list[str] = list(BUILTIN_SOURCES)
    home: Path | None = None
    try:
        home = _home()
        catalog = _invoke(home, "models", "--all", "--json", timeout=8)
        if isinstance(catalog, dict) and not catalog.get("degraded"):
            models = {row["id"]: row.get("label") or row["id"] for row in catalog.get("models", [])
                      if isinstance(row, dict) and row.get("mode") == "search" and isinstance(row.get("id"), str)}
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        pass
    try:
        if home is None:
            home = _home()
        connected = _invoke(home, "connectors", "--json", timeout=8)
        if isinstance(connected, list):
            sources = list(dict.fromkeys(sources + [row["id"] for row in connected if isinstance(row, dict) and isinstance(row.get("id"), str)]))
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        pass
    for mode, handler in (("ask", perplexity_ask), ("research", perplexity_research)):
        ctx.register_tool(name=f"perplexity_{mode}", toolset="pi_perplexity", schema=_schema(mode, sources), handler=handler)
    ctx.register_command("perplexity-config", handler=_config_command(models), description="Configure Perplexity search model", args_hint="[list|all|model-id|reset]")


__all__ = ["build_cli_command", "perplexity_ask", "perplexity_research", "register"]
