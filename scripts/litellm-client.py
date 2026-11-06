"""Exercise installed LiteLLM directly against isolated loopback gateways."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
from importlib.metadata import version

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads(Path(sys.argv[1]).read_text())
cache = ROOT / ".client-cache" / "litellm"
cache.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(cache)
sys.dont_write_bytecode = True
os.environ.update({
    "LITELLM_MODE": "PRODUCTION",
    "LITELLM_LOCAL_MODEL_COST_MAP": "True",
    "PYTHON_DOTENV_DISABLED": "1",
    "XDG_CACHE_HOME": str(cache),
    "HF_HOME": str(cache / "hf"),
    "MPLCONFIGDIR": str(cache / "matplotlib"),
})
forbidden_imports: list[str] = []


def import_guard(event: str, args: tuple[object, ...]) -> None:
    """Fail even caught attempts to load a case-specific framework."""
    if event == "import" and str(args[0]).split(".", 1)[0] in {"lotus", "agent_memory"}:
        forbidden_imports.append(str(args[0]))
        raise ImportError("Case framework imports are forbidden in LiteLLM acceptance")


sys.addaudithook(import_guard)
import litellm  # noqa: E402

litellm.telemetry = False
rows: list[dict[str, object]] = []
for case in manifest["cases"]:
    row: dict[str, object] = {"name": case["name"], "passed": False}
    try:
        response = litellm.completion(
            model="openai/offline-model",
            api_base=case["url"] + "/v1",
            api_key="offline-client-not-a-real-key",
            messages=[{"role": "user", "content": "Return JSON with answer 2, or the requested text."}],
            num_retries=0,
            timeout=5,
            **case["parameters"],
        )
    except Exception as error:
        row["error_type"] = type(error).__name__
        row["passed"] = case["error"]
    else:
        content = response.choices[0].message.content
        usage = response.usage.model_dump(exclude_none=True)
        row.update({"output": content, "usage": usage})
        expected = case["expected"]
        assert content == expected["text"], case["name"]
        assert usage["prompt_tokens"] == 58, case["name"]
        assert usage["completion_tokens"] == 13, case["name"]
        assert usage["total_tokens"] == 71, case["name"]
        cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
        reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
        assert cached == expected["cached"], (case["name"], "cached", cached)
        assert reasoning == expected["reasoning"], (case["name"], "reasoning", reasoning)
        row["passed"] = not case["error"]
    rows.append(row)

loaded_case_modules = [name for name in sys.modules if name.split(".", 1)[0] in {"lotus", "agent_memory"}]
result = {
    "passed": all(row["passed"] for row in rows) and not forbidden_imports and not loaded_case_modules,
    "litellm_version": version("litellm"),
    "cases": rows,
    "lotus_imported": bool([name for name in loaded_case_modules if name.startswith("lotus")]),
    "agent_memory_imported": bool([name for name in loaded_case_modules if name.startswith("agent_memory")]),
    "forbidden_import_attempts": forbidden_imports,
}
Path(manifest["clientReport"]).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"passed": result["passed"], "cases": len(rows), "lotus_imported": result["lotus_imported"], "agent_memory_imported": result["agent_memory_imported"]}))
sys.exit(0 if result["passed"] else 1)
