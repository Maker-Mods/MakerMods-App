// Types inlined from former types.ts (kept for real API usage when USE_MOCK=false)

interface CameraConfig {
  index: number;
  name: string;
  width: number;
  height: number;
  fps: number;
}

interface SingleArmConfig {
  follower_port: string | null;
  leader_port: string | null;
  cameras: CameraConfig[];
}

interface BimanualConfig {
  left_follower_port: string | null;
  left_leader_port: string | null;
  right_follower_port: string | null;
  right_leader_port: string | null;
  cameras: CameraConfig[];
}

interface LastRecordingConfig {
  repo_id: string | null;
  task: string | null;
  num_episodes: number;
  episode_time_s: number;
}

interface Config {
  mode: "single" | "bimanual";
  single_arm: SingleArmConfig;
  bimanual: BimanualConfig;
  last_recording: LastRecordingConfig;
}

type ProcessState = "not_started" | "running" | "stopped" | "error";

interface ProcessStatus {
  process_id: string;
  process_type: string;
  state: ProcessState;
  pid: number | null;
  started_at: string | null;
  stopped_at: string | null;
  uptime_seconds: number | null;
  error_message: string | null;
}

interface CalibrationStatus {
  device_type: string;
  device_id: string;
  robot_type: string;
  port: string | null;
  is_calibrated: boolean;
  calibration_path: string | null;
}

interface HFLoginStatus {
  is_logged_in: boolean;
  username: string | null;
}

interface SystemStatus {
  active_processes: ProcessStatus[];
  hf_status: HFLoginStatus;
  missing_calibrations: CalibrationStatus[];
}

interface PortInfo {
  port: string;
  description: string | null;
  hwid: string | null;
}

interface CameraInfo {
  index: number;
  name: string | null;
  backend: string;
  is_builtin: boolean;
}

interface CameraPreview {
  index: number;
  image_path: string;
  image_url: string;
}

interface RecordingRequest {
  repo_id: string;
  single_task: string;
  num_episodes: number;
  episode_time_s: number;
  display_data: boolean;
}

interface HFRepoInfo {
  repo_id: string;
  repo_type: string;
  private: boolean;
  url: string | null;
}

interface StartResponse {
  process_id: string;
  message: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(error.detail || `API Error: ${res.status}`);
  }

  return res.json();
}

// Config
export const api = {
  config: {
    get: () => fetchAPI<Config>("/api/config/"),
    save: (config: Config) =>
      fetchAPI<Config>("/api/config/", {
        method: "POST",
        body: JSON.stringify(config),
      }),
    reset: () => fetchAPI<Config>("/api/config/", { method: "DELETE" }),
  },

  setup: {
    listPorts: () => fetchAPI<PortInfo[]>("/api/setup/ports"),
    listCameras: (excludeBuiltin?: boolean) =>
      fetchAPI<CameraInfo[]>(
        `/api/setup/cameras${excludeBuiltin ? "?exclude_builtin=true" : ""}`
      ),
    capturePreviews: (indices?: number[]) =>
      fetchAPI<Record<number, CameraPreview>>("/api/setup/cameras/preview", {
        method: "POST",
        body: JSON.stringify(indices ?? null),
      }),
    getPreviewUrl: (index: number) =>
      `${API_BASE}/api/setup/cameras/preview/${index}`,
  },

  calibration: {
    getStatus: () =>
      fetchAPI<CalibrationStatus[]>("/api/calibration/status"),
    getMissing: () =>
      fetchAPI<CalibrationStatus[]>("/api/calibration/missing"),
    start: (params: {
      device_type: string;
      device_id: string;
      robot_type: string;
      port: string;
    }) =>
      fetchAPI<StartResponse>("/api/calibration/start", {
        method: "POST",
        body: JSON.stringify(params),
      }),
    stop: (processId: string) =>
      fetchAPI<{ message: string }>(`/api/calibration/stop/${processId}`, {
        method: "POST",
      }),
  },

  teleoperation: {
    start: (params: { display_data: boolean }) =>
      fetchAPI<StartResponse>("/api/teleoperation/start", {
        method: "POST",
        body: JSON.stringify(params),
      }),
    stop: (processId: string) =>
      fetchAPI<{ message: string }>(`/api/teleoperation/stop/${processId}`, {
        method: "POST",
      }),
    getStatus: (processId: string) =>
      fetchAPI<ProcessStatus>(`/api/teleoperation/status/${processId}`),
  },

  recording: {
    start: (params: RecordingRequest) =>
      fetchAPI<StartResponse>("/api/recording/start", {
        method: "POST",
        body: JSON.stringify(params),
      }),
    stop: (processId: string) =>
      fetchAPI<{ message: string }>(`/api/recording/stop/${processId}`, {
        method: "POST",
      }),
    getStatus: (processId: string) =>
      fetchAPI<ProcessStatus>(`/api/recording/status/${processId}`),
    clearCache: (repoId: string) =>
      fetchAPI<{ message: string }>(
        `/api/recording/cache?repo_id=${encodeURIComponent(repoId)}`,
        { method: "DELETE" }
      ),
  },

  huggingface: {
    whoami: () => fetchAPI<HFLoginStatus>("/api/huggingface/whoami"),
    listRepos: () => fetchAPI<HFRepoInfo[]>("/api/huggingface/repos"),
    createRepo: (repoName: string, isPrivate: boolean = false) =>
      fetchAPI<HFRepoInfo>("/api/huggingface/repos", {
        method: "POST",
        body: JSON.stringify({ repo_name: repoName, private: isPrivate }),
      }),
  },

  system: {
    getStatus: () => fetchAPI<SystemStatus>("/api/system/status"),
  },

  training: {
    getKeyStatus: () =>
      fetchAPI<{ is_valid: boolean; message: string }>("/api/training/key-status"),
    validateKey: (apiKey: string) =>
      fetchAPI<{ is_valid: boolean; message: string }>("/api/training/validate-key", {
        method: "POST",
        body: JSON.stringify({ api_key: apiKey }),
      }),
    listInstances: () =>
      fetchAPI<
        Array<{
          id: string;
          name: string;
          description: string;
          gpu_description: string;
          credits_per_hour: number;
          specs: {
            vcpus: number;
            memory_gib: number;
            storage_gib: number;
            gpu_count: number;
            gpu_type: string;
          };
          regions: string[];
        }>
      >("/api/training/instances"),
    start: (params: {
      dataset_id: string;
      vla_type: string;
      instance_type: string;
      batch_size: number;
      hours: number;
      output_model_name: string;
      job_description: string;
      camera_names: string[];
    }) =>
      fetchAPI<{ job_id: string; project_id: string; message: string }>(
        "/api/training/start",
        { method: "POST", body: JSON.stringify(params) }
      ),
    getStatus: (jobId: string) =>
      fetchAPI<{ job_id: string; project_id: string; status: string; phase: string; message: string; output_model_id: string | null }>(
        `/api/training/status/${jobId}`
      ),
    cancel: (jobId: string) =>
      fetchAPI<{ job_id: string; status: string; phase: string; message: string }>(
        `/api/training/cancel/${jobId}`,
        { method: "POST" }
      ),
  },

  qc: {
    getSettings: () => fetchAPI<QcSettings>("/api/qc/settings"),
    patchSettings: (patch: QcSettingsPatch) =>
      fetchAPI<QcSettings>("/api/qc/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    setKey: (role: QcProviderRole, apiKey: string) =>
      fetchAPI<QcSettings>("/api/qc/providers/key", {
        method: "POST",
        body: JSON.stringify({ role, api_key: apiKey }),
      }),
    clearKey: (role: QcProviderRole) =>
      fetchAPI<QcSettings>(`/api/qc/providers/key/${role}`, {
        method: "DELETE",
      }),
    testProvider: (role: QcProviderRole) =>
      fetchAPI<QcProviderTestResponse>("/api/qc/providers/test", {
        method: "POST",
        body: JSON.stringify({ role }),
      }),
    costEstimate: () =>
      fetchAPI<QcCostEstimate>("/api/qc/cost-estimate"),
    presets: () => fetchAPI<QcProviderPreset[]>("/api/qc/presets"),
    diagnostics: () =>
      fetchAPI<{ secret_backend: string }>("/api/qc/diagnostics"),
  },
};

// ---- QC types (mirror backend/models/qc.py) ---------------------------------

export type QcProviderName = "qwen" | "openai" | "anthropic" | "custom";
export type QcProviderRole = "vlm" | "llm";
export type QcTrigger = "after_session" | "manual";

export interface QcProviderConfig {
  provider: QcProviderName;
  model: string;
  base_url: string | null;
  api_key_ref: string | null;
  last_verified_at: string | null;
}

export interface QcSettings {
  enabled: boolean;
  trigger: QcTrigger;
  privacy: {
    upload_frames: boolean;
    thumbnail_ttl_hours: number;
    redact_faces: boolean;
  };
  providers: { vlm: QcProviderConfig; llm: QcProviderConfig };
  budget: { max_usd_per_session: number; warn_above_usd: number };
  first_run_dismissed: boolean;
  not_now_until: string | null;
}

export type QcSettingsPatch = Partial<QcSettings>;

export interface QcProviderTestResponse {
  ok: boolean;
  latency_ms?: number;
  model_echo?: string;
  est_cost_usd?: number;
  error?: string;
}

export interface QcCostEstimate {
  per_episode_usd: number;
  assumptions: Record<string, number>;
}

export interface QcProviderPreset {
  provider: QcProviderName;
  label: string;
  base_url: string;
  vlm_models: string[];
  llm_models: string[];
}
