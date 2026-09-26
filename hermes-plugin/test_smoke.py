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


class Completed:
    def __init__(self, data, returncode=0):
        self.returncode = returncode
        self.stdout = json.dumps(data)
        self.stderr = ""


def test_ask_options_and_toon() -> None:
    calls = []
    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return Completed({"answer": 'line 1\nline 2: "quoted"', "sources": [
            {"name": "First", "url": "https://first.example", "snippet": "a,b"},
            {"name": "Second", "url": "https://second.example", "snippet": "other"}],
            "model": "pplx_pro", "threadUrl": "https://www.perplexity.ai/search/abc", "images": []})
    with patch.object(_plugin.subprocess, "run", fake_run):
        result = _plugin.perplexity_ask({"query": "--what?", "sources": ["web", "scholar"],
                                         "files": ["report.pdf"], "limit": 1,
                                         "persistent": True, "thread": "abc"})
    assert 'message: "line 1\\nline 2: \\"quoted\\""' in result
    assert 'references[1]{title,url,snippet,timestamp}:' in result
    assert '"First","https://first.example","a,b",""' in result
    assert 'source_count: 2' in result
    assert 'file_references[0]:' in result
    command, options = calls[0]
    assert command[:3] == ["bun", str(Path.cwd() / "cli/src/index.ts"), "ask"]
    assert command[-1] == " --what?"
    assert command.count("--sources") == 2
    assert "--attach" in command and "--no-incognito" in command
    assert options["cwd"] == str(Path.cwd() / "cli")


def test_research_and_failure() -> None:
    with patch.object(_plugin.subprocess, "run", return_value=Completed({"answer": "research", "sources": [], "images": []})) as run:
        result = _plugin.perplexity_research({"query": "compare"})
    assert 'mode: "research"' in result
    assert run.call_args.args[0][2] == "research"
    assert "error:" in _plugin.perplexity_ask({"query": "x", "limit": True})
    assert "model" in _plugin.perplexity_ask({"query": "x", "model": "gpt6_sol"})
    with patch.object(_plugin.subprocess, "run", return_value=Completed({"error": "auth required"}, returncode=2)):
        assert 'error: "auth required"' in _plugin.perplexity_ask({"query": "x"})


def test_register_caches_catalog_in_schemas() -> None:
    registrations = []
    class Context:
        def register_tool(self, **kwargs):
            registrations.append(kwargs)
        def register_command(self, *args, **kwargs):
            pass
    with patch.object(_plugin, "_invoke", side_effect=[
        {"models": [{"id": "pplx_pro", "mode": "search"}, {"id": "pplx_alpha", "mode": "research"}]},
        [{"id": "my_connector"}],
    ]) as invoke:
        _plugin.register(Context())
    assert invoke.call_count == 2
    assert [item["name"] for item in registrations] == ["perplexity_ask", "perplexity_research"]
    for item in registrations:
        assert item["schema"]["name"] == item["name"]
        properties = item["schema"]["parameters"]["properties"]
        assert "my_connector" in properties["sources"]["items"]["enum"]
        assert "model" not in properties


def test_tool_schema_is_short_and_model_is_not_agent_selectable() -> None:
    schema = _plugin._schema("ask", ["web", "github_mcp_direct"])
    assert len(schema["description"]) < 200
    assert "GitHub" in schema["description"]
    props = schema["parameters"]["properties"]
    assert {"query", "files", "recency", "limit", "sources", "thread", "persistent"} <= set(props)
    assert "model" not in str(schema)
    assert _plugin._schema("research", ["web"])["description"].startswith("Deep research")


def test_recency_and_persistent_flags() -> None:
    flags = _plugin._flags(_plugin._validate({"query": "test", "recency": "week", "persistent": True}))
    assert flags == ["--json", "--recency", "week", "--no-incognito", "test"]
    assert "recency must" in _plugin.perplexity_ask({"query": "test", "recency": "decade"})


def test_config_command_controls_model_without_exposing_it_to_agent(tmp_path) -> None:
    registrations = []
    class Context:
        def register_tool(self, **kwargs):
            registrations.append(kwargs)
        def register_command(self, *args, **kwargs):
            registrations.append((args, kwargs))
    with patch.object(_plugin, "_invoke", side_effect=[
        {"models": [{"id": "gpt6_sol", "mode": "search", "label": "GPT-6 Sol"}]},
        [{"id": "github_mcp_direct", "displayName": "GitHub"}],
    ]), patch.object(_plugin, "_config_path", return_value=tmp_path / "config.json"):
        _plugin.register(Context())
        command = next(item for item in registrations if isinstance(item, tuple))
        handler = command[1]["handler"]
        assert "GPT-6 Sol" in handler("list")
        assert "gpt6_sol" in handler("gpt6_sol")
        assert json.loads((tmp_path / "config.json").read_text()) == {"model": "gpt6_sol"}
        assert "gpt6_sol" in handler("")
        assert "Unknown model" in handler("invalid")
        assert "gpt6_sol" in _plugin._effective_flags({"query": "test"}, "ask")
        assert "--model" not in _plugin._effective_flags({"query": "test"}, "research")
        assert "reset" in handler("reset")
        assert json.loads((tmp_path / "config.json").read_text()) == {}
    assert command[0] == ("perplexity-config",)


def test_file_references_only_report_verified_paths(tmp_path) -> None:
    reply = tmp_path / "reply.json"
    reply.write_text("{}")
    image = tmp_path / "image.png"
    image.write_bytes(b"png")
    data = {"answer": "hi", "images": [{"url": "https://example.com/image.png", "filename": "image.png"}]}
    result = _plugin._result(data, {"save": str(reply), "save_images": str(tmp_path)}, "ask")
    assert f'"{image}"' in result and f'"{reply}"' in result
    image.unlink()
    result = _plugin._result(data, {"save_images": str(tmp_path)}, "ask")
    assert '"image","https://example.com/image.png","",false' in result


if __name__ == "__main__":
    import os
    import tempfile
    test_ask_options_and_toon()
    test_research_and_failure()
    test_register_caches_catalog_in_schemas()
    test_tool_schema_is_short_and_model_is_not_agent_selectable()
    test_recency_and_persistent_flags()
    with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
        test_config_command_controls_model_without_exposing_it_to_agent(Path(directory))
        test_file_references_only_report_verified_paths(Path(directory))
    print("hermes-plugin smoke tests passed")
