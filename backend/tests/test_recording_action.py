from fastapi.testclient import TestClient

from backend.main import app
from backend.services.process_manager import ProcessInfo, process_manager

client = TestClient(app)


class FakeStdin:
    def __init__(self):
        self.buffer = b""

    def write(self, data):
        self.buffer += data

    async def drain(self):
        pass

    def close(self):
        pass


class FakeProcess:
    def __init__(self):
        self.stdin = FakeStdin()
        self.returncode = None
        self.pid = 4321


def test_action_rejects_unknown_action():
    resp = client.post("/api/recording/action/whatever", json={"action": "explode"})
    assert resp.status_code == 400


def test_action_returns_404_for_unknown_process():
    resp = client.post("/api/recording/action/missing", json={"action": "save"})
    assert resp.status_code == 404


def test_action_sends_command_to_running_process():
    proc = FakeProcess()
    process_manager.processes["e2e-pid"] = ProcessInfo(proc, "recording")
    try:
        resp = client.post("/api/recording/action/e2e-pid", json={"action": "rerecord"})
        assert resp.status_code == 200
        assert proc.stdin.buffer == b"rerecord\n"
    finally:
        process_manager.processes.pop("e2e-pid", None)


def test_action_returns_409_for_stopped_process():
    proc = FakeProcess()
    proc.returncode = 0  # simulate an exited process
    process_manager.processes["stopped-pid"] = ProcessInfo(proc, "recording")
    try:
        resp = client.post("/api/recording/action/stopped-pid", json={"action": "save"})
        assert resp.status_code == 409
    finally:
        process_manager.processes.pop("stopped-pid", None)
