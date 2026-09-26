"""Hermes adapter for the pi-perplexity TypeScript extension."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

# This is the path installed by @earendil-works/pi-coding-agent in this repo.
# Keep alternatives below because package managers may hoist jiti differently.
JITI_REGISTER_RELATIVE_PATH = Path(
    "node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs"
)
JITI_REGISTER_FALLBACKS = (
    JITI_REGISTER_RELATIVE_PATH,
    Path("node_modules/jiti/lib/jiti-register.mjs"),
)
DEFAULT_TIMEOUT_MS = 90_000
DEFAULT_DEEP_TIMEOUT_MS = 600_000
RECENCIES = ("hour", "day", "week", "month", "year")


def _repo_home() -> Path:
    configured = os.environ.get("PI_PERPLEXITY_HOME")
    if configured:
        return Path(configured).expanduser()

    current = Path(__file__).resolve().parent
    for candidate in (current, *current.parents):
        package_json = candidate / "package.json"
        if not (candidate / "src/index.ts").is_file() or not package_json.is_file():
            continue
        try:
            metadata = json.loads(package_json.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(metadata, dict) and metadata.get("name") == "pi-perplexity":
            return candidate

    return Path.home() / "gh" / "pi-perplexity"


def _jiti_register(home: Path) -> Path:
    search_roots = (home, Path(__file__).resolve().parents[1], Path.cwd())
    for root in search_roots:
        for relative in JITI_REGISTER_FALLBACKS:
            candidate = root / relative
            if candidate.is_file():
                return candidate
    # Keep a deterministic command for diagnostics and mocked subprocess tests.
    return home / JITI_REGISTER_RELATIVE_PATH


def build_node_jiti_command(
    home: Path | str,
    args_json: str,
    node: str | None = None,
    subcommand: str = "ask",
) -> list[str]:
    """Build the dependency-free command used to execute the TypeScript CLI."""
    if subcommand not in ("ask", "deep"):
        raise ValueError("subcommand must be ask or deep")
    home = Path(home)
    executable = node or os.environ.get("PI_PERPLEXITY_NODE", "node")
    return [
        executable,
        "--no-deprecation",
        "--import",
        str(_jiti_register(home)),
        str(home / "src/cli.ts"),
        subcommand,
        args_json,
    ]


def _timeout_seconds(subcommand: str = "ask") -> float:
    if subcommand not in ("ask", "deep"):
        raise ValueError("subcommand must be ask or deep")
    default = DEFAULT_DEEP_TIMEOUT_MS if subcommand == "deep" else DEFAULT_TIMEOUT_MS
    env_name = "PI_PERPLEXITY_DEEP_TIMEOUT_MS" if subcommand == "deep" else "PI_PERPLEXITY_ASK_TIMEOUT_MS"
    raw = os.environ.get(env_name)
    if raw is None:
        return default / 1000
    try:
        value = float(raw)
    except ValueError:
        return default / 1000
    return value / 1000 if value > 0 else default / 1000


def _failure(message: str) -> str:
    return json.dumps({"ok": False, "error": message}, separators=(",", ":"))


def _validate_args(args: Any) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise ValueError("arguments must be an object")
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a non-empty string")

    result: dict[str, Any] = {"query": query}
    recency = args.get("recency")
    if recency is not None:
        if not isinstance(recency, str) or recency not in RECENCIES:
            raise ValueError("recency must be hour, day, week, month, or year")
        result["recency"] = recency

    limit = args.get("limit")
    if limit is not None:
        # bool is an int subclass, but is not a valid JSON schema integer here.
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
            raise ValueError("limit must be an integer from 1 to 50")
        result["limit"] = limit
    return result


def _run_cli(args: Any, subcommand: str) -> str:
    """Run pi-perplexity and always return a JSON string, never an exception."""
    try:
        payload = _validate_args(args)
        if subcommand == "deep":
            model = args.get("model") if isinstance(args, dict) else None
            if model is not None:
                if not isinstance(model, str) or not model.strip():
                    raise ValueError("model must be a non-empty string")
                payload["model"] = model
        home = _repo_home()
        args_json = json.dumps(payload, separators=(",", ":"))
        command = build_node_jiti_command(home, args_json, subcommand=subcommand)
        completed = subprocess.run(
            command,
            cwd=str(home),
            capture_output=True,
            text=True,
            timeout=_timeout_seconds(subcommand),
            check=False,
        )
        returncode = int(getattr(completed, "returncode", 0))
        stdout = getattr(completed, "stdout", "")
        parsed: Any = None
        if isinstance(stdout, str) and stdout.strip():
            try:
                parsed = json.loads(stdout.strip())
            except ValueError:
                parsed = None

        if isinstance(parsed, dict):
            if returncode == 0 or parsed.get("ok") is False:
                return json.dumps(parsed, separators=(",", ":"))

        if returncode != 0:
            detail = str(getattr(completed, "stderr", "") or "").strip()
            suffix = f": {detail[:240]}" if detail else ""
            return _failure(f"pi-perplexity exited with status {returncode}{suffix}")
        if not isinstance(stdout, str) or not stdout.strip():
            return _failure("pi-perplexity returned no output")
        if parsed is None:
            return _failure("pi-perplexity returned invalid JSON")
        return _failure("pi-perplexity returned a non-object JSON value")
    except subprocess.TimeoutExpired:
        return _failure("pi-perplexity search timed out")
    except Exception as error:  # noqa: BLE001 - plugin boundary must not raise
        return _failure(str(error) or error.__class__.__name__)


def perplexity_ask(args: Any) -> str:
    return _run_cli(args, "ask")


def perplexity_deep(args: Any) -> str:
    return _run_cli(args, "deep")


TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "Search query"},
        "recency": {"type": "string", "enum": list(RECENCIES), "description": "Filter results by recency"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Max sources to return"},
    },
    "required": ["query"],
    "additionalProperties": False,
}

DEEP_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "Deep research query"},
        "recency": {"type": "string", "enum": list(RECENCIES), "description": "Filter results by recency"},
        "model": {"type": "string", "default": "pplx_alpha", "description": "Deep research model override"},
    },
    "required": ["query"],
    "additionalProperties": False,
}


def register(ctx: Any) -> None:
    """Register the adapter in Hermes' pi_perplexity toolset."""
    ctx.register_tool(
        name="perplexity_ask",
        toolset="pi_perplexity",
        schema=TOOL_SCHEMA,
        handler=perplexity_ask,
        description="Search the web using Perplexity through pi-perplexity.",
    )
    ctx.register_tool(
        name="perplexity_deep",
        toolset="pi_perplexity",
        schema=DEEP_TOOL_SCHEMA,
        handler=perplexity_deep,
        description="Run deep research using Perplexity through pi-perplexity.",
    )


__all__ = [
    "JITI_REGISTER_RELATIVE_PATH",
    "JITI_REGISTER_FALLBACKS",
    "TOOL_SCHEMA",
    "DEEP_TOOL_SCHEMA",
    "build_node_jiti_command",
    "perplexity_ask",
    "perplexity_deep",
    "register",
]
