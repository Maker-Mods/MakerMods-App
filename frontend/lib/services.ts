import type { PortInfo, CameraInfo, StartResponse, RecordingConfig, InferenceConfig, TrainingConfig, WizardState } from "./wizard-types";
import { validateBimanualCalibrationNames } from "./wizard-types";

const USE_MOCK = false;

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

/** Structured error with an optional traceback and developer hint, returned from the backend. */
export class DevError extends Error {
  traceback?: string;
  hint?: string;
  constructor(message: string, traceback?: string, hint?: string) {
    super(message);
    this.name = "DevError";
    this.traceback = traceback;
    this.hint = hint;
  }
}

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, options);
  } catch {
    throw new DevError(
      "Cannot connect to backend server",
      undefined,
      "The backend is not running. Start it with: python -m lerobot.webui.backend.main",
    );
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail;
    if (detail && typeof detail === "object") {
      throw new DevError(
        detail.message || `API error: ${res.status}`,
        detail.traceback,
        detail.hint,
      );
    }
    throw new Error(
      (typeof detail === "string" ? detail : null) ?? `API error: ${res.status}`
    );
  }
  return res.json();
}

export const services = {
  listPorts: async (): Promise<PortInfo[]> => {
    if (USE_MOCK) {
      const mock = await import("./mock-data");
      return mock.ports;
    }
    return fetchAPI<PortInfo[]>("/api/setup/ports");
  },

  listCameras: async (): Promise<CameraInfo[]> => {
    if (USE_MOCK) {
      const mock = await import("./mock-data");
      return mock.cameras;
    }
    // Backend returns { index, name, backend, is_builtin } from OpenCV detection.
    // All cameras are returned — the user identifies them via MJPEG preview.
    const raw = await fetchAPI<Array<{ index: number; name: string | null }>>(
      "/api/setup/cameras",
    );
    return raw.map((cam) => ({
      opencvIndex: cam.index,
      label: cam.name || `Camera ${cam.index}`,
    }));
  },

  listCalibrationFiles: async (
    category: string,
    robotType: string
  ): Promise<string[]> => {
    if (USE_MOCK) {
      const mock = await import("./mock-data");
      return mock.calibrationFiles[`${category}/${robotType}`] || [];
    }
    return fetchAPI<string[]>(
      `/api/calibration/files?category=${encodeURIComponent(category)}&robot_type=${encodeURIComponent(robotType)}`
    );
  },

  openCalibrationFolder: async (
    category: string,
    robotType: string
  ): Promise<void> => {
    if (USE_MOCK) return;
    await fetchAPI(
      `/api/calibration/open-folder?category=${encodeURIComponent(category)}&robot_type=${encodeURIComponent(robotType)}`,
      { method: "POST" }
    );
  },

  startTeleoperation: async (
    displayData: boolean
  ): Promise<StartResponse> => {
    if (USE_MOCK) {
      const mock = await import("./mock-data");
      return mock.startResponse("teleoperation");
    }
    return fetchAPI<StartResponse>("/api/teleoperation/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_data: displayData }),
    });
  },

  stopProcess: async (processId: string): Promise<void> => {
    if (USE_MOCK) return;
    await fetchAPI(`/api/teleoperation/stop/${processId}`, {
      method: "POST",
    });
  },

  getProcessStatus: async (
    processId: string
  ): Promise<{
    process_id: string;
    process_type: string;
    state: "running" | "stopped" | "error";
    uptime_seconds: number | null;
    error_message: string | null;
  }> => {
    return fetchAPI(`/api/teleoperation/status/${processId}`);
  },

  startRecording: async (config: RecordingConfig): Promise<StartResponse> => {
    if (USE_MOCK) {
      const mock = await import("./mock-data");
      return mock.startResponse("recording");
    }
    return fetchAPI<StartResponse>("/api/recording/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_id: config.repoId,
        single_task: config.task,
        num_episodes: config.numEpisodes,
        episode_time_s: config.episodeTimeS,
        reset_time_s: config.resetTimeS,
        display_data: config.displayData,
      }),
    });
  },

  stopRecording: async (processId: string): Promise<void> => {
    if (USE_MOCK) return;
    await fetchAPI(`/api/recording/stop/${processId}`, { method: "POST" });
  },

  /** Send a control action (rerecord / save / stop) to a running recording. */
  sendRecordingAction: async (
    processId: string,
    action: "rerecord" | "save" | "stop"
  ): Promise<void> => {
    await fetchAPI(`/api/recording/action/${processId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
  },

  startCalibration: async (
    deviceType: string,
    deviceId: string,
    robotType: string,
    port: string
  ): Promise<StartResponse> => {
    if (USE_MOCK) {
      const mock = await import("./mock-data");
      return mock.startResponse("calibration");
    }
    return fetchAPI<StartResponse>("/api/calibration/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_type: deviceType,
        device_id: deviceId,
        robot_type: robotType,
        port,
      }),
    });
  },

  stopCalibration: async (processId: string): Promise<void> => {
    if (USE_MOCK) return;
    await fetchAPI(`/api/calibration/stop/${processId}`, { method: "POST" });
  },

  saveConfig: async (state: WizardState): Promise<void> => {
    if (USE_MOCK) return;
    const mode = state.robotMode === "bimanual" ? "bimanual" : "single";
    // Use the stored opencvIndex (position in the full unfiltered videoinput list)
    // so built-in cameras don't shift the numbering for external cameras.
    const cameras = state.cameraSelections
      .filter((c) => c.included)
      .map((c) => ({
        index: c.opencvIndex,
        name: c.name,
        width: state.recordingConfig.cameraWidth,
        height: state.recordingConfig.cameraHeight,
        fps: state.recordingConfig.cameraFps,
      }));
    // Strip .json extension from calibration file names to get the ID
    const calId = (file: string | null | undefined) =>
      file && file !== "new" ? file.replace(/\.json$/, "") : null;

    // For bimanual mode, derive the base IDs from the calibration file names
    const bimanualValidation = mode === "bimanual"
      ? validateBimanualCalibrationNames(state.calibrationSelections, state.newCalibrationNames)
      : null;

    const config =
      mode === "bimanual"
        ? {
            mode,
            bimanual: {
              left_follower_port: state.portAssignments.left_follower || null,
              left_leader_port: state.portAssignments.left_leader || null,
              right_follower_port: state.portAssignments.right_follower || null,
              right_leader_port: state.portAssignments.right_leader || null,
              follower_id: bimanualValidation?.followerBaseId || "bimanual_follower",
              leader_id: bimanualValidation?.leaderBaseId || "bimanual_leader",
              cameras,
            },
          }
        : {
            mode,
            single_arm: {
              follower_port: state.portAssignments.follower || null,
              leader_port: state.portAssignments.leader || null,
              follower_id: calId(state.calibrationSelections.follower),
              leader_id: calId(state.calibrationSelections.leader),
              cameras,
            },
          };
    await fetchAPI("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  },

  wiggleGripper: async (port: string): Promise<void> => {
    if (USE_MOCK) {
      await new Promise((r) => setTimeout(r, 2000));
      return;
    }
    await fetchAPI("/api/setup/wiggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
  },

  stopCameraStreams: async (): Promise<void> => {
    if (USE_MOCK) return;
    await fetchAPI("/api/setup/cameras/streams/stop", { method: "POST" });
  },

  clearCache: async (repoId: string): Promise<void> => {
    if (USE_MOCK) return;
    await fetchAPI(`/api/recording/cache?repo_id=${encodeURIComponent(repoId)}`, {
      method: "DELETE",
    });
  },

  openDataFolder: async (): Promise<void> => {
    if (USE_MOCK) return;
    await fetchAPI("/api/recording/open-folder", { method: "POST" });
  },

  startInference: async (config: InferenceConfig): Promise<StartResponse> => {
    if (USE_MOCK) {
      const mock = await import("./mock-data");
      return mock.startResponse("inference");
    }
    return fetchAPI<StartResponse>("/api/inference/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        policy_path: config.policyPath,
        repo_id: config.repoId,
        single_task: config.task,
        num_episodes: config.numEpisodes,
        episode_time_s: config.episodeTimeS,
        display_data: config.displayData,
      }),
    });
  },

  scanMotors: async (port: string): Promise<{
    port: string;
    connected: boolean;
    baudrate: number | null;
    error: string | null;
    hint: string | null;
    motors: Array<{
      id: number;
      name: string;
      responding: boolean;
      model_number: number | null;
      position: number | null;
      speed: number | null;
      load: number | null;
      voltage: number | null;
      temperature: number | null;
      move: number | null;
    }>;
    log: string[];
  }> => {
    return fetchAPI("/api/debug/scan-motors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
  },

  checkHFStatus: async (): Promise<{
    is_logged_in: boolean;
    username: string | null;
  }> => {
    if (USE_MOCK) {
      return { is_logged_in: true, username: "mock_user" };
    }
    return fetchAPI("/api/huggingface/whoami");
  },

  stopInference: async (processId: string): Promise<void> => {
    if (USE_MOCK) return;
    await fetchAPI(`/api/inference/stop/${processId}`, { method: "POST" });
  },

  detectBasePort: async (ports: string[]): Promise<{ detected_port: string | null; message: string }> => {
    return fetchAPI("/api/base-control/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ports }),
    });
  },

  connectBase: async (port: string): Promise<{ connected: boolean; port: string | null; speed_index: number }> => {
    return fetchAPI("/api/base-control/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
  },

  disconnectBase: async (): Promise<void> => {
    await fetchAPI("/api/base-control/disconnect", { method: "POST" });
  },

  getBaseStatus: async (): Promise<{ connected: boolean; port: string | null; speed_index: number }> => {
    return fetchAPI("/api/base-control/status");
  },

  // Training (Qualia)
  getQualiaKeyStatus: async (): Promise<{ is_valid: boolean; message: string }> => {
    if (USE_MOCK) return { is_valid: true, message: "Mock key valid" };
    return fetchAPI("/api/training/key-status");
  },

  validateQualiaKey: async (apiKey: string): Promise<{ is_valid: boolean; message: string }> => {
    if (USE_MOCK) return { is_valid: true, message: "Mock key valid" };
    return fetchAPI("/api/training/validate-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    });
  },

  listGPUInstances: async (): Promise<
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
  > => {
    if (USE_MOCK) return [];
    return fetchAPI("/api/training/instances");
  },

  startTraining: async (config: TrainingConfig): Promise<{
    job_id: string;
    project_id: string;
    message: string;
  }> => {
    if (USE_MOCK) return { job_id: "mock-job", project_id: "mock-project", message: "Mock training started" };
    return fetchAPI("/api/training/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataset_id: config.datasetId,
        vla_type: config.vlaType,
        model_id: config.modelId || null,
        instance_type: config.instanceType,
        batch_size: config.batchSize,
        hours: config.hours,
        output_model_name: config.outputModelName,
        job_description: config.jobDescription,
        camera_names: config.cameraNames,
      }),
    });
  },

  getTrainingStatus: async (jobId: string): Promise<{
    job_id: string;
    project_id: string;
    status: string;
    phase: string;
    message: string;
    output_model_id: string | null;
  }> => {
    if (USE_MOCK) return { job_id: jobId, project_id: "", status: "completed", phase: "completed", message: "", output_model_id: null };
    return fetchAPI(`/api/training/status/${jobId}`);
  },

  cancelTraining: async (jobId: string): Promise<{
    job_id: string;
    status: string;
    phase: string;
    message: string;
  }> => {
    if (USE_MOCK) return { job_id: jobId, status: "cancelled", phase: "", message: "" };
    return fetchAPI(`/api/training/cancel/${jobId}`, { method: "POST" });
  },

  getDatasetImageKeys: async (repoId: string): Promise<string[]> => {
    if (USE_MOCK) return ["observation.images.front_cam"];
    return fetchAPI(`/api/huggingface/dataset-image-keys?repo_id=${encodeURIComponent(repoId)}`);
  },

  getInferenceStatus: async (
    processId: string
  ): Promise<{
    process_id: string;
    process_type: string;
    state: "running" | "stopped" | "error";
    uptime_seconds: number | null;
    error_message: string | null;
  }> => {
    return fetchAPI(`/api/inference/status/${processId}`);
  },
};
