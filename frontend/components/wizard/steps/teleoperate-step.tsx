"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Loader2,
  Play,
  Square,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { LogViewer } from "@/components/common/log-viewer";
import { useMotorState, MotorPanel, CameraFeedPanel } from "@/components/common/robot-display";
import { useWebSocket } from "@/hooks/use-websocket";
import { services } from "@/lib/services";
import { validateBimanualCalibrationNames } from "@/lib/wizard-types";
import { useWizard } from "../wizard-provider";
import { StepCard } from "../step-card";
import { BaseControlPanel } from "./base-control-panel";

type TeleState = "idle" | "starting" | "running" | "error" | "stopped";

export function TeleoperateStep() {
  const { state, dispatch, allPriorStepsComplete } = useWizard();
  const [teleState, setTeleState] = useState<TeleState>(
    state.teleProcessId ? "running" : "idle"
  );
  const [showLogs, setShowLogs] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showCameras, setShowCameras] = useState(false);
  const [baseConnected, setBaseConnected] = useState(false);
  const priorComplete = allPriorStepsComplete(4);

  const selectedCameraFeeds = state.cameraSelections
    .filter((c) => c.included && c.name)
    .map((c) => ({ opencvIndex: c.opencvIndex, name: c.name }));

  const { logs, isConnected, clearLogs } = useWebSocket(state.teleProcessId);

  // Poll process status to detect crashes
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (processId: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const status = await services.getProcessStatus(processId);
          if (status.state === "error") {
            setTeleState("error");
            setErrorMsg(status.error_message || "Process exited with an error");
            setShowLogs(true);
            // Ensure port locks are released even if _collect_logs hasn't finished cleanup
            services.stopTeleoperation(processId).catch(() => {});
            stopPolling();
          } else if (status.state === "stopped") {
            setTeleState("stopped");
            // Ensure port locks are released
            services.stopTeleoperation(processId).catch(() => {});
            stopPolling();
          }
        } catch {
          // Process not found — likely already cleaned up
          setTeleState("error");
          setErrorMsg("Lost connection to process");
          setShowLogs(true);
          stopPolling();
        }
      }, 2000);
    },
    [stopPolling]
  );

  // Start polling if we already have a process running
  useEffect(() => {
    if (state.teleProcessId && teleState === "running") {
      startPolling(state.teleProcessId);
    }
    return stopPolling;
  }, [state.teleProcessId, teleState, startPolling, stopPolling]);

  async function handleStart() {
    setTeleState("starting");
    setErrorMsg(null);
    setShowLogs(false);
    try {
      await services.saveConfig(state);
      // Release any MJPEG camera streams so the subprocess can access them
      await services.stopCameraStreams().catch(() => {});
      const res = await services.startTeleoperation(false);
      dispatch({ type: "SET_TELE_PROCESS_ID", id: res.process_id });
      setTeleState("running");
      startPolling(res.process_id);
    } catch (err) {
      setTeleState("error");
      setErrorMsg(err instanceof Error ? err.message : "Failed to start");
      setShowLogs(true);
    }
  }

  function handleStop() {
    if (!state.teleProcessId) return;
    stopPolling();
    services.stopProcess(state.teleProcessId).catch(() => {});
    dispatch({ type: "SET_TELE_PROCESS_ID", id: null });
    setTeleState("idle");
    setShowLogs(false);
    setErrorMsg(null);
  }

  function handleDismiss() {
    stopPolling();
    dispatch({ type: "SET_TELE_PROCESS_ID", id: null });
    setTeleState("idle");
    setShowLogs(false);
    setErrorMsg(null);
  }

  const isRunning = teleState === "running";
  const isError = teleState === "error";
  const isStarting = teleState === "starting";
  const armTeleopActive = isRunning || isStarting;
  const { motors, motorOrder, frequency } = useMotorState(logs, isRunning);
  const summaryItems = buildSummary(state);

  return (
    <StepCard
      title="Teleoperation"
      description="Test your robot setup."
      showNext={false}
    >
      <div className="space-y-5">
        {!priorComplete && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Previous steps are not all completed. It is not recommended to
              proceed without completing them first.
            </AlertDescription>
          </Alert>
        )}

        {/* Config Summary */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Configuration Summary</p>
          <div className="rounded-lg border bg-muted/50 p-4">
            {summaryItems.length > 0 ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                {summaryItems.map(({ label, value }) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-mono text-xs">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Complete previous steps to see configuration.
              </p>
            )}
          </div>
        </div>

        <Separator />

        {/* Camera feed toggle — disabled when no cameras are selected */}
        <div className="flex items-center gap-2">
          <Switch
            id="show-cameras"
            checked={showCameras}
            onCheckedChange={setShowCameras}
            disabled={selectedCameraFeeds.length === 0}
          />
          <Label
            htmlFor="show-cameras"
            className={`text-sm ${selectedCameraFeeds.length === 0 ? "text-muted-foreground" : "cursor-pointer"}`}
          >
            Show camera feeds
            {selectedCameraFeeds.length === 0 && (
              <span className="text-xs ml-1.5">(no cameras selected)</span>
            )}
          </Label>
        </div>

        {showCameras && <CameraFeedPanel cameras={selectedCameraFeeds} />}

        <Separator />

        {/* ──── Section 1: Arm Teleoperation ──── */}
        <div className="space-y-3">
          <p className="text-sm font-medium">Arm Teleoperation</p>
          <p className="text-xs text-muted-foreground">
            Run lerobot-teleoperate to control the follower arm(s) with the
            leader arm(s).
          </p>

          {/* Running state */}
          {isRunning && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 rounded-lg border p-4">
                <CircleCheck className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">
                    Teleoperation is running
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Move the leader arm to control the follower.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={handleStop}>
                  <Square className="mr-2 h-3.5 w-3.5" />
                  Stop
                </Button>
              </div>

              <MotorPanel motors={motors} motorOrder={motorOrder} frequency={frequency} />
            </div>
          )}

          {/* Error state */}
          {isError && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
                <XCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-red-800 dark:text-red-200">
                    Teleoperation failed
                  </p>
                  {errorMsg && (
                    <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">
                      {errorMsg}
                    </p>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={handleDismiss}>
                  Dismiss
                </Button>
              </div>
              <ErrorDiagnostics logs={logs} />
            </div>
          )}

          {/* Idle / Start button */}
          {!isRunning && !isError && (
            <>
              {baseConnected && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Disconnect the base first — both cannot use the serial port at
                  the same time.
                </p>
              )}
              <Button
                onClick={handleStart}
                disabled={isStarting || !priorComplete || baseConnected}
              >
                {isStarting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-2 h-4 w-4" />
                )}
                {isStarting ? "Starting..." : "Start Teleoperation"}
              </Button>
            </>
          )}

          {/* Collapsible Logs — always available when process exists */}
          {state.teleProcessId && (
            <div>
              <button
                type="button"
                onClick={() => setShowLogs(!showLogs)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {showLogs ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                {showLogs ? "Hide Logs" : "Show Logs"}
                {logs.length > 0 && (
                  <span className="text-muted-foreground/60">
                    ({logs.length} lines)
                  </span>
                )}
              </button>
              {showLogs && (
                <div className="mt-2">
                  <LogViewer
                    logs={logs}
                    isConnected={isConnected}
                    onClear={clearLogs}
                    maxHeight="300px"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <Separator />

        {/* ──── Section 2: Base Keyboard Control ──── */}
        <BaseControlPanel
          disabled={armTeleopActive}
          disabledReason="Stop arm teleoperation first — both cannot use the serial port at the same time."
          onConnectionChange={setBaseConnected}
        />
      </div>
    </StepCard>
  );
}

function diagnoseFromLogs(logs: string[]): {
  title: string;
  description: string;
  suggestion: string;
} | null {
  const joined = logs.join("\n");

  if (joined.includes("same min and max values")) {
    const motorMatch = joined.match(
      /Some motors have the same min and max values:\n([\s\S]*?)(?:\n\[|$)/
    );
    const motors = motorMatch?.[1] ?? "unknown motors";
    return {
      title: "Calibration failed — no motor movement detected",
      description: `During automatic re-calibration, the following motors were not moved: ${motors.replace(/['\[\]\n]/g, "").trim()}. All positions stayed at the same value.`,
      suggestion:
        "Go back to the Calibration step and re-calibrate the affected arm. Make sure to move each joint through its full range of motion during the recording phase.",
    };
  }

  if (
    joined.includes("Mismatch between calibration values") ||
    joined.includes("no calibration file found")
  ) {
    const armMatch = joined.match(
      /Running calibration of (\S+)/
    );
    const arm = armMatch?.[1] ?? "an arm";
    return {
      title: "Calibration mismatch or missing",
      description: `The calibration file for "${arm}" doesn't match the values stored in the motor, or no calibration file was found. This triggers an interactive re-calibration that cannot run from the UI.`,
      suggestion:
        "Go back to the Calibration step and re-calibrate this arm. This will update both the file and the motor's internal values.",
    };
  }

  // FeetechMotorsBus handshake failure — bus opens fine but motors don't reply.
  // Two flavors: empty `Found motor list: {}` = no power / wiring; non-empty
  // = wrong/dirty IDs. Both come through the same RuntimeError class.
  if (joined.includes("FeetechMotorsBus motor check failed")) {
    const portMatch = joined.match(
      /motor check failed on port ['"]?(\/dev\/[^\s'"`)]+)/
    );
    const port = portMatch?.[1];
    const foundEmpty = /Full found motor list[^{]*{\s*}/.test(joined);
    if (foundEmpty) {
      return {
        title: "No motors responding on this arm",
        description: port
          ? `The serial bus on "${port}" opened, but zero motors replied to the ping. The USB controller is powered (over USB), but the servos themselves are not.`
          : "The serial bus opened, but zero motors replied to the ping.",
        suggestion:
          "Plug in or switch on this arm's external motor PSU (the barrel-jack power supply on the controller board — separate from USB). Confirm the small power LED on the controller is lit. Reseat the 3-pin TTL daisy chain from controller → motor 1 → … → motor 6.",
      };
    }
    return {
      title: "Wrong motor IDs on this arm",
      description: port
        ? `The bus on "${port}" returned motors, but their IDs don't match what SO-101 expects (1–6). This usually means motors were never re-IDed from the factory default, or two arms were partially set up on one bus.`
        : "Motors responded but with wrong IDs (SO-101 expects 1–6).",
      suggestion:
        "Run `lerobot-setup-motors --robot.type=so101_follower --robot.port=<this_port>` (or `--teleop.type=so101_leader`) in a terminal to re-assign motor IDs 1–6 one at a time.",
    };
  }

  // Order matters: check the more-specific "device gone" patterns BEFORE the
  // generic "could not open port", because lerobot wraps the OS-level
  // FileNotFoundError ([Errno 2]) into a ConnectionError whose message also
  // contains "could not open port" — we'd otherwise show a misleading
  // "Port access denied" alert when the real cause is a disconnected USB.
  const looksLikeDeviceGone =
    (joined.includes("FileNotFoundError") && joined.includes("/dev/")) ||
    joined.includes("[Errno 2]") ||
    joined.includes("No such file or directory") ||
    /Could not connect on port ['"]?\/dev\//.test(joined);
  if (looksLikeDeviceGone) {
    // Prefer the port mentioned at the error site over the first /dev/...
    // in the log, because the config dump prints all ports before the error
    // and would otherwise mis-attribute the failure to a healthy port.
    const portFromError =
      joined.match(/Could not connect on port ['"]?(\/dev\/[^\s'"`)]+)/) ||
      joined.match(/No such file or directory: ['"]?(\/dev\/[^\s'"`)]+)/) ||
      joined.match(/could not open port (\/dev\/[^\s:'"`)]+)/);
    const port = portFromError?.[1] ?? joined.match(/\/dev\/[^\s'"`)]+/)?.[0];
    return {
      title: "USB device disconnected",
      description: port
        ? `The serial port "${port}" no longer exists at the OS level. The Feetech controller has been unplugged, lost power, or its USB hub dropped.`
        : "A configured serial port no longer exists. The Feetech controller has been unplugged or lost power.",
      suggestion:
        "Unplug all motor controllers, wait 5 seconds, plug them back in (preferably directly into the Mac, not through a bus-powered hub), then go back to the Ports step and re-scan.",
    };
  }

  if (joined.includes("Permission denied") || joined.includes("could not open port")) {
    return {
      title: "Port access denied",
      description:
        "The system could not open the serial port. Another process is holding it (a previous lerobot run or a serial-monitor app).",
      suggestion:
        "Close any other app using the port, or kill leftover lerobot-* processes. If unsure, restart the backend.",
    };
  }

  return null;
}

function ErrorDiagnostics({ logs }: { logs: string[] }) {
  const diag = diagnoseFromLogs(logs);
  if (!diag) return null;

  return (
    <Alert className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950">
      <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <AlertDescription className="space-y-1.5">
        <p className="font-medium text-amber-800 dark:text-amber-200">
          {diag.title}
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {diag.description}
        </p>
        <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
          {diag.suggestion}
        </p>
      </AlertDescription>
    </Alert>
  );
}

function buildSummary(
  state: ReturnType<typeof import("../wizard-provider").useWizard>["state"]
): { label: string; value: string }[] {
  const items: { label: string; value: string }[] = [];

  if (state.robotMode) {
    items.push({
      label: "Mode",
      value: state.robotMode === "bimanual" ? "Bimanual" : "Single Arm",
    });
  }

  for (const [role, port] of Object.entries(state.portAssignments)) {
    if (port) {
      items.push({
        label: role.replace(/_/g, " "),
        value: port.split(".").pop() || port,
      });
    }
  }

  const selectedCams = state.cameraSelections.filter((c) => c.included);
  if (selectedCams.length > 0) {
    items.push({
      label: "Cameras",
      value: selectedCams.map((c) => c.name).join(", "),
    });
  }

  if (state.robotMode === "bimanual") {
    const v = validateBimanualCalibrationNames(
      state.calibrationSelections,
      state.newCalibrationNames,
    );
    if (v.followerBaseId) {
      items.push({ label: "follower id", value: v.followerBaseId });
    }
    if (v.leaderBaseId) {
      items.push({ label: "leader id", value: v.leaderBaseId });
    }
  }

  for (const [role, file] of Object.entries(state.calibrationSelections)) {
    if (file) {
      items.push({
        label: `${role.replace(/_/g, " ")} cal`,
        value: file === "new" ? "New Calibration" : file,
      });
    }
  }

  return items;
}
