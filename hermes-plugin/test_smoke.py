from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("__init__.py")
_spec = importlib.util.spec_from_file_location("pi_perplexity_hermes_plugin", MODULE_PATH)
assert _spec is not None and _spec.loader is not None
_plugin = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_plugin)


def test_builds_node_jiti_command_and_parses_json() -> None:
    calls = []

    class Completed:
        returncode = 0
        stdout = '{"ok":true,"answer":"fixture","sources":[]}'
        stderr = ""

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return Completed()

    with patch.dict(
        _plugin.os.environ,
        {"PI_PERPLEXITY_HOME": str(Path.cwd()), "PI_PERPLEXITY_NODE": "node-fixture"},
        clear=False,
    ), patch.object(_plugin.subprocess, "run", fake_run):
        result = json.loads(_plugin.perplexity_ask({"query": "fixture", "limit": 3}))

    assert result == {"ok": True, "answer": "fixture", "sources": []}
    assert len(calls) == 1
    command, options = calls[0]
    assert command[0] == "node-fixture"
    assert command[1:3] == ["--no-deprecation", "--import"]
    assert command[3].endswith("node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs")
    assert command[4].endswith("src/cli.ts")
    assert command[5] == "ask"
    assert json.loads(command[6]) == {"query": "fixture", "limit": 3}
    assert options["cwd"] == str(Path.cwd())


def test_failing_subprocess_returns_json_without_raising() -> None:
    def failing_run(*_args, **_kwargs):
        raise OSError("node unavailable")

    with patch.object(_plugin.subprocess, "run", failing_run):
        result = json.loads(_plugin.perplexity_ask({"query": "fixture"}))
    assert result["ok"] is False
    assert "node unavailable" in result["error"]


def test_deep_uses_deep_command_model_and_timeout() -> None:
    calls = []

    class Completed:
        returncode = 0
        stdout = '{"ok":true,"answer":"deep fixture","sources":[]}'
        stderr = ""

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return Completed()

    with patch.dict(
        _plugin.os.environ,
        {
            "PI_PERPLEXITY_HOME": str(Path.cwd()),
            "PI_PERPLEXITY_NODE": "node-fixture",
            "PI_PERPLEXITY_DEEP_TIMEOUT_MS": "1234",
        },
        clear=False,
    ), patch.object(_plugin.subprocess, "run", fake_run):
        result = json.loads(_plugin.perplexity_deep({"query": "fixture"}))

    assert result == {"ok": True, "answer": "deep fixture", "sources": []}
    command, options = calls[0]
    assert command[5] == "deep"
    assert json.loads(command[6]) == {"query": "fixture"}
    assert options["timeout"] == 1.234
    assert _plugin.DEEP_TOOL_SCHEMA["parameters"]["properties"]["model"]["default"] == "pplx_alpha"


def test_handlers_accept_runtime_kwargs() -> None:
    """Hermes injects kwargs (task_id, etc.) into tool handlers — must not raise."""
    class Completed:
        returncode = 0
        stdout = '{"ok":true,"answer":"x","sources":[]}'
        stderr = ""

    with patch.dict(
        _plugin.os.environ,
        {"PI_PERPLEXITY_HOME": str(Path.cwd()), "PI_PERPLEXITY_NODE": "node-fixture"},
        clear=False,
    ), patch.object(_plugin.subprocess, "run", lambda *a, **k: Completed()):
        ask = json.loads(_plugin.perplexity_ask({"query": "x"}, task_id="t1"))
        deep = json.loads(_plugin.perplexity_deep({"query": "x"}, task_id="t2"))

    assert ask["ok"] is True
    assert deep["ok"] is True


def test_registers_ask_and_deep_tools() -> None:
    registrations = []

    class Context:
        def register_tool(self, **kwargs):
            registrations.append(kwargs)

    _plugin.register(Context())
    assert [item["name"] for item in registrations] == ["perplexity_ask", "perplexity_deep"]
    assert all(item["toolset"] == "pi_perplexity" for item in registrations)


if __name__ == "__main__":
    test_builds_node_jiti_command_and_parses_json()
    test_failing_subprocess_returns_json_without_raising()
    test_deep_uses_deep_command_model_and_timeout()
    test_handlers_accept_runtime_kwargs()
    test_registers_ask_and_deep_tools()
    print("hermes-plugin smoke tests passed")
