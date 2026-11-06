"""Call the local gateway; --direct explicitly selects the official API."""
import json
import os
import sys
import re
import stat
from pathlib import Path
import httpx
from openai import OpenAI


def local_connection() -> tuple[str, str, str]:
    """Read only this project's protected local connection settings."""
    root = Path(__file__).resolve().parents[1]
    directory = root / "data" / "local"
    if (root / "data").is_symlink() or directory.is_symlink():
        raise ValueError("Local profile directory must not be a symlink")
    if not directory.is_dir() or directory.stat().st_mode & 0o077 or directory.stat().st_uid != os.getuid():
        raise PermissionError("Local profile directory requires private permissions")
    for path in [directory / "gateway.json", directory / "client.key"]:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise PermissionError("Local profile files require private owner-only permissions")
    config = json.loads((directory / "gateway.json").read_text())
    port, model = config.get("port", 8787), config.get("model")
    if config.get("upstream") not in {"chatgpt-subscription", "openai-api-key"} or type(port) is not int or not 1 <= port <= 65535 or not isinstance(model, str) or not model.strip():
        raise ValueError("Invalid local profile configuration")
    key = (directory / "client.key").read_text().strip()
    if not re.fullmatch(r"[a-f0-9]{64}", key):
        raise ValueError("Invalid local key")
    return f"http://127.0.0.1:{port}/v1", key, model


def main() -> None:
    """Make one explicit request and print the response usage."""
    args = sys.argv[1:]
    if any(arg not in {"--direct", "--local"} for arg in args) or {"--direct", "--local"}.issubset(args):
        raise ValueError("Cannot combine --local and --direct or use unknown flags")
    direct = "--direct" in args
    connection = local_connection() if "--local" in args else None
    with OpenAI(
        base_url=connection[0] if connection else "https://api.openai.com/v1" if direct else "http://127.0.0.1:8787/v1",
        api_key=connection[1] if connection else os.environ["OPENAI_API_KEY"] if direct else os.environ.get("GATEWAY_LOCAL_API_KEY", "offline-test"),
        max_retries=0,
        http_client=None if direct else httpx.Client(trust_env=False, follow_redirects=False),
    ) as client:
        result = client.chat.completions.create(
            model=connection[2] if connection else os.environ.get("MODEL", "offline-model"),
            messages=[{"role": "user", "content": "Return JSON with answer equal to 2."}],
            response_format={"type": "json_object"},
        )
    print(json.dumps({"text": result.choices[0].message.content, "usage": result.usage.model_dump() if result.usage else None}))


if __name__ == "__main__":
    main()
