# MakerMods LeRobot UI

Web UI for LeRobot SO101 bimanual robot arms — teleoperation, calibration, and data recording. The UI wraps lerobot CLI commands and does not modify the lerobot codebase.

<div align="center">
  <img src="assets/gui_github.gif" alt="MakerMods LeRobot UI" width="80%"/>
</div>

---

> [!IMPORTANT]
> **The following part covers manual installation of the UI only.** Install and configure [lerobot-MakerMods](https://github.com/Maker-Mods/lerobot-MakerMods) first (see [installation instructions](https://github.com/Maker-Mods/lerobot-MakerMods#installation)).

> [!NOTE]
> **If you are an AI coding agent (Claude Code or similar) installing this on macOS, read [`INSTALLATION.md`](./INSTALLATION.md) instead.** It covers end-to-end setup of both the UI and the `lerobot-MakerMods` robot stack on macOS (Apple Silicon), and documents the gotchas the upstream Linux-only READMEs do not.

## Architecture

| Part       | Stack              | Path       | Port |
|-----------|--------------------|------------|------|
| Backend   | FastAPI (Python)   | `backend/` | 8000 |
| Frontend  | Next.js 16, React  | `frontend/`| 3000 |

- Backend runs lerobot CLI via subprocess and serves REST + WebSocket (logs).
- Frontend proxies `/api/*` and `/ws/*` to the backend (see `frontend/next.config.ts`).
- Config is stored in `webui_config.json` at the repo root (gitignored).

---

## Prerequisites

- **lerobot** installed and working in its own environment (e.g. `conda activate lerobot`). Not covered here.
- **Node.js 18+** and **npm** (for the frontend).
- **Python 3.10+** in the same environment you use for lerobot (for the backend).

---

## 1. Install Node.js and npm (Linux)

You need Node 18 or newer for the frontend. Pick one method.

### Option A: NVM (no sudo, recommended)

[NVM](https://github.com/nvm-sh/nvm) installs Node in your home directory.

```bash
# Install NVM
wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Load NVM in this shell (or open a new terminal)
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Install Node LTS
nvm install --lts

# Verify
node -v   # e.g. v20.x.x or v22.x.x
npm -v
```

Add to your shell profile so NVM loads in new terminals (NVM’s install script usually does this):

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
```

### Option B: System packages (Debian/Ubuntu, ARM64-friendly)

```bash
sudo apt update
sudo apt install -y nodejs npm
node -v   # Should be 18+ for Next.js 16
```

If your distro ships an old Node, use NVM (Option A) or the [NodeSource](https://github.com/nodesource/distributions) repo.

---

## 2. Backend (Python)

Use the **same** environment where lerobot is installed (e.g. conda `lerobot`).

```bash
# Activate your lerobot environment
conda activate lerobot   # or: source /path/to/venv/bin/activate

# From the MakerMods-App repo root
cd /path/to/MakerMods-App
pip install -r requirements.txt
```

**requirements.txt** includes:

- `fastapi`, `uvicorn` — API and server  
- `opencv-python-headless` — camera scanning/preview (no GUI)  
- `huggingface_hub` — Hugging Face datasets/repos  

If you already have lerobot installed, some of these may be present; installing again is safe.

**Optional:** If you run the backend on a machine with a display and want OpenCV windows, use `opencv-python` instead of `opencv-python-headless` (or install it in addition; headless is enough for the UI).

---

## 3. Frontend (Node)

From the repo root:

```bash
cd /path/to/MakerMods-App/frontend
npm install
```

If you use NVM, ensure it’s loaded in this terminal (`nvm use default` or open a new terminal after installing NVM).

---

## 4. Run the application

Use two terminals.

**Terminal 1 — Backend (port 8000)**

```bash
conda activate lerobot
cd /path/to/MakerMods-App
python -m backend.main
```

**Terminal 2 — Frontend (port 3000)**

```bash
cd /path/to/MakerMods-App/frontend
npm run dev
```

Then open **http://localhost:3000** in your browser. The frontend will talk to the backend at `localhost:8000` via the configured rewrites.

---

## 5. Verify

- **Backend:** http://localhost:8000/api/health should return `{"status":"healthy",...}`.
- **Frontend:** http://localhost:3000 should show the wizard UI.
- Ensure ports 3000 and 8000 are free before starting.
