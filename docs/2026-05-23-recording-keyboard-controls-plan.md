# 录制过程键盘控制（← 重录 / → 保存）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web UI 录制数据集时，操作员可用键盘 `←`/`→` 实时重录或保存当前 episode。

**Architecture:** 给 lerobot 子进程新增一条 stdin 控制通道——lerobot 端起一个 daemon 线程逐行读 `sys.stdin` 并设置既有的 `events` 字典；UI 后端保持子进程 stdin 打开，新增一个 endpoint 把按键转成命令写入 stdin；前端在录制页面挂 `keydown` 监听。lerobot 录制主循环（`lerobot_record.py`）完全不改，只复用既有事件语义。

**Tech Stack:** Python 3 / asyncio / FastAPI（后端）、Next.js + React + TypeScript（前端）、pytest（测试）。

**涉及两个仓库：**
- `lerobot-MakerMods`（路径 `/home/lakesenberg/lerobot-MakerMods`）—— Task 1、2
- `MakerMods-LeRobot-UI`（路径 `/home/lakesenberg/MakerMods-LeRobot-UI`）—— Task 3-7

**前置准备：** 在两个仓库各自创建特性分支再开工：

```bash
git -C /home/lakesenberg/lerobot-MakerMods checkout -b feat/recording-stdin-control
git -C /home/lakesenberg/MakerMods-LeRobot-UI checkout -b feat/recording-keyboard-controls
```

参考 spec：`MakerMods-LeRobot-UI/docs/2026-05-23-recording-keyboard-controls-design.md`

---

## File Structure

| 仓库 | 文件 | 职责 | 改动 |
|---|---|---|---|
| lerobot-MakerMods | `src/lerobot/utils/control_utils.py` | 键盘/stdin 事件监听 | 新增 `apply_stdin_command()`、`_stdin_command_reader()`，在 `init_keyboard_listener()` 中启动 stdin 线程 |
| lerobot-MakerMods | `tests/utils/test_control_utils.py` | 上述函数的单元测试 | 新建 |
| MakerMods-LeRobot-UI | `backend/services/process_manager.py` | 子进程生命周期管理 | stdin 不再关闭；新增 `send_stdin()`；停止时关闭 stdin |
| MakerMods-LeRobot-UI | `backend/models/recording.py` | 录制相关 Pydantic 模型 | 新增 `RecordingActionRequest` |
| MakerMods-LeRobot-UI | `backend/api/recording.py` | 录制 API 路由 | 新增 `POST /api/recording/action/{process_id}` |
| MakerMods-LeRobot-UI | `backend/tests/test_process_manager.py` | `send_stdin` 单元测试 | 新建 |
| MakerMods-LeRobot-UI | `backend/tests/test_recording_action.py` | action endpoint 测试 | 新建 |
| MakerMods-LeRobot-UI | `pytest.ini` | 后端测试配置 | 新建 |
| MakerMods-LeRobot-UI | `requirements.txt` | Python 依赖 | 追加 `pytest`、`httpx` |
| MakerMods-LeRobot-UI | `frontend/lib/services.ts` | 前端 API 客户端 | 新增 `sendRecordingAction()` |
| MakerMods-LeRobot-UI | `frontend/components/wizard/steps/record-step.tsx` | 录制步骤页面 | 新增 `keydown` 监听 + 状态卡提示文案 |

---

## Task 1: lerobot —— stdin 命令解析纯函数

把「命令字符串 → events 字典」的映射抽成一个无副作用易测的纯函数。

**Files:**
- Create: `/home/lakesenberg/lerobot-MakerMods/tests/utils/test_control_utils.py`
- Modify: `/home/lakesenberg/lerobot-MakerMods/src/lerobot/utils/control_utils.py`（在 `init_keyboard_listener` 定义之前插入新函数）

- [ ] **Step 1: 写失败的测试**

创建 `/home/lakesenberg/lerobot-MakerMods/tests/utils/test_control_utils.py`：

```python
import io

from lerobot.utils.control_utils import apply_stdin_command


def _fresh_events():
    return {"exit_early": False, "rerecord_episode": False, "stop_recording": False}


def test_apply_stdin_command_save_sets_exit_early():
    events = _fresh_events()
    assert apply_stdin_command(events, "save\n") is True
    assert events == {"exit_early": True, "rerecord_episode": False, "stop_recording": False}


def test_apply_stdin_command_rerecord_sets_rerecord_and_exit_early():
    events = _fresh_events()
    assert apply_stdin_command(events, " rerecord ") is True
    assert events == {"exit_early": True, "rerecord_episode": True, "stop_recording": False}


def test_apply_stdin_command_stop_sets_stop_and_exit_early():
    events = _fresh_events()
    assert apply_stdin_command(events, "stop\n") is True
    assert events == {"exit_early": True, "rerecord_episode": False, "stop_recording": True}


def test_apply_stdin_command_unknown_returns_false_and_no_change():
    events = _fresh_events()
    assert apply_stdin_command(events, "garbage") is False
    assert events == _fresh_events()


def test_apply_stdin_command_blank_returns_false():
    events = _fresh_events()
    assert apply_stdin_command(events, "\n") is False
    assert events == _fresh_events()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/lakesenberg/lerobot-MakerMods && python -m pytest tests/utils/test_control_utils.py -v`
Expected: FAIL —— `ImportError: cannot import name 'apply_stdin_command'`

- [ ] **Step 3: 实现 `apply_stdin_command`**

在 `src/lerobot/utils/control_utils.py` 中，在 `def init_keyboard_listener():` 这一行**之前**插入：

```python
def apply_stdin_command(events: dict, line: str) -> bool:
    """Apply a single stdin control command to the recording events dict.

    Recognised commands (one per line): "rerecord", "save", "stop". These
    mirror the left/right-arrow and escape keyboard shortcuts so the UI
    backend can drive recording flow by writing lines to this process's
    stdin. Unknown commands and blank lines are ignored.

    Returns:
        True if the line matched a known command, False otherwise.
    """
    command = line.strip()
    if command == "rerecord":
        events["rerecord_episode"] = True
        events["exit_early"] = True
    elif command == "save":
        events["exit_early"] = True
    elif command == "stop":
        events["stop_recording"] = True
        events["exit_early"] = True
    else:
        return False
    return True
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/lakesenberg/lerobot-MakerMods && python -m pytest tests/utils/test_control_utils.py -v`
Expected: PASS —— 5 passed

- [ ] **Step 5: 提交**

```bash
cd /home/lakesenberg/lerobot-MakerMods
git add src/lerobot/utils/control_utils.py tests/utils/test_control_utils.py
git commit -m "feat(control_utils): add apply_stdin_command for stdin-driven recording control"
```

---

## Task 2: lerobot —— stdin 读取线程并接入键盘监听

新增逐行读取 stdin 的循环函数，并在 `init_keyboard_listener()` 中以 daemon 线程启动它（仅当 stdin 是管道时）。

**Files:**
- Modify: `/home/lakesenberg/lerobot-MakerMods/src/lerobot/utils/control_utils.py`
- Modify: `/home/lakesenberg/lerobot-MakerMods/tests/utils/test_control_utils.py`

- [ ] **Step 1: 写失败的测试**

在 `tests/utils/test_control_utils.py` 末尾追加（文件顶部已 `import io`）：

```python
from lerobot.utils.control_utils import _stdin_command_reader


def test_stdin_command_reader_applies_commands_until_eof():
    events = _fresh_events()
    stream = io.StringIO("save\nrerecord\n")
    _stdin_command_reader(events, stream)
    assert events["exit_early"] is True
    assert events["rerecord_episode"] is True


def test_stdin_command_reader_ignores_unknown_and_blank_lines():
    events = _fresh_events()
    stream = io.StringIO("\n\n\nhello\n")
    _stdin_command_reader(events, stream)
    assert events == _fresh_events()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/lakesenberg/lerobot-MakerMods && python -m pytest tests/utils/test_control_utils.py -v`
Expected: FAIL —— `ImportError: cannot import name '_stdin_command_reader'`

- [ ] **Step 3: 实现 reader 函数并接入 `init_keyboard_listener`**

3a. 在 `src/lerobot/utils/control_utils.py` 顶部的 import 区块加入 `sys` 与 `threading`。当前 import 区块为：

```python
import logging
import traceback
```

改为：

```python
import logging
import sys
import threading
import traceback
```

3b. 在 `apply_stdin_command`（Task 1 新增）之后、`def init_keyboard_listener():` 之前插入：

```python
def _stdin_command_reader(events: dict, stream) -> None:
    """Read recording control commands line-by-line from `stream` until EOF.

    Runs in a daemon thread so the UI backend (which launches this process
    as a subprocess) can drive recording flow by writing lines to stdin.
    """
    try:
        for line in stream:
            apply_stdin_command(events, line)
    except Exception as e:  # stream closed / decode error — stop quietly
        logging.debug(f"stdin command reader stopped: {e}")
```

3c. 在 `init_keyboard_listener()` 内，找到这段：

```python
    events = {}
    events["exit_early"] = False
    events["rerecord_episode"] = False
    events["stop_recording"] = False

    if is_headless():
```

在 `events["stop_recording"] = False` 与 `if is_headless():` 之间插入：

```python
    # Allow the UI backend (which launches this process as a subprocess) to
    # drive recording flow by writing commands to stdin. Only enabled when
    # stdin is a pipe (not an interactive terminal), so terminal usage keeps
    # relying on the pynput key listener below. Runs even in headless mode.
    try:
        stdin_is_pipe = sys.stdin is not None and not sys.stdin.isatty()
    except (ValueError, OSError):
        stdin_is_pipe = False
    if stdin_is_pipe:
        threading.Thread(
            target=_stdin_command_reader, args=(events, sys.stdin), daemon=True
        ).start()

```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/lakesenberg/lerobot-MakerMods && python -m pytest tests/utils/test_control_utils.py -v`
Expected: PASS —— 7 passed

- [ ] **Step 5: 提交**

```bash
cd /home/lakesenberg/lerobot-MakerMods
git add src/lerobot/utils/control_utils.py tests/utils/test_control_utils.py
git commit -m "feat(control_utils): drive recording events via stdin in init_keyboard_listener"
```

---

## Task 3: UI 后端 —— 测试环境 + `process_manager.send_stdin`

搭建后端最小 pytest 环境，保持子进程 stdin 打开，并新增 `send_stdin()`。

**Files:**
- Create: `/home/lakesenberg/MakerMods-LeRobot-UI/pytest.ini`
- Create: `/home/lakesenberg/MakerMods-LeRobot-UI/backend/tests/test_process_manager.py`
- Modify: `/home/lakesenberg/MakerMods-LeRobot-UI/requirements.txt`
- Modify: `/home/lakesenberg/MakerMods-LeRobot-UI/backend/services/process_manager.py`

- [ ] **Step 1: 建测试配置并安装依赖**

创建 `/home/lakesenberg/MakerMods-LeRobot-UI/pytest.ini`：

```ini
[pytest]
pythonpath = .
testpaths = backend/tests
```

在 `/home/lakesenberg/MakerMods-LeRobot-UI/requirements.txt` 末尾追加（若已存在则跳过该行）：

```
pytest>=8.0
httpx>=0.27
```

安装：

```bash
cd /home/lakesenberg/MakerMods-LeRobot-UI && pip install "pytest>=8.0" "httpx>=0.27"
```

- [ ] **Step 2: 写失败的测试**

创建 `/home/lakesenberg/MakerMods-LeRobot-UI/backend/tests/test_process_manager.py`：

```python
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd /home/lakesenberg/MakerMods-LeRobot-UI && python -m pytest backend/tests/test_process_manager.py -v`
Expected: FAIL —— `AttributeError: 'ProcessManager' object has no attribute 'send_stdin'`

- [ ] **Step 4: 实现 process_manager 改动**

在 `backend/services/process_manager.py` 中：

4a. `start_process()` 里把 stdin 写完换行后**不再关闭**。当前为：

```python
        # Send a few newlines to satisfy any interactive prompts, then close stdin
        if process.stdin:
            process.stdin.write(b"\n\n\n")
            await process.stdin.drain()
            process.stdin.close()
```

改为：

```python
        # Send a few newlines to satisfy any interactive startup prompts.
        # Keep stdin OPEN afterwards so control commands can be delivered
        # during the process lifetime (see send_stdin).
        if process.stdin:
            process.stdin.write(b"\n\n\n")
            await process.stdin.drain()
```

4b. 在 `get_status()` 方法**之后**新增 `send_stdin()`：

```python
    async def send_stdin(self, process_id: str, text: str) -> bool:
        """Write a single command line to a running process's stdin.

        Args:
            process_id: Process identifier.
            text: Command text; a trailing newline is appended.

        Returns:
            True if written successfully; False if the process is missing,
            has already exited, or its stdin is unavailable/broken.
        """
        async with self._lock:
            process_info = self.processes.get(process_id)

        if not process_info:
            return False
        process = process_info.process
        if process.returncode is not None or process.stdin is None:
            return False

        try:
            process.stdin.write((text + "\n").encode("utf-8"))
            await process.stdin.drain()
            return True
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            return False
```

4c. 在 `_stop_process_unlocked()` 中，找到这段：

```python
        # Send SIGTERM
        try:
            process_info.process.send_signal(signal.SIGTERM)
```

在 `# Send SIGTERM` 这一行**之前**插入：

```python
        # Close stdin so the subprocess's stdin reader thread sees EOF.
        if process_info.process.stdin is not None:
            try:
                process_info.process.stdin.close()
            except Exception:
                pass

```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /home/lakesenberg/MakerMods-LeRobot-UI && python -m pytest backend/tests/test_process_manager.py -v`
Expected: PASS —— 3 passed

- [ ] **Step 6: 提交**

```bash
cd /home/lakesenberg/MakerMods-LeRobot-UI
git add pytest.ini requirements.txt backend/tests/test_process_manager.py backend/services/process_manager.py
git commit -m "feat(process_manager): keep subprocess stdin open and add send_stdin"
```

---

## Task 4: UI 后端 —— action endpoint 与请求模型

新增 `POST /api/recording/action/{process_id}`，把 `rerecord`/`save`/`stop` 写入子进程 stdin。

**Files:**
- Modify: `/home/lakesenberg/MakerMods-LeRobot-UI/backend/models/recording.py`
- Modify: `/home/lakesenberg/MakerMods-LeRobot-UI/backend/api/recording.py`
- Create: `/home/lakesenberg/MakerMods-LeRobot-UI/backend/tests/test_recording_action.py`

- [ ] **Step 1: 写失败的测试**

创建 `/home/lakesenberg/MakerMods-LeRobot-UI/backend/tests/test_recording_action.py`：

```python
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/lakesenberg/MakerMods-LeRobot-UI && python -m pytest backend/tests/test_recording_action.py -v`
Expected: FAIL —— 三个用例均失败（endpoint 未注册，404 返回的是 FastAPI 默认 not-found，`test_action_rejects_unknown_action` 期望 400 但拿到 404）

- [ ] **Step 3: 新增请求模型**

在 `backend/models/recording.py` 的 `RecordingResponse` 类**之后**插入：

```python
class RecordingActionRequest(BaseModel):
    """Request to send a control action to a running recording process."""

    action: str = Field(..., description="Control action: rerecord, save, or stop")
```

- [ ] **Step 4: 新增 endpoint**

在 `backend/api/recording.py` 中：

4a. 修改 import。当前为：

```python
from backend.models.recording import RecordingRequest, RecordingResponse
from backend.models.system import ProcessStatus
```

改为：

```python
from backend.models.recording import RecordingActionRequest, RecordingRequest, RecordingResponse
from backend.models.system import ProcessState, ProcessStatus
```

4b. 在 `stop_recording()` endpoint 函数**之后**插入：

```python
_ALLOWED_ACTIONS = {"rerecord", "save", "stop"}


@router.post("/action/{process_id}")
async def send_recording_action(process_id: str, request: RecordingActionRequest):
    """Send a keyboard-equivalent control action to a running recording.

    Actions map to lerobot record-loop events:
      - "rerecord": discard current episode, reset, re-record (left arrow)
      - "save":     end current phase early and save the episode (right arrow)
      - "stop":     stop the whole recording session (escape)
    """
    if request.action not in _ALLOWED_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid action '{request.action}'. Allowed: {sorted(_ALLOWED_ACTIONS)}",
        )

    status = await process_manager.get_status(process_id)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Process {process_id} not found")
    if status.state != ProcessState.RUNNING:
        raise HTTPException(status_code=409, detail=f"Process {process_id} is not running")

    ok = await process_manager.send_stdin(process_id, request.action)
    if not ok:
        raise HTTPException(
            status_code=500, detail="Failed to deliver action to recording process"
        )

    return {"message": f"Action '{request.action}' sent"}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /home/lakesenberg/MakerMods-LeRobot-UI && python -m pytest backend/tests/ -v`
Expected: PASS —— 6 passed（Task 3 的 3 个 + 本 Task 的 3 个）

- [ ] **Step 6: 提交**

```bash
cd /home/lakesenberg/MakerMods-LeRobot-UI
git add backend/models/recording.py backend/api/recording.py backend/tests/test_recording_action.py
git commit -m "feat(recording): add POST /api/recording/action endpoint"
```

---

## Task 5: 前端 —— `services.sendRecordingAction`

> **说明：** 该前端仓库无单元测试框架（package.json 无 jest/vitest）。引入测试框架属范围外，故前端 Task 的验证 = TypeScript 构建通过（Step 验证）+ Task 7 手动 E2E。

**Files:**
- Modify: `/home/lakesenberg/MakerMods-LeRobot-UI/frontend/lib/services.ts`

- [ ] **Step 1: 新增 service 方法**

在 `frontend/lib/services.ts` 的 `services` 对象中，`stopRecording` 条目**之后**插入：

```ts
  /** Send a control action (rerecord / save / stop) to a running recording. */
  sendRecordingAction: async (
    processId: string,
    action: "rerecord" | "save" | "stop"
  ): Promise<void> => {
    await fetchAPI(`/api/recording/action/${processId}`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
  },
```

- [ ] **Step 2: 构建验证**

Run: `cd /home/lakesenberg/MakerMods-LeRobot-UI/frontend && npm run build`
Expected: 构建成功，无 TypeScript 类型错误。

- [ ] **Step 3: 提交**

```bash
cd /home/lakesenberg/MakerMods-LeRobot-UI
git add frontend/lib/services.ts
git commit -m "feat(frontend): add sendRecordingAction service"
```

---

## Task 6: 前端 —— 录制页面 keydown 监听 + 状态卡提示

**Files:**
- Modify: `/home/lakesenberg/MakerMods-LeRobot-UI/frontend/components/wizard/steps/record-step.tsx`

- [ ] **Step 1: 加 keydown 监听**

在 `record-step.tsx` 的 `RecordStep` 组件内，找到「Resume polling if process was already running」那个 `useEffect`（约 262-267 行）。在它**之后**插入：

```tsx
  // Keyboard controls during recording: ArrowLeft re-records the current
  // episode, ArrowRight saves it early. Mirrors lerobot's arrow-key
  // shortcuts; commands are delivered to the recording subprocess stdin.
  useEffect(() => {
    const processId = state.recordProcessId;
    if (!processId) return;
    if (phase !== "recording" && phase !== "resetting") return;

    let lastSent = 0;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.repeat) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;

      e.preventDefault();
      const now = Date.now();
      if (now - lastSent < 300) return; // lightweight throttle
      lastSent = now;

      const action = e.key === "ArrowLeft" ? "rerecord" : "save";
      services.sendRecordingAction(processId, action).catch(() => {});
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.recordProcessId, phase]);
```

- [ ] **Step 2: 更新状态卡提示文案**

在 `record-step.tsx` 的 `RecordingStatusCard` 内的 `configs` 对象中：

2a. 把 `recording` 的 `subtitle` 从：

```tsx
      subtitle: "Perform the task now.",
```

改为：

```tsx
      subtitle: "Perform the task now.   ← re-record episode    → save & continue",
```

2b. 把 `resetting` 的 `subtitle` 从：

```tsx
      subtitle: "Prepare the scene for the next episode.",
```

改为：

```tsx
      subtitle: "Prepare the scene for the next episode.   → skip reset",
```

- [ ] **Step 3: 构建验证**

Run: `cd /home/lakesenberg/MakerMods-LeRobot-UI/frontend && npm run build`
Expected: 构建成功，无 TypeScript 类型错误。

- [ ] **Step 4: 提交**

```bash
cd /home/lakesenberg/MakerMods-LeRobot-UI
git add frontend/components/wizard/steps/record-step.tsx
git commit -m "feat(frontend): arrow-key recording controls on record step"
```

---

## Task 7: 端到端手动验证

> 需连接真实机械臂硬件。逐项打勾确认。

**Files:** 无（验证任务）

- [ ] **Step 1: 启动后端与前端**

```bash
# 终端 A
cd /home/lakesenberg/MakerMods-LeRobot-UI && python -m backend.main
# 终端 B
cd /home/lakesenberg/MakerMods-LeRobot-UI/frontend && npm run dev
```

确保 `lerobot-MakerMods` 已用本特性分支安装（`pip install -e /home/lakesenberg/lerobot-MakerMods`）。

- [ ] **Step 2: 录制阶段按 `→`**

在 UI 走到录制步骤、点「Start Recording」，进入某一集录制中按 `→`：
预期 —— 本集提前结束并保存，episode 计数 +1，进入下一集（日志出现下一个 `Recording episode`）。

- [ ] **Step 3: 录制阶段按 `←`**

录制中按 `←`：
预期 —— 进入 reset 阶段（状态卡变「Reset the environment」），随后重录**同一集**，episode 计数**不变**，日志出现 `Re-record episode`。

- [ ] **Step 4: reset 阶段按 `→`**

在 reset 阶段按 `→`：
预期 —— 立即快进跳过 reset，进入下一集录制。

- [ ] **Step 5: 录制结束后按方向键**

全部 episode 完成、状态卡为 `done` 后按 `←`/`→`：
预期 —— 无任何反应（监听已卸载），页面不滚动、不报错。

- [ ] **Step 6: 命令行回归验证**

在普通终端直接运行一次 `lerobot-record ...`（不经 UI），录制中按方向键：
预期 —— pynput 监听照常工作，`←`/`→` 行为与改动前一致（证明 `isatty()` 分支正确，stdin 线程未启用）。

- [ ] **Step 7: 收尾**

确认两个仓库的特性分支均已提交全部改动；按团队流程合并或提 PR。

---

## Self-Review Notes

- **Spec 覆盖：** spec 第 5.1/5.2/5.3 节分别由 Task 1-2 / Task 3-4 / Task 5-6 实现；第 6 节错误处理由 Task 4 的状态码逻辑覆盖；第 8 节测试由各 Task 的单元测试 + Task 7 手动清单覆盖；第 9 节文件清单与本计划 File Structure 一致。
- **类型一致性：** `apply_stdin_command(events, line)`、`_stdin_command_reader(events, stream)`、`send_stdin(process_id, text)`、`sendRecordingAction(processId, action)`、命令字符串集合 `{rerecord, save, stop}` 在跨 Task 引用处命名一致。
- **已知偏差：** 前端无测试框架，Task 5/6 以构建通过 + Task 7 手动 E2E 替代单元测试（引入测试框架属范围外）。
