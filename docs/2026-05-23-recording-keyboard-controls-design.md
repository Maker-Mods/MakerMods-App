# 设计文档：录制过程中的键盘控制（← 重录 / → 保存）

- 日期：2026-05-23
- 涉及仓库：`MakerMods-LeRobot-UI`（前端 + 后端）、`lerobot-MakerMods`（录制循环）
- 状态：已与需求方确认方案，待评审

## 1. 目标

在 Web UI 录制数据集的过程中，操作员可用键盘方向键实时控制当前 episode：

- **`←` 左方向键** —— 取消当前录制，进入 reset 阶段，然后**重录本集**（episode 计数不增加）。
- **`→` 右方向键** —— 提前结束当前录制阶段并**保存本集**（计数 +1）；在 reset 阶段按下则快进跳过 reset。

行为需与 lerobot 命令行录制时的方向键快捷键完全一致。

## 2. 背景与核心障碍

lerobot 的录制循环用 `pynput` 做**全局键盘监听**：`lerobot-MakerMods/src/lerobot/utils/control_utils.py:133` 的 `init_keyboard_listener()` 创建 `events` 字典并注册按键回调；主循环 `src/lerobot/scripts/lerobot_record.py:456-503` 依据 `events` 的三个标志位运转：

| 标志位 | 触发键 | 效果 |
|---|---|---|
| `exit_early` | `→` | 提前结束当前 `record_loop()` 阶段 |
| `rerecord_episode` (+`exit_early`) | `←` | 结束录制 → 跑 reset → `clear_episode_buffer()` 丢弃本集 → 重录 |
| `stop_recording` (+`exit_early`) | `Esc` | 结束整个录制会话 |

UI 后端通过 `subprocess` 拉起 `lerobot-record`（`backend/services/process_manager.py`）。**网页里的 keydown 事件无法进入该子进程**，子进程的 `events` 字典也没有任何可被外部设置的通道。此外，headless 环境下 `init_keyboard_listener()` 直接返回 `listener=None`，连 pynput 都不可用。

因此本功能**必须同时改动两个仓库**：给 lerobot 子进程新增一条控制通道，UI 侧负责把按键转成命令送入该通道。

## 3. 方案选型

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. stdin 行命令（采用）** | `process_manager` 已把子进程 stdin 设为 PIPE，仅在启动后立即 `close()`。改为保持打开；lerobot 端起后台线程逐行读 `sys.stdin`，命中命令则设置 `events`。 | 复用现成管道，无新增进程间发现逻辑，改动面最小 |
| B. 本地 socket | lerobot 进程内开 socket server，后端连接发命令 | 双向能力强，但对本需求过度设计 |
| C. 控制文件 | 后端写临时文件，录制循环每帧轮询 | 不碰 stdin，但需协调文件路径并新增轮询 |

**采用方案 A。** 额外收益：stdin 通道与 `pynput`/headless 判断无关，可让 headless 环境也能控制录制。

## 4. 总体架构与数据流

```
[record-step.tsx]                [api/recording.py]          [process_manager.py]        [lerobot 子进程]
  window keydown                                                                          control_utils.py
   ←/→  ──► sendRecordingAction ──► POST /api/recording/  ──► send_stdin(pid, cmd) ──────► sys.stdin 读取线程
            (services.ts)            action/{process_id}      写入 process.stdin            └─► 设置 events 字典
                                                                                                  │
                                                                              lerobot_record.py 主循环
                                                                              依据 events 重录 / 保存
```

行为映射（**lerobot 主循环 `lerobot_record.py:456-503` 完全不改**，只复用既有事件语义）：

- `←` → 命令 `rerecord` → `events["rerecord_episode"]=True` 且 `exit_early=True`
- `→` → 命令 `save` → `events["exit_early"]=True`
- （现有「Stop」按钮路径不变；命令 `stop` 作为可选项一并实现，对应 `stop_recording`）

## 5. 详细设计

### 5.1 lerobot-MakerMods —— `src/lerobot/utils/control_utils.py`

在 `init_keyboard_listener()` 中新增一个 **daemon 线程**，与现有 pynput 监听并存、共用同一个 `events` 字典：

```python
def _stdin_command_reader(events: dict) -> None:
    cmd_map = {
        "rerecord": lambda: events.update(rerecord_episode=True, exit_early=True),
        "save":     lambda: events.update(exit_early=True),
        "stop":     lambda: events.update(stop_recording=True, exit_early=True),
    }
    for line in sys.stdin:            # 阻塞逐行读；daemon 线程随进程退出
        action = cmd_map.get(line.strip())
        if action:
            action()
```

约束：

- 仅当 `not sys.stdin.isatty()`（即被 UI 当子进程拉起）时启动该线程；真实终端运行时跳过，仅用 pynput，互不干扰。
- 线程设为 `daemon=True`，无需显式回收。
- 空行与未知命令直接忽略，兼容 `process_manager` 启动时写入的 `\n\n\n`。
- 该线程独立于 headless 判断，故 headless 下也可通过 stdin 控制。

### 5.2 MakerMods-LeRobot-UI 后端

**`backend/services/process_manager.py`**

- `start_process()`：当前第 85 行 `process.stdin.close()` 改为**不关闭**。仍写入 `\n\n\n` 以应付启动期交互式提示，但此后 stdin 持续打开。
- 新增 `async def send_stdin(self, process_id: str, text: str) -> bool`：取 `ProcessInfo`，若进程不存在/已退出/`stdin` 不可用则返回 `False`；否则写入 `text + "\n"` 并 `await drain()`，返回 `True`。
- `_stop_process_unlocked()`：在发送停止信号前 `try: process.stdin.close()`（容错），确保子进程的 stdin 读取线程能正常结束。

**`backend/api/recording.py`**

- 新增 `POST /api/recording/action/{process_id}`，请求体 `{"action": "rerecord" | "save" | "stop"}`：
  - 校验 `action` 属于白名单，否则 `400`。
  - 调用 `process_manager.send_stdin(process_id, action)`；返回 `False` 时按情况返回 `404`（进程不存在）或 `409`（进程未运行）。
  - 成功返回 `{"message": "..."}`。
- 在 `backend/models/recording.py` 新增对应的请求模型（如 `RecordingActionRequest`）。

### 5.3 MakerMods-LeRobot-UI 前端

**`frontend/lib/services.ts`** —— 新增：

```ts
sendRecordingAction: async (processId: string, action: "rerecord" | "save" | "stop"): Promise<void> => {
  await fetchAPI(`/api/recording/action/${processId}`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}
```

**`frontend/components/wizard/steps/record-step.tsx`** —— 在 `RecordStep` 内新增 `useEffect`：

- 挂载条件：`isRunning && (phase === "recording" || phase === "resetting")`；`encoding`/`done`/`idle` 阶段不挂监听。
- 监听 `window` 的 `keydown`：
  - `ArrowLeft` → `services.sendRecordingAction(id, "rerecord")`
  - `ArrowRight` → `services.sendRecordingAction(id, "save")`
  - 命中后 `e.preventDefault()`（防页面滚动）。
  - 忽略 `e.repeat`（长按只触发一次）。
  - 若 `document.activeElement` 为输入框则忽略（录制中表单已 `disabled`，基本无冲突，仍作防御）。
  - 轻量节流：~300ms 内不重复发送同一命令。
- 更新 `RecordingStatusCard` 的 `subtitle`，使快捷键可被发现，例如录制阶段追加提示「`←` 重录本集　`→` 保存并下一集」。

## 6. 错误处理

- 后端：`action` 不在白名单 → `400`；进程不存在 → `404`；进程已退出 → `409`；写 stdin 抛异常 → `500` 并附原因。
- 前端：`sendRecordingAction` 失败仅记录/轻提示，不打断录制（录制由子进程独立运行）。
- lerobot：stdin 读取线程对未知命令静默忽略；`sys.stdin` 关闭时 `for line in sys.stdin` 自然结束，线程退出。
- 命令幂等：`events` 标志位每帧被读取并重置，重复发送同一命令无副作用。

## 7. 边界情况

- `←`/`→` 在 **reset 阶段**同样生效：`→` 快进跳过 reset，`←` 触发重录，与 lerobot 既有语义一致。
- `→` 结束录制后由主循环 `save_episode()` 保存并计数 +1；`←` 走 `clear_episode_buffer()` 丢弃、计数不变。
- 现有「Stop」按钮与 `handleStop()` 路径保持不变。
- 子进程在真实终端中运行时（`isatty()` 为真）不启用 stdin 通道，行为与改动前一致。

## 8. 测试策略

- **lerobot 单元测试**：验证命令字符串 → `events` 字典的映射（`rerecord`/`save`/`stop`/未知/空行）。
- **后端测试**：`POST /api/recording/action/{process_id}` 对合法/非法 action、不存在/已退出进程的响应码；`send_stdin` 在 stdin 打开/关闭时的返回值。
- **手动端到端验证清单**：
  1. UI 启动录制，录制阶段按 `→` → 本集保存、计数 +1、进入下一集。
  2. 录制阶段按 `←` → 进入 reset → 重录本集、计数不变。
  3. reset 阶段按 `→` → 快进跳过 reset。
  4. 录制结束后按方向键无副作用（监听已卸载）。
  5. 命令行直接运行 `lerobot-record`，方向键仍由 pynput 正常工作。

## 9. 改动文件清单

| 仓库 | 文件 | 改动 |
|---|---|---|
| lerobot-MakerMods | `src/lerobot/utils/control_utils.py` | `init_keyboard_listener()` 新增 stdin 读取线程 |
| MakerMods-LeRobot-UI | `backend/services/process_manager.py` | stdin 不再关闭；新增 `send_stdin()`；停止时关闭 stdin |
| MakerMods-LeRobot-UI | `backend/api/recording.py` | 新增 `POST /api/recording/action/{process_id}` |
| MakerMods-LeRobot-UI | `backend/models/recording.py` | 新增 action 请求模型 |
| MakerMods-LeRobot-UI | `frontend/lib/services.ts` | 新增 `sendRecordingAction()` |
| MakerMods-LeRobot-UI | `frontend/components/wizard/steps/record-step.tsx` | keydown 监听 + 状态卡提示文案 |

## 10. 风险

- 主要风险点集中在「子进程 stdin 不再关闭」这一处改动——需确认 lerobot 录制启动期没有依赖 stdin 关闭（EOF）才能继续的逻辑；目前看启动期仅靠写入的 `\n\n\n` 应付提示，stdin 保持打开不影响。
- 两个仓库需同步发布，版本需匹配（旧 lerobot + 新 UI：命令被忽略，录制不受影响，属安全降级）。
