# Onboarding — SO-101 barcode-scanning project

You're picking up an in-flight session. The goal of this project is to teach a bimanual SO-101 robot to **scan UPC-A barcodes** (12-digit retail codes — example target: `054732101818`) with "precise context" — accuracy is paramount. We're doing this on Apple Silicon Mac, modifying the [lerobot-MakerMods](https://github.com/Maker-Mods/lerobot-MakerMods) fork directly, with the [MakerMods-App](https://github.com/Maker-Mods/MakerMods-App) web UI as the harness.

Everything below is the actual current state — what's done, what's broken, and what to do next.

---

## TL;DR — pick up here

1. Read this whole doc.
2. Start servers (one command each in `.claude/launch.json`).
3. Resolve hardware blockers: 1 arm needs motor PSU on; 2 arms have dirty motor IDs.
4. Finish calibrating the 4 SO-101 arms in the wizard.
5. Once teleop works for a sustained run with leader → follower mirroring, **the strategy doc for the barcode-scanning pipeline is the next deliverable** (see "Pending strategy work" at the bottom).

The hard infrastructure work is done. The wizard's diagnostics now name the *exact* hardware fault when something fails — read those alerts before assuming a code bug.

---

## What this branch is

- Branch: **`claude/strange-herschel-07e993`** in [MakerMods-App](https://github.com/Maker-Mods/MakerMods-App)
- Tip commit: `5fd177c` — "fix: wizard reliability — port scanner filter, subprocess PATH, error diagnostics"
- Worktree path on this Mac: `/Users/healthyli/Documents/GitHub/MakerMods-App/.claude/worktrees/strange-herschel-07e993`
- Main repo path: `/Users/healthyli/Documents/GitHub/MakerMods-App`
- lerobot fork (editable install): `/Users/healthyli/Documents/GitHub/lerobot-MakerMods`

To work on someone else's machine: clone both repos, check out the branch above, then follow "Local environment" below.

---

## Local environment (already set up on this Mac)

| What | Where |
|---|---|
| Conda env | `/opt/anaconda3/envs/lerobot` (Python 3.10.20) |
| lerobot install | editable from `~/Documents/GitHub/lerobot-MakerMods` via `pip install -e ".[feetech]"` |
| Backend deps | `pip install -r requirements.txt` into the same env |
| Frontend deps | `npm install` in `frontend/` |
| ffmpeg + cmake | `conda install -c conda-forge ffmpeg cmake` into the env |

**On a fresh machine**, replicate with:
```bash
conda create -n lerobot python=3.10 -y
conda install -n lerobot -c conda-forge ffmpeg cmake -y
cd ~/Documents/GitHub/lerobot-MakerMods   # clone first if needed
/opt/anaconda3/envs/lerobot/bin/pip install -e ".[feetech]"
cd ~/Documents/GitHub/MakerMods-App
/opt/anaconda3/envs/lerobot/bin/pip install -r requirements.txt
cd frontend && npm install
```

Apple Silicon is supported (lerobot ships `requirements-macos.txt` and `pyrealsense2-macosx`). No CUDA — torch uses MPS.

---

## Running the app

`.claude/launch.json` is set up for Claude Code's preview-server tooling. Backend uses the absolute path to the lerobot env's python so it works regardless of conda activation; frontend pins port 3000 because `backend/main.py:23` hardcodes that origin in CORS.

**Manual start:**
```bash
# terminal 1 — backend (port 8000)
cd /Users/healthyli/Documents/GitHub/MakerMods-App
/opt/anaconda3/envs/lerobot/bin/python -m backend.main

# terminal 2 — frontend (port 3000)
cd /Users/healthyli/Documents/GitHub/MakerMods-App/frontend
npm run dev
```

**Health checks:**
- `curl http://localhost:8000/api/health` → `{"status":"healthy",...}`
- `curl http://localhost:3000/api/health` → same (proxied)
- Open http://localhost:3000 for the wizard

---

## Fixes applied on this branch (all committed in `5fd177c`)

Each was a real bug we hit during the session, then fixed:

| File | Fix | Why |
|---|---|---|
| [backend/services/port_scanner.py](backend/services/port_scanner.py) | Filter `/dev/cu.usbmodem*` by USB VID/PID; allowlist WCH/FTDI/etc., denylist 291A:8355 USB Billboard. Surface real `hwid`. | Old code labeled every USB-CDC device "Feetech Motor Controller" — wizard offered the user's USB-C dock as a 4th port and crashed on connect. |
| [backend/services/process_manager.py](backend/services/process_manager.py) | Prepend `os.path.dirname(sys.executable)` to subprocess PATH. | `lerobot-teleoperate` lives in the conda env's `bin/` but the env isn't activated when backend runs by absolute python path → `[Errno 2] No such file or directory`. |
| [backend/api/setup.py](backend/api/setup.py) | TOCTOU race in `_CameraStream._stop()`: switched `Lock`→`RLock`, snapshot state under lock, join outside. | Two concurrent `_stop()` callers raced between `if self._process is not None` and `.is_alive()` → `'NoneType' object has no attribute 'is_alive'` 500. |
| [frontend/components/common/dev-error-panel.tsx](frontend/components/common/dev-error-panel.tsx) | `navigator.clipboard.writeText` in try/catch with hidden-textarea + `execCommand` fallback. | Browser rejects clipboard write when document loses focus → `Runtime NotAllowedError` red overlay. |
| [frontend/components/wizard/steps/training-step.tsx](frontend/components/wizard/steps/training-step.tsx:823) | Same pattern. | Same root cause. |
| [frontend/components/wizard/steps/teleoperate-step.tsx](frontend/components/wizard/steps/teleoperate-step.tsx) | Added/reordered diagnostics: "USB device disconnected", "No motors responding on this arm", "Wrong motor IDs on this arm". | `Could not connect on port` was being mis-labeled "Port access denied" because the broader matcher fired first. |

---

## Hardware state (last verified)

You have **4 real Feetech motor controllers** + 1 phantom (a USB Billboard descriptor from a USB-C dock — already filtered out by the new port scanner):

| Port | Motor IDs found | Verdict |
|---|---|---|
| `5B140325121` | 1, 2, 3, 4, 5, 6 | ✅ clean SO-101 — was off earlier, came back when PSU was switched on |
| `5B140332831` | 1, 2, 3, 4, 5, 6 | ✅ clean SO-101 |
| `5B140325511` | 1–8 | ⚠️ dirty (extras at IDs 7, 8) |
| `5B141153351` | 1–9 | ⚠️ dirty (extras at IDs 7, 8, 9) |

To re-verify on your machine:
```bash
/opt/anaconda3/envs/lerobot/bin/python <<'PY'
from serial.tools import list_ports
from scservo_sdk import PortHandler, PacketHandler, COMM_SUCCESS
for port in sorted(p.device for p in list_ports.comports() if p.vid == 0x1A86 and p.pid == 0x55D3):
    ph = PortHandler(port); ph.openPort(); ph.setBaudRate(1_000_000)
    pkt = PacketHandler(0)
    ids = [m for m in range(1,16) if pkt.ping(ph, m)[1] == COMM_SUCCESS]
    ph.closePort(); print(f"{port}  ids={ids}")
PY
```

### Cleaning up the dirty buses

Bimanual mode requires exactly motor IDs 1–6 per arm. For the two dirty ones:
```bash
conda activate lerobot
lerobot-setup-motors --robot.type=so101_follower --robot.port=/dev/cu.usbmodem5B140325511
lerobot-setup-motors --teleop.type=so101_leader --teleop.port=/dev/cu.usbmodem5B141153351
```
This walks through 1-by-1 ID re-assignment. Disconnect all but the motor being IDed at each step.

---

## Calibration state (last verified)

Files saved on disk so far:
```
~/.cache/huggingface/lerobot/calibration/robots/so101_follower/follower_robot_right.json
~/.cache/huggingface/lerobot/calibration/teleoperators/so101_leader/leader_robot_right.json
```

So the **right pair** of the bimanual setup is calibrated. **Left follower** and **left leader** still need calibration.

The user switched to **single-arm mode** mid-session to bypass the bimanual handshake check. Current `webui_config.json` mode = `single` with right pair (`5B140332831` leader, `5B140325511` follower). Last teleop attempt connected and ran at 60 Hz before a USB power glitch dropped motor 6 mid-stream.

### Calibration filename rule (don't fight it)

Lerobot's bimanual wrapper builds sub-arm IDs by appending `_left` / `_right` to a shared base prefix (see [backend/api/calibration.py:104-107](backend/api/calibration.py:104)). The frontend validator in [frontend/lib/wizard-types.ts:341](frontend/lib/wizard-types.ts:341) enforces this. So names must be `<shared_base>_left` and `<shared_base>_right` for each pair (followers and leaders use independent bases). Examples that work:

- `follower_robot_left` / `follower_robot_right`
- `leader_robot_left` / `leader_robot_right`

Names like `left_hand_trial1` (suffix-as-prefix) will be rejected.

### How the wizard's calibration step works

It does NOT call `lerobot-calibrate` (which expects an interactive TTY and fails as a backgrounded subprocess — see the "Same min and max values" trap below). Instead it uses lerobot's calibration *library* via WebSocket: backend opens the bus, disables torque, you physically move each joint, the browser shows live `min/current/max` per motor, you click Done and a JSON file lands at the path above.

---

## Open issues / blockers ranked by priority

### 1. USB power stability (the only show-stopper for sustained teleop)
Last teleop run worked, then crashed mid-stream with `OSError: [Errno 6] Device not configured`. macOS marked the device as gone — usually means a USB hub voltage sag or unseated cable. Fix:
- Plug each Feetech controller **directly** into the Mac, not through a bus-powered hub.
- If a hub is required, use a **powered hub** with its own wall PSU.
- Disable USB sleep: `sudo pmset -a disksleep 0` and uncheck "Put hard disks to sleep" in System Settings → Battery → Power Adapter.

### 2. Dirty motor IDs on two arms (only blocks bimanual)
See "Cleaning up the dirty buses" above. Single-arm right-pair mode works without this; bimanual will fail handshake.

### 3. Calibration state inconsistency in API
[backend/services/calibration_service.py:80-83](backend/services/calibration_service.py:80) hardcodes `single_follower` / `single_leader` as device IDs in the single-arm status check, but the actual config carries the user's chosen IDs (e.g. `follower_robot_right`). Result: the API reports `is_calibrated=false` even when the JSON files exist under the user's chosen names. Teleop *itself* works because the command builder uses the right IDs from config. Low priority; cosmetic UI lie.

### 4. Old typo'd calibration directory
`~/.cache/huggingface/lerobot/calibration/robots/so_follower/` (note: `so_follower` not `so101_follower`) has stale leftover files. Safe to ignore; not used by current code paths.

---

## Useful debug commands cheat-sheet

```bash
# what USB serial devices does the Mac see?
ls /dev/cu.usbmodem*
/opt/anaconda3/envs/lerobot/bin/python -c "from serial.tools import list_ports; [print(f'{p.device}  vid={p.vid:04x} pid={p.pid:04x}  {p.description}') for p in list_ports.comports() if p.vid]"

# what motors respond on a port?
/opt/anaconda3/envs/lerobot/bin/python -c "
from scservo_sdk import PortHandler, PacketHandler, COMM_SUCCESS
ph = PortHandler('/dev/cu.usbmodem5B140325121'); ph.openPort(); ph.setBaudRate(1_000_000)
pkt = PacketHandler(0); print([m for m in range(1,16) if pkt.ping(ph, m)[1] == COMM_SUCCESS])
ph.closePort()
"

# port lock state
curl -s http://localhost:8000/api/system/port-locks | python -m json.tool

# calibration files
find ~/.cache/huggingface/lerobot/calibration -name "*.json"

# what config the backend has loaded
curl -s http://localhost:8000/api/config/ | python -m json.tool
```

---

## Pending strategy work (the actual product goal)

We never finished the strategy doc the user originally asked for. Outstanding scoping questions for the user (NOT for you to answer alone):

1. **Barcode type confirmed**: 1D UPC-A (12 digits, retail; example `054732101818`).
2. **Camera setup** — wrist-only, scene-only, or both? Default proposed: wrist + scene, two 1080p USB cams.
3. **Task envelope** — locate-and-present (find object on table, grasp, orient, scan, place in bin) vs. wrist-camera-only scan vs. sort-by-barcode. Default proposed: locate-and-present.
4. **Compute** — Mac MPS only (limits to ACT / Diffusion Policy small) vs. CUDA available (opens SmolVLA / π0 / OpenVLA) vs. fine-tune-only.

The user said "default" wasn't yet committed when hardware troubleshooting took over. Once teleop is stable, ask them to confirm answers to 2/3/4 then dispatch parallel research agents:
- Gold-standard repos for UPC-A perception (`pyzbar` / `zxing-cpp`)
- LeRobot example: best ACT/Diffusion Policy training recipe for grasp-and-orient
- Dataset formats for teleop demos (HF LeRobotDataset)
- Eval protocols for "scan success rate"

The deliverable they want is **one strategy doc** covering: setup, training pipeline, components with sourced links, full tech stack, eval matrix with optimization hooks. Stratechery-quality writing, with explicit gold-standard citations.

---

## Memory store

Persistent project memory at `/Users/healthyli/.claude/projects/-Users-healthyli-Documents-GitHub-MakerMods-App/memory/` — covers user profile, project context, lerobot env reference, run commands. Read these before starting; they're concise.

---

## What NOT to do

- Don't downgrade lerobot or torch versions to "fix" something. The current pinned set works on Apple Silicon.
- Don't skip the wizard's calibration step and hand-edit calibration JSON files. lerobot's runtime checks reject manually-crafted ones.
- Don't run `lerobot-teleoperate` as a backgrounded subprocess hoping the auto-recalibration prompts will pipe through — they won't, and you get the "Same min and max values" failure. The wizard's WebSocket-driven flow is the only working path.
- Don't try to share a serial port between the wizard's "Base (Keyboard) Control" feature and `lerobot-teleoperate`. macOS allows exactly one process per port. Always `POST /api/base-control/disconnect` before starting teleop, or click Disconnect on the Base card.
- Don't commit `.claude/scheduled_tasks.lock` — it's runtime state.

---

If anything in this doc disagrees with what you observe in the actual code, **trust the code** — this doc was accurate at commit `5fd177c` but may drift.
