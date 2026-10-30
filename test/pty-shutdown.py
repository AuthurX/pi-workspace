"""Opt-in real Pi PTY test. No model calls, personal config, or visible tabs."""
import errno
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import tempfile
import time
import uuid

project = Path(__file__).resolve().parents[1]
pi = shutil.which('pi')
assert pi, 'Pi CLI is required'


def check(action):
    with tempfile.TemporaryDirectory(prefix='pi-workspace-pty-') as tmp:
        root = Path(tmp)
        agent = root / 'agent'
        agent.mkdir()
        (agent / 'settings.json').write_text('{}')
        sid = str(uuid.uuid4())
        session = root / 'fixture.jsonl'
        session.write_text(json.dumps({'type': 'session', 'version': 3, 'id': sid,
                                      'timestamp': '2026-01-01T00:00:00.000Z', 'cwd': tmp}) + '\n')
        record = agent / 'pi-workspace' / 'members' / (sid + '.json')
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(tmp)
            env = dict(os.environ, HOME=tmp, PI_CODING_AGENT_DIR=str(agent), TERM='xterm-256color')
            for key in ['PI_WORKSPACE_HOOKS', 'PI_WORKSPACE_SRC', 'PI_CODING_AGENT_SESSION_DIR']:
                env.pop(key, None)
            os.execve(pi, [pi, '--offline', '--no-extensions', '--no-mcp', '--no-skills',
                           '--no-context-files', '--no-approve', '--extension',
                           str(project / 'extensions/open-all.ts'), '--session', str(session)], env)
        exited = False
        output = bytearray()

        def pump():
            if select.select([fd], [], [], 0.05)[0]:
                try:
                    output.extend(os.read(fd, 65536))
                except OSError as e:
                    if e.errno != errno.EIO:
                        raise

        try:
            deadline = time.monotonic() + 25
            while not record.exists() and time.monotonic() < deadline:
                pump()
            assert record.exists(), f'{action}: registration missing: {output[-2000:]!r}'
            # Allow the TUI to finish installing its signal handlers and input bindings.
            for _ in range(30):
                pump()
            if action == 'quit':
                os.write(fd, b'/quit\r')
            else:
                os.kill(pid, getattr(signal, action))
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                pump()
                done, _ = os.waitpid(pid, os.WNOHANG)
                if done:
                    exited = True
                    break
            assert exited, f'{action}: Pi did not exit: {output[-1000:]!r}'
            expected = action != 'quit'
            assert record.exists() == expected, f'{action}: member exists={record.exists()}, expected={expected}'
            if expected:
                import subprocess
                env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent))
                result = subprocess.run(['node', str(project / 'bin/pi-workspace.js'), 'list'],
                                        env=env, capture_output=True, text=True, timeout=10)
                assert result.returncode == 0 and '待恢复' in result.stdout, result.stdout + result.stderr
            print(f'PASS real Pi PTY {action}: member {"retained and listed as restorable" if expected else "removed"}')
        finally:
            if not exited:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
            os.close(fd)


for action in ['SIGHUP', 'SIGTERM', 'quit']:
    check(action)
