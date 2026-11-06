"""Run the local Python SDK example with external networking and writes blocked."""
import os
from pathlib import Path
import runpy
import sys

example = Path(sys.argv[1]).resolve()
root = example.parents[1]
denials: list[str] = []


def audit(event: str, args: tuple[object, ...]) -> None:
    """Permit only numeric loopback connections and project-local writes."""
    if event in {"socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr", "socket.getnameinfo"}:
        if event != "socket.getaddrinfo" or args[0] not in {"127.0.0.1", "::1"}:
            denials.append("external-dns")
            raise PermissionError("External DNS denied")
    if event == "socket.connect":
        address = args[1]
        if not isinstance(address, tuple) or address[0] not in {"127.0.0.1", "::1"}:
            denials.append("external-connect")
            raise PermissionError("External connection denied")
    if event == "socket.sendto":
        denials.append("udp")
        raise PermissionError("UDP denied")
    if event == "open" and isinstance(args[0], (str, bytes, os.PathLike)):
        path = Path(os.fsdecode(args[0])).absolute()
        if ".codex" in path.parts or path.name.startswith(".env"):
            denials.append("protected-config")
            raise PermissionError("Protected configuration read denied")
        flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC) and path != Path("/dev/null") and not path.is_relative_to(root):
            denials.append("external-write")
            raise PermissionError("External write denied")


sys.addaudithook(audit)
sys.argv = [str(example), "--local"]
try:
    runpy.run_path(str(example), run_name="__main__")
finally:
    if denials:
        raise RuntimeError(f"Offline Python example guard violations: {denials}")
