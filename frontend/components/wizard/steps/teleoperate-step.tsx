"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Loader2,
  Minus,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Settings2,
  Square,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { LogViewer } from "@/components/common/log-viewer";
import { useMotorState, MotorPanel, CameraFeedPanel } from "@/components/common/robot-display";
import { useWebSocket } from "@/hooks/use-websocket";
import { services } from "@/lib/services";
import { useWizard } from "../wizard-provider";
import { StepCard } from "../step-card";

type TeleState = "idle" | "starting" | "running" | "error" | "stopped";

type BaseKey = "forward" | "backward" | "left" | "right" | "rotate_left" | "rotate_right";

const SPEED_LEVELS = [
  { label: "Low", xy: 0.1, theta: 30 },
  { label: "Medium", xy: 0.2, theta: 60 },
  { label: "High", xy: 0.3, theta: 90 },
] as const;

const KEY_TO_BASE: Record<string, BaseKey> = {
  i: "forward",
  k: "backward",
  j: "left",
  l: "right",
  u: "rotate_left",
  o: "rotate_right",
};

export function TeleoperateStep() {
  const { state, dispatch, allPriorStepsComplete } = useWizard();
  const [teleState, setTeleState] = useState<TeleState>(
    state.teleProcessId ? "running" : "idle"
  );
  const [showLogs, setShowLogs] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showCameras, setShowCameras] = useState(false);
  const priorComplete = allPriorStepsComplete(4);

  // Chassis (LeKiwi base) state
  const [baseProcessId, setBaseProcessId] = useState<string | null>(null);
  const [basePort, setBasePort] = useState("/dev/ttyACM0");
  const [basePressed, setBasePressed] = useState<Set<BaseKey>>(new Set());
  const [baseSpeedIndex, setBaseSpeedIndex] = useState(0);
  const [baseStarting, setBaseStarting] = useState(false);
  const [baseError, setBaseError] = useState<string | null>(null);
  const [baseBackendReady, setBaseBackendReady] = useState<boolean | null>(null);
  const basePressedRef = useRef<Set<BaseKey>>(new Set());
  basePressedRef.current = basePressed;
  const baseSpeedRef = useRef(0);
  baseSpeedRef.current = baseSpeedIndex;

  // XLerobot wheel config (correct_lekiwi.py defaults)
  const [wheelRadius, setWheelRadius] = useState("0.05");
  const [baseRadius, setBaseRadius] = useState("0.125");
  const [wheelAngles, setWheelAngles] = useState("0,240,120");
  const [showWheelConfig, setShowWheelConfig] = useState(false);

  useEffect(() => {
    let cancelled = false;
    services.checkBaseControlReady().then((ok) => {
      if (!cancelled) setBaseBackendReady(ok);
    });
    return () => { cancelled = true; };
  }, []);

  // Keyboard control: I/K/J/L/U/O for movement, N/M for speed
  useEffect(() => {
    if (!baseProcessId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      const dir = KEY_TO_BASE[key];
      if (dir) {
        e.preventDefault();
        setBasePressed((prev) => new Set(prev).add(dir));
      }
      if (key === "n") { e.preventDefault(); setBaseSpeedIndex((i) => Math.min(2, i + 1)); }
      if (key === "m") { e.preventDefault(); setBaseSpeedIndex((i) => Math.max(0, i - 1)); }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const dir = KEY_TO_BASE[key];
      if (dir) {
        e.preventDefault();
        setBasePressed((prev) => { const s = new Set(prev); s.delete(dir); return s; });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [baseProcessId]);

  const [chmodDialogOpen, setChmodDialogOpen] = useState(false);
  const [chmodPassword, setChmodPassword] = useState("");
  const [chmodLoading, setChmodLoading] = useState(false);
  const [chmodError, setChmodError] = useState<string | null>(null);
  const [chmodSuccess, setChmodSuccess] = useState<string | null>(null);

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
            stopPolling();
          } else if (status.state === "stopped") {
            setTeleState("stopped");
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

  // Chassis: send velocity command every 50ms while base is running
  useEffect(() => {
    if (!baseProcessId) return;
    const send = () => {
      const p = basePressedRef.current;
      services.setBaseVelocity({
        forward: p.has("forward"),
        backward: p.has("backward"),
        left: p.has("left"),
        right: p.has("right"),
        rotate_left: p.has("rotate_left"),
        rotate_right: p.has("rotate_right"),
        speed_index: baseSpeedIndex,
      }).catch(() => {});
    };
    send();
    const t = setInterval(send, 50);
    return () => clearInterval(t);
  }, [baseProcessId, baseSpeedIndex]);

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

  async function handleBaseStart() {
    setBaseStarting(true);
    setBaseError(null);
    setBasePressed(new Set());
    try {
      const res = await services.startBaseControl({
        port: basePort,
        wheel_radius: parseFloat(wheelRadius) || 0.05,
        base_radius: parseFloat(baseRadius) || 0.125,
        wheel_angles: wheelAngles || "0,240,120",
      });
      setBaseProcessId(res.process_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start base control";
      const hint =
        msg === "Not Found" || msg.includes("404")
          ? "404: backend route not loaded. Restart backend: PYTHONPATH=src python -m lerobot.webui.backend.main"
          : undefined;
      setBaseError(hint ? `${msg}. ${hint}` : msg);
    } finally {
      setBaseStarting(false);
    }
  }

  function handleBaseStop() {
    if (!baseProcessId) return;
    setBasePressed(new Set());
    services.stopBaseControl(baseProcessId).catch(() => {});
    setBaseProcessId(null);
    setBaseError(null);
  }

  function setBaseKey(key: BaseKey, down: boolean) {
    setBasePressed((prev) => {
      const next = new Set(prev);
      if (down) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function handleChmodSerial() {
    setChmodLoading(true);
    setChmodError(null);
    setChmodSuccess(null);
    try {
      const res = await services.chmodSerial(chmodPassword);
      setChmodSuccess(res.message);
      setChmodPassword("");
      setTimeout(() => {
        setChmodDialogOpen(false);
        setChmodSuccess(null);
      }, 1500);
    } catch (err) {
      setChmodError(err instanceof Error ? err.message : "chmod failed");
    } finally {
      setChmodLoading(false);
    }
  }

  function closeChmodDialog() {
    setChmodDialogOpen(false);
    setChmodPassword("");
    setChmodError(null);
    setChmodSuccess(null);
  }

  const isRunning = teleState === "running";
  const isError = teleState === "error";
  const isStarting = teleState === "starting";
  const { motors, motorOrder, frequency } = useMotorState(logs, isRunning);
  const summaryItems = buildSummary(state);

  return (
    <StepCard
      title="Teleoperation"
      description="Test your robot setup."
      showNext={false}
    >
      <div className="space-y-5">
        {/* Chassis control (LeKiwi base via XLerobot) — independent of previous steps */}
        <div className="space-y-3">
          <p className="text-sm font-medium">Chassis control (LeKiwi base)</p>
          <p className="text-xs text-muted-foreground">
            Drive three omni-wheel base (motor ID 7/8/9) via XLerobot. Works independently of the steps above.
          </p>
          {baseBackendReady === false && (
            <Alert className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <strong>Cannot reach chassis API.</strong>{" "}
                Ensure the backend is running. If it listens on a non-default port, add{" "}
                <code className="bg-muted px-1 rounded">NEXT_PUBLIC_BACKEND_PORT=8001</code> to{" "}
                <code className="bg-muted px-1 rounded">frontend/.env.local</code> and restart the frontend.
              </AlertDescription>
            </Alert>
          )}
          {baseBackendReady === true && (
            <p className="text-xs text-green-600 dark:text-green-400">Chassis API is ready.</p>
          )}

          {/* Port + actions row */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="base-port" className="text-xs whitespace-nowrap">Port</Label>
              <Input
                id="base-port"
                value={basePort}
                onChange={(e) => setBasePort(e.target.value)}
                placeholder="/dev/ttyACM0"
                className="h-8 w-40 font-mono text-xs"
                disabled={!!baseProcessId}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setChmodError(null); setChmodSuccess(null); setChmodDialogOpen(true); }}
            >
              Fix port permissions
            </Button>
            {!baseProcessId ? (
              <Button
                size="sm"
                onClick={handleBaseStart}
                disabled={baseStarting}
              >
                {baseStarting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                )}
                Start base control
              </Button>
            ) : (
              <Button size="sm" variant="destructive" onClick={handleBaseStop}>
                <Square className="mr-1.5 h-3.5 w-3.5" />
                Stop base control
              </Button>
            )}
          </div>

          {/* Wheel config (collapsible) */}
          <button
            type="button"
            onClick={() => setShowWheelConfig(!showWheelConfig)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            disabled={!!baseProcessId}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {showWheelConfig ? "Hide" : "Show"} wheel config
          </button>
          {showWheelConfig && (
            <div className="grid grid-cols-3 gap-3 rounded-lg border bg-muted/30 p-3">
              <div>
                <Label className="text-xs">Wheel radius (m)</Label>
                <Input
                  value={wheelRadius}
                  onChange={(e) => setWheelRadius(e.target.value)}
                  className="h-7 font-mono text-xs mt-1"
                  disabled={!!baseProcessId}
                />
              </div>
              <div>
                <Label className="text-xs">Base radius (m)</Label>
                <Input
                  value={baseRadius}
                  onChange={(e) => setBaseRadius(e.target.value)}
                  className="h-7 font-mono text-xs mt-1"
                  disabled={!!baseProcessId}
                />
              </div>
              <div>
                <Label className="text-xs">Wheel angles (deg)</Label>
                <Input
                  value={wheelAngles}
                  onChange={(e) => setWheelAngles(e.target.value)}
                  placeholder="0,240,120"
                  className="h-7 font-mono text-xs mt-1"
                  disabled={!!baseProcessId}
                />
              </div>
              <p className="col-span-3 text-[10px] text-muted-foreground leading-tight">
                Default: ID7=0° (front), ID8=240° (back-right), ID9=120° (back-left).
                Based on correct_lekiwi.py XLerobotConfig.
              </p>
            </div>
          )}

          {baseError && (
            <Alert variant="destructive" className="py-2">
              <XCircle className="h-4 w-4" />
              <AlertDescription className="text-xs">{baseError}</AlertDescription>
            </Alert>
          )}

          {/* Control pad — visible when base is running */}
          {baseProcessId && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">
                  Hold buttons or use keyboard to move
                </p>
                <span className="text-[10px] text-muted-foreground font-mono">
                  I/K/J/L = move · U/O = rotate · N/M = speed
                </span>
              </div>

              {/* D-pad + rotate buttons */}
              <div className="flex items-center gap-6 justify-center">
                {/* Rotate left */}
                <DirButton
                  active={basePressed.has("rotate_left")}
                  onDown={() => setBaseKey("rotate_left", true)}
                  onUp={() => setBaseKey("rotate_left", false)}
                  label="U"
                  icon={<RotateCcw className="h-4 w-4" />}
                />

                {/* D-pad */}
                <div className="flex flex-col items-center gap-1">
                  <DirButton
                    active={basePressed.has("forward")}
                    onDown={() => setBaseKey("forward", true)}
                    onUp={() => setBaseKey("forward", false)}
                    label="I"
                    icon={<ArrowUp className="h-4 w-4" />}
                  />
                  <div className="flex gap-1">
                    <DirButton
                      active={basePressed.has("left")}
                      onDown={() => setBaseKey("left", true)}
                      onUp={() => setBaseKey("left", false)}
                      label="J"
                      icon={<ArrowLeft className="h-4 w-4" />}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-10 w-10 p-0 opacity-40"
                      onClick={() => setBasePressed(new Set())}
                    >
                      <Square className="h-3.5 w-3.5" />
                    </Button>
                    <DirButton
                      active={basePressed.has("right")}
                      onDown={() => setBaseKey("right", true)}
                      onUp={() => setBaseKey("right", false)}
                      label="L"
                      icon={<ArrowRight className="h-4 w-4" />}
                    />
                  </div>
                  <DirButton
                    active={basePressed.has("backward")}
                    onDown={() => setBaseKey("backward", true)}
                    onUp={() => setBaseKey("backward", false)}
                    label="K"
                    icon={<ArrowDown className="h-4 w-4" />}
                  />
                </div>

                {/* Rotate right */}
                <DirButton
                  active={basePressed.has("rotate_right")}
                  onDown={() => setBaseKey("rotate_right", true)}
                  onUp={() => setBaseKey("rotate_right", false)}
                  label="O"
                  icon={<RotateCw className="h-4 w-4" />}
                />
              </div>

              {/* Speed control */}
              <div className="flex items-center justify-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 w-8 p-0"
                  onClick={() => setBaseSpeedIndex((i) => Math.max(0, i - 1))}
                  disabled={baseSpeedIndex === 0}
                >
                  <Minus className="h-3.5 w-3.5" />
                </Button>
                <div className="text-center min-w-[140px]">
                  <span className="text-sm font-medium">{SPEED_LEVELS[baseSpeedIndex].label}</span>
                  <span className="text-[10px] text-muted-foreground ml-2">
                    {SPEED_LEVELS[baseSpeedIndex].xy} m/s · {SPEED_LEVELS[baseSpeedIndex].theta}°/s
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 w-8 p-0"
                  onClick={() => setBaseSpeedIndex((i) => Math.min(2, i + 1))}
                  disabled={baseSpeedIndex === 2}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>

        <Dialog open={chmodDialogOpen} onOpenChange={(open) => !open && closeChmodDialog()}>
          <DialogContent showCloseButton={true}>
            <DialogHeader>
              <DialogTitle>Fix port permissions</DialogTitle>
              <DialogDescription>
                Run <code className="text-xs bg-muted px-1 rounded">sudo chmod 666 /dev/ttyACM*</code> so the base port can be accessed. Enter your password below, or leave empty if your system has NOPASSWD sudo configured.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="chmod-password">Password</Label>
              <Input
                id="chmod-password"
                type="password"
                value={chmodPassword}
                onChange={(e) => setChmodPassword(e.target.value)}
                placeholder="Your sudo password"
                className="font-mono"
                disabled={chmodLoading}
                onKeyDown={(e) => e.key === "Enter" && handleChmodSerial()}
              />
              {chmodError && (
                <p className="text-xs text-destructive">{chmodError}</p>
              )}
              {chmodSuccess && (
                <p className="text-xs text-green-600 dark:text-green-400">{chmodSuccess}</p>
              )}
            </div>
            <DialogFooter showCloseButton={false}>
              <Button variant="outline" onClick={closeChmodDialog} disabled={chmodLoading}>
                Cancel
              </Button>
              <Button onClick={handleChmodSerial} disabled={chmodLoading || !chmodPassword.trim()}>
                {chmodLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Run chmod
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Separator />

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
        )}

        {/* Idle / Start button */}
        {!isRunning && !isError && (
          <Button
            onClick={handleStart}
            disabled={isStarting || !priorComplete}
          >
            {isStarting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            {isStarting ? "Starting..." : "Start Teleoperation"}
          </Button>
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
    </StepCard>
  );
}

function DirButton({
  active,
  onDown,
  onUp,
  label,
  icon,
}: {
  active: boolean;
  onDown: () => void;
  onUp: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={active ? "default" : "outline"}
      className="h-10 w-10 p-0 relative select-none"
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    >
      {icon}
      <span className="absolute bottom-0.5 right-0.5 text-[8px] opacity-40 leading-none">
        {label}
      </span>
    </Button>
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
