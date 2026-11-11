"""Exercise the real monitor in a pseudoterminal; no model or remote calls."""
from __future__ import annotations
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

root = Path(__file__).resolve().parents[1]
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
guard = (root / 'tests' / 'network-guard.ts').as_uri()
local = '--local-root' in sys.argv
if local:
    root = Path(sys.argv[sys.argv.index('--local-root') + 1]).resolve()
command = [sys.argv[1], 'src/local-cli.ts', 'status'] if local else [sys.argv[1], '--import', guard, 'src/status-cli.ts', '--url', sys.argv[2]]
environment = {'PATH':'/usr/bin:/bin', 'TERM':'xterm-256color', 'NO_COLOR':'1', 'NODE_OPTIONS':f'--import {guard}'}
child = subprocess.Popen(command, cwd=root, stdin=slave, stdout=slave, stderr=slave, env=environment, start_new_session=True)
output = bytearray()

def wait_for(value: bytes, timeout: float = 6.0) -> None:
    """Read until a visible UI marker appears, with a bounded wait."""
    deadline = time.monotonic() + timeout
    start = len(output)
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            output.extend(os.read(master, 65536))
        if value in output[start:]:
            return
        if child.poll() is not None:
            break
    raise AssertionError(f'Missing terminal marker {value!r}: {output[-2000:]!r}')

try:
    wait_for('已连接'.encode())
    if '--disconnect' in sys.argv:
        wait_for('连接中断'.encode())
        assert '71'.encode() in output and '总计'.encode() in output
    else:
        os.write(master, b'\r')
        wait_for('用量明细'.encode())
        os.write(master, b'r')
        wait_for('原始数据'.encode())
        os.write(master, b'\x1b[6~\x1b[6~')
        wait_for(b'rawUsage')
        os.write(master, b'\x1b')
        wait_for('回车 明细'.encode())
        os.write(master, b'\t')
        wait_for('全部历史'.encode())
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 50, 0, 0))
        os.kill(child.pid, signal.SIGWINCH)
        wait_for(b'PlanValve')
    os.write(master, b'q')
    wait_for(b'\x1b[?1049l')
    assert child.wait(timeout=4) == 0
    restored = termios.tcgetattr(slave)
    assert restored[3] & (termios.ECHO | termios.ICANON) == original[3] & (termios.ECHO | termios.ICANON)
    assert b'\x1b[?25h' in output
    # Home alone cannot remove text to the right of a shortened line. Every
    # full redraw must clear the old frame before placing the new one.
    frames = bytes(output).split(b'\x1b[H')[1:]
    assert frames and all(frame.startswith(b'\x1b[2J') for frame in frames), 'redraw left stale terminal cells'
    (root/'reports'/('tui-disconnect.txt' if '--disconnect' in sys.argv else 'tui-terminal.txt')).write_bytes(output)
    print(json.dumps({'passed':True,'terminal_restored':True,'disconnect':'--disconnect' in sys.argv}))
finally:
    if child.poll() is None:
        child.terminate()
        child.wait(timeout=4)
    os.close(master)
    os.close(slave)
