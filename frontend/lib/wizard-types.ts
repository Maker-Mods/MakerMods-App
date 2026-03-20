// Robot mode
export type RobotMode = "single" | "bimanual";

// Port info from backend
export interface PortInfo {
  port: string;
  description: string | null;
  hwid: string | null;
}

// Camera info from backend OpenCV detection (ground truth indices)
export interface CameraInfo {
  opencvIndex: number; // OpenCV camera index (from backend, ground truth)
  label: string;       // Camera name from system_profiler or fallback
}

// Camera selection in wizard
export interface CameraSelection {
  opencvIndex: number; // OpenCV camera index (key, ground truth from backend)
  label: string;       // display label
  name: string;        // "front_cam" | "hand_cam" | "side_cam"
  included: boolean;
}

// Recording configuration
export interface RecordingConfig {
  repoId: string;
  task: string;
  numEpisodes: number;
  episodeTimeS: number;
  resetTimeS: number;
  displayData: boolean;
  cameraFps: number;
  cameraWidth: number;
  cameraHeight: number;
}

// API start response
export interface StartResponse {
  process_id: string;
  message: string;
}

// Wizard state
export interface WizardState {
  currentStep: number; // 0-5
  completedSteps: boolean[];

  // Step 0: Robot Type
  robotMode: RobotMode | null;

  // Step 1: Ports
  detectedPorts: PortInfo[];
  portAssignments: Record<string, string>; // role → port path

  // Step 2: Cameras
  camerasStepVisited: boolean;
  detectedCameras: CameraInfo[];
  cameraSelections: CameraSelection[];

  // Step 3: Calibration
  calibrationFiles: Record<string, string[]>; // "robots/so101_follower" → filenames
  calibrationSelections: Record<string, string | null>; // role → filename or "new" or null
  newCalibrationNames: Record<string, string>; // role → user-entered name for new calibration

  // Step 4: Teleoperation
  teleStepVisited: boolean;
  teleProcessId: string | null;

  // Step 5: Recording
  recordStepVisited: boolean;
  recordingConfig: RecordingConfig;
  recordProcessId: string | null;
}

// Port roles by mode
export const SINGLE_PORT_ROLES = ["follower", "leader"] as const;
export const BIMANUAL_PORT_ROLES = [
  "left_follower",
  "right_follower",
  "left_leader",
  "right_leader",
] as const;

// Camera name options
export const CAMERA_NAME_OPTIONS = [
  "front_cam",
  "hand_cam",
  "side_cam",
] as const;

// Calibration directory mapping
export function getCalibrationPaths(mode: RobotMode): { role: string; category: string; robotType: string }[] {
  if (mode === "single") {
    return [
      { role: "follower", category: "robots", robotType: "so101_follower" },
      { role: "leader", category: "teleoperators", robotType: "so101_leader" },
    ];
  }
  return [
    { role: "left_follower", category: "robots", robotType: "bi_so101_follower" },
    { role: "right_follower", category: "robots", robotType: "bi_so101_follower" },
    { role: "left_leader", category: "teleoperators", robotType: "bi_so101_leader" },
    { role: "right_leader", category: "teleoperators", robotType: "bi_so101_leader" },
  ];
}

// Step definitions
export const STEPS = [
  { label: "Robot Type", description: "Choose your robot arm configuration" },
  { label: "Ports", description: "Detect and assign USB device ports" },
  { label: "Cameras", description: "Select and name your cameras" },
  { label: "Calibration", description: "Choose calibration for each arm" },
  { label: "Teleoperate", description: "Test robot teleoperation" },
  { label: "Record", description: "Record training data" },
] as const;

// Initial state
export const INITIAL_RECORDING_CONFIG: RecordingConfig = {
  repoId: "",
  task: "",
  numEpisodes: 10,
  episodeTimeS: 60,
  resetTimeS: 10,
  displayData: true,
  cameraFps: 30,
  cameraWidth: 640,
  cameraHeight: 480,
};

export const INITIAL_STATE: WizardState = {
  currentStep: 0,
  completedSteps: [false, false, false, false, false, false],
  robotMode: null,
  detectedPorts: [],
  portAssignments: {},
  camerasStepVisited: false,
  detectedCameras: [],
  cameraSelections: [],
  calibrationFiles: {},
  calibrationSelections: {},
  newCalibrationNames: {},
  teleStepVisited: false,
  teleProcessId: null,
  recordStepVisited: false,
  recordingConfig: { ...INITIAL_RECORDING_CONFIG },
  recordProcessId: null,
};
