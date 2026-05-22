import asyncio

from backend.services.process_manager import ProcessInfo, ProcessManager


class FakeStdin:
    """Stand-in for asyncio StreamWriter, records bytes written."""

    def __init__(self):
        self.buffer = b""
        self.closed = False

    def write(self, data):
        self.buffer += data

    async def drain(self):
        pass

    def close(self):
        self.closed = True


class FakeProcess:
    """Stand-in for asyncio.subprocess.Process."""

    def __init__(self, returncode=None):
        self.stdin = FakeStdin()
        self.returncode = returncode
        self.pid = 4321


def _manager_with_process(pid="p1", returncode=None):
    pm = ProcessManager()
    proc = FakeProcess(returncode=returncode)
    pm.processes[pid] = ProcessInfo(proc, "recording")
    return pm, proc


def test_send_stdin_writes_line_to_running_process():
    pm, proc = _manager_with_process()
    ok = asyncio.run(pm.send_stdin("p1", "save"))
    assert ok is True
    assert proc.stdin.buffer == b"save\n"


def test_send_stdin_returns_false_for_missing_process():
    pm = ProcessManager()
    ok = asyncio.run(pm.send_stdin("nope", "save"))
    assert ok is False


def test_send_stdin_returns_false_for_exited_process():
    pm, proc = _manager_with_process(returncode=0)
    ok = asyncio.run(pm.send_stdin("p1", "save"))
    assert ok is False
    assert proc.stdin.buffer == b""


def test_send_stdin_returns_false_when_stdin_is_none():
    pm, proc = _manager_with_process()
    proc.stdin = None
    ok = asyncio.run(pm.send_stdin("p1", "save"))
    assert ok is False


def test_send_stdin_returns_false_on_broken_pipe():
    pm, proc = _manager_with_process()

    async def _raising_drain():
        raise BrokenPipeError()

    proc.stdin.drain = _raising_drain
    ok = asyncio.run(pm.send_stdin("p1", "save"))
    assert ok is False
