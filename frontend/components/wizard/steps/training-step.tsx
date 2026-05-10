"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Key,
  Loader2,
  Play,
  Square,
  XCircle,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { services } from "@/lib/services";
import { useWizard } from "../wizard-provider";
import { StepCard } from "../step-card";
import {
  TRAINING_MODELS,
  QUALIA_CAMERA_MAPPING,
  TRAINING_PHASES,
  VLA_TYPES_REQUIRING_MODEL_ID,
  DEFAULT_MODEL_IDS,
} from "@/lib/wizard-types";

// ─── Types ───────────────────────────────────────────────────────────────────

interface GPUInstance {
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
}

interface HFDataset {
  repo_id: string;
  repo_type: string;
  private: boolean;
  url: string | null;
}

// ─── Phase display helpers ───────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  queuing: "Queuing",
  credit_validation: "Validating Credits",
  instance_booting: "Booting Instance",
  instance_activation: "Activating Instance",
  instance_setup: "Setting Up Instance",
  dataset_preprocessing: "Preprocessing Dataset",
  training_running: "Training",
  model_uploading: "Uploading Model",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

// ─── Component ───────────────────────────────────────────────────────────────

export function TrainingStep() {
  const { state, dispatch } = useWizard();
  const { trainingConfig, recordingConfig } = state;

  // API key
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyValid, setKeyValid] = useState<boolean | null>(null);
  const [keyChecking, setKeyChecking] = useState(false);
  const [keyMessage, setKeyMessage] = useState("");

  // Datasets
  const [datasets, setDatasets] = useState<HFDataset[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(false);
  const [hfUsername, setHfUsername] = useState<string | null>(null);

  // Dataset image keys (fetched from HF dataset meta/info.json)
  const [datasetImageKeys, setDatasetImageKeys] = useState<string[]>([]);
  const [imageKeysLoading, setImageKeysLoading] = useState(false);

  // Instances
  const [instances, setInstances] = useState<GPUInstance[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);

  // Job
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobPhase, setJobPhase] = useState<string>("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── On mount: check API key & load HF datasets ─────────────────────────

  useEffect(() => {
    checkApiKey();
    loadDatasets();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Prefill from recording config
  useEffect(() => {
    if (!trainingConfig.datasetId && recordingConfig.repoId) {
      dispatch({
        type: "SET_TRAINING_CONFIG",
        config: { datasetId: recordingConfig.repoId },
      });
    }
    if (!trainingConfig.jobDescription && recordingConfig.task) {
      dispatch({
        type: "SET_TRAINING_CONFIG",
        config: { jobDescription: recordingConfig.task },
      });
    }
  }, []);

  // Fetch image keys when dataset changes
  useEffect(() => {
    const datasetId = trainingConfig.datasetId;
    if (!datasetId) {
      setDatasetImageKeys([]);
      return;
    }
    let cancelled = false;
    setImageKeysLoading(true);
    services
      .getDatasetImageKeys(datasetId)
      .then((keys) => {
        if (cancelled) return;
        setDatasetImageKeys(keys);
        dispatch({
          type: "SET_TRAINING_CONFIG",
          config: { cameraNames: keys },
        });
      })
      .catch(() => {
        if (!cancelled) setDatasetImageKeys([]);
      })
      .finally(() => {
        if (!cancelled) setImageKeysLoading(false);
      });
    return () => { cancelled = true; };
  }, [trainingConfig.datasetId]);

  // Prefill output model name placeholder
  const modelNamePlaceholder = trainingConfig.jobDescription
    ? `${trainingConfig.jobDescription.replace(/\s+/g, "_").toLowerCase()}_act`
    : "my_task_act";

  // ─── API Key ─────────────────────────────────────────────────────────────

  const checkApiKey = useCallback(async () => {
    setKeyChecking(true);
    try {
      const result = await services.getQualiaKeyStatus();
      setKeyValid(result.is_valid);
      setKeyMessage(result.message);
      if (result.is_valid) {
        loadInstances();
      }
    } catch {
      setKeyValid(false);
      setKeyMessage("Could not check API key status");
    } finally {
      setKeyChecking(false);
    }
  }, []);

  const submitApiKey = useCallback(async () => {
    if (!apiKeyInput.trim()) return;
    setKeyChecking(true);
    setError(null);
    try {
      const result = await services.validateQualiaKey(apiKeyInput.trim());
      setKeyValid(result.is_valid);
      setKeyMessage(result.message);
      if (result.is_valid) {
        setApiKeyInput("");
        loadInstances();
      }
    } catch (e: unknown) {
      setKeyValid(false);
      setKeyMessage(e instanceof Error ? e.message : "Failed to validate key");
    } finally {
      setKeyChecking(false);
    }
  }, [apiKeyInput]);

  // ─── HF Datasets ────────────────────────────────────────────────────────

  const loadDatasets = useCallback(async () => {
    setDatasetsLoading(true);
    try {
      const hfStatus = await services.checkHFStatus();
      if (hfStatus.is_logged_in && hfStatus.username) {
        setHfUsername(hfStatus.username);
        const res = await fetch("/api/huggingface/repos");
        if (res.ok) {
          const repos: HFDataset[] = await res.json();
          setDatasets(repos.filter((r) => r.repo_type === "dataset"));
        }
      }
    } catch {
      // Silently fail - user can type dataset ID manually
    } finally {
      setDatasetsLoading(false);
    }
  }, []);

  // ─── GPU Instances ───────────────────────────────────────────────────────

  const loadInstances = useCallback(async () => {
    setInstancesLoading(true);
    try {
      const result = await services.listGPUInstances();
      setInstances(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load instances");
    } finally {
      setInstancesLoading(false);
    }
  }, []);

  // ─── Submit Training Job ─────────────────────────────────────────────────

  const needsModelId = (VLA_TYPES_REQUIRING_MODEL_ID as readonly string[]).includes(
    trainingConfig.vlaType
  );
  const canSubmit =
    keyValid &&
    trainingConfig.datasetId &&
    trainingConfig.instanceType &&
    trainingConfig.outputModelName &&
    trainingConfig.hours > 0 &&
    trainingConfig.batchSize > 0 &&
    (!needsModelId || trainingConfig.modelId.trim() !== "") &&
    !state.trainingJobId;

  const submitTraining = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await services.startTraining(trainingConfig);
      dispatch({
        type: "SET_TRAINING_JOB",
        jobId: result.job_id,
        projectId: result.project_id,
      });
      startPolling(result.job_id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start training");
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, trainingConfig, dispatch]);

  // ─── Job Status Polling ──────────────────────────────────────────────────

  const startPolling = useCallback((jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await services.getTrainingStatus(jobId);
        setJobStatus(status.status);
        setJobPhase(status.phase);
        if (status.output_model_id) {
          dispatch({
            type: "SET_TRAINING_OUTPUT_MODEL",
            modelId: status.output_model_id,
          });
          // Persist to localStorage so the inference page can offer it as a dropdown option
          try {
            const key = "lerobot_trained_policy_paths";
            const existing = JSON.parse(localStorage.getItem(key) || "[]");
            if (!existing.some((p: { path: string }) => p.path === status.output_model_id)) {
              existing.unshift({ path: status.output_model_id, savedAt: new Date().toISOString() });
              localStorage.setItem(key, JSON.stringify(existing));
            }
          } catch { /* ignore */ }
        }
        if (
          status.status === "completed" ||
          status.status === "failed" ||
          status.status === "cancelled"
        ) {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        // Ignore polling errors
      }
    }, 5000);
  }, [dispatch]);

  // Resume polling if we already have a job
  useEffect(() => {
    if (state.trainingJobId && !jobStatus) {
      startPolling(state.trainingJobId);
    }
  }, [state.trainingJobId]);

  const cancelTraining = useCallback(async () => {
    if (!state.trainingJobId) return;
    try {
      await services.cancelTraining(state.trainingJobId);
      setJobStatus("cancelled");
      if (pollRef.current) clearInterval(pollRef.current);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to cancel training");
    }
  }, [state.trainingJobId]);

  const resetJob = useCallback(() => {
    dispatch({ type: "CLEAR_TRAINING_JOB" });
    setJobStatus(null);
    setJobPhase("");
    setError(null);
  }, [dispatch]);

  // ─── Update config helper ────────────────────────────────────────────────

  const updateConfig = useCallback(
    (partial: Partial<typeof trainingConfig>) => {
      dispatch({ type: "SET_TRAINING_CONFIG", config: partial });
    },
    [dispatch]
  );

  // ─── Camera keys from dataset ────────────────────────────────────────────

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <StepCard
      title="Training"
      description="Train a policy on your recorded dataset using Qualia Studios"
      showNext={true}
      nextDisabled={false}
    >
      <div className="space-y-6">
        {/* ── API Key Section ── */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            <Label className="text-sm font-medium">Qualia API Key</Label>
          </div>

          {keyChecking ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking API key...
            </div>
          ) : keyValid ? (
            <div className="flex items-center gap-2 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4" />
              API key configured and valid
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Get your API key from{" "}
                <a
                  href="https://app.qualiastudios.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-primary"
                >
                  app.qualiastudios.dev
                </a>{" "}
                → Settings
              </p>
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder="Paste your Qualia API key..."
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitApiKey()}
                />
                <Button
                  onClick={submitApiKey}
                  disabled={!apiKeyInput.trim() || keyChecking}
                  size="sm"
                >
                  {keyChecking ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Save"
                  )}
                </Button>
              </div>
              {keyMessage && !keyValid && (
                <p className="text-xs text-red-500">{keyMessage}</p>
              )}
            </div>
          )}
        </div>

        <Separator />

        {/* ── Dataset Selection ── */}
        <div className="space-y-2">
          <Label>Dataset</Label>
          {datasetsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading datasets...
            </div>
          ) : datasets.length > 0 ? (
            <Select
              value={trainingConfig.datasetId}
              onValueChange={(v) => updateConfig({ datasetId: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a dataset..." />
              </SelectTrigger>
              <SelectContent>
                {datasets.map((ds) => (
                  <SelectItem key={ds.repo_id} value={ds.repo_id}>
                    {ds.repo_id}
                    {ds.private && (
                      <span className="ml-2 text-xs text-muted-foreground">(private)</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              placeholder={
                hfUsername
                  ? `${hfUsername}/my_dataset`
                  : "username/dataset_name"
              }
              value={trainingConfig.datasetId}
              onChange={(e) => updateConfig({ datasetId: e.target.value })}
            />
          )}
          {recordingConfig.repoId && trainingConfig.datasetId === recordingConfig.repoId && (
            <p className="text-xs text-muted-foreground">
              Pre-filled from your last recording session
            </p>
          )}
        </div>

        <Separator />

        {/* ── Model Selection ── */}
        <div className="space-y-2">
          <Label>Model Architecture</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {TRAINING_MODELS.map((model) => (
              <button
                key={model.value}
                disabled={!model.supported}
                onClick={() => {
                  const updates: Partial<typeof trainingConfig> = { vlaType: model.value };
                  // Auto-fill default base model ID for types that require it
                  if ((VLA_TYPES_REQUIRING_MODEL_ID as readonly string[]).includes(model.value)) {
                    updates.modelId = DEFAULT_MODEL_IDS[model.value] || "";
                  } else {
                    updates.modelId = "";
                  }
                  updateConfig(updates);
                }}
                className={`relative rounded-lg border p-3 text-left text-sm transition-colors ${
                  trainingConfig.vlaType === model.value
                    ? "border-primary bg-primary/5 font-medium"
                    : model.supported
                    ? "hover:border-primary/50 hover:bg-muted"
                    : "opacity-50 cursor-not-allowed"
                }`}
              >
                <span>{model.label}</span>
                {!model.supported && (
                  <Badge
                    variant="secondary"
                    className="absolute -top-2 -right-2 text-[10px] px-1.5"
                  >
                    Soon
                  </Badge>
                )}
              </button>
            ))}
          </div>

          {/* Base model ID (required for smolvla, pi0, pi05) */}
          {(VLA_TYPES_REQUIRING_MODEL_ID as readonly string[]).includes(trainingConfig.vlaType) && (
            <div className="space-y-1.5 mt-3">
              <Label>
                Base Model ID <span className="text-red-500">*</span>
              </Label>
              <Input
                placeholder={DEFAULT_MODEL_IDS[trainingConfig.vlaType] || "org/model_name"}
                value={trainingConfig.modelId}
                onChange={(e) => updateConfig({ modelId: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                HuggingFace model to fine-tune (e.g. lerobot/smolvla_base)
              </p>
            </div>
          )}
        </div>

        <Separator />

        {/* ── Camera Mapping (Read-only, from dataset) ── */}
        {imageKeysLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading camera keys from dataset...
          </div>
        ) : datasetImageKeys.length > 0 ? (
          <>
            <div className="space-y-3">
              <Label>Camera Mapping</Label>
              <p className="text-xs text-muted-foreground">
                Detected from your dataset. These are automatically mapped to Qualia&apos;s camera slots for training.
              </p>
              <div className="space-y-1.5">
                {datasetImageKeys.map((fullKey) => {
                  const shortName = fullKey.split(".").pop()!;
                  const qualiaSlot = QUALIA_CAMERA_MAPPING[shortName];
                  return (
                    <div
                      key={fullKey}
                      className="flex items-center gap-3 rounded-md border bg-muted/50 px-3 py-2 text-sm"
                    >
                      <span className="font-mono text-xs bg-background rounded px-2 py-0.5 border">
                        {fullKey}
                      </span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      {qualiaSlot ? (
                        <span className="font-mono text-xs bg-background rounded px-2 py-0.5 border">
                          {qualiaSlot}
                        </span>
                      ) : (
                        <span className="text-xs text-amber-600">
                          No Qualia mapping (will be skipped)
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <Separator />
          </>
        ) : trainingConfig.datasetId ? (
          <>
            <div className="space-y-2">
              <Label>Camera Mapping</Label>
              <p className="text-xs text-muted-foreground">
                No image keys found in this dataset.
              </p>
            </div>
            <Separator />
          </>
        ) : null}

        {/* ── GPU Instance Selection ── */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <Label>GPU Instance</Label>
          </div>

          {!keyValid ? (
            <p className="text-sm text-muted-foreground">
              Configure your API key above to view available instances.
            </p>
          ) : instancesLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading GPU instances...
            </div>
          ) : instances.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No GPU instances available. Check your Qualia account.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {instances.map((inst) => {
                const isSelected = trainingConfig.instanceType === inst.id;
                return (
                  <button
                    key={inst.id}
                    onClick={() => updateConfig({ instanceType: inst.id })}
                    className={`rounded-lg border p-4 text-left transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "hover:border-primary/50 hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        {inst.regions.length > 0 && (
                          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            {inst.regions[0]}
                          </p>
                        )}
                        <p className="font-semibold text-sm mt-0.5">
                          {inst.name}{" "}
                          <span className="text-muted-foreground font-normal">
                            x{inst.specs.gpu_count || 1}
                          </span>
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Cost
                        </p>
                        <p className="text-sm font-semibold text-orange-500">
                          {inst.credits_per_hour} credits/hr
                        </p>
                      </div>
                    </div>
                    <Separator className="my-2" />
                    <div className="grid grid-cols-4 gap-1 text-[11px]">
                      <div>
                        <p className="uppercase tracking-wider text-muted-foreground font-medium">
                          Cores
                        </p>
                        <p>{inst.specs.vcpus} VCPUs</p>
                      </div>
                      <div>
                        <p className="uppercase tracking-wider text-muted-foreground font-medium">
                          VRAM
                        </p>
                        <p>{inst.gpu_description || `${inst.specs.gpu_type}`}</p>
                      </div>
                      <div>
                        <p className="uppercase tracking-wider text-muted-foreground font-medium">
                          Memory
                        </p>
                        <p>{inst.specs.memory_gib} GiB</p>
                      </div>
                      <div>
                        <p className="uppercase tracking-wider text-muted-foreground font-medium">
                          Storage
                        </p>
                        <p>{inst.specs.storage_gib} GiB</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <Separator />

        {/* ── Training Parameters ── */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Duration (Hours)</Label>
            <Input
              type="number"
              min={0.001}
              max={168}
              step={0.1}
              value={trainingConfig.hours || ""}
              onChange={(e) =>
                updateConfig({ hours: parseFloat(e.target.value) || 0 })
              }
              className={trainingConfig.hours <= 0 ? "border-red-500" : ""}
            />
            {trainingConfig.hours <= 0 && (
              <p className="text-xs text-red-500">Must be greater than 0</p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Batch Size</Label>
            <Input
              type="number"
              min={1}
              max={256}
              value={trainingConfig.batchSize || ""}
              onChange={(e) =>
                updateConfig({ batchSize: parseInt(e.target.value) || 0 })
              }
              className={trainingConfig.batchSize < 1 ? "border-red-500" : ""}
            />
            {trainingConfig.batchSize < 1 && (
              <p className="text-xs text-red-500">Must be at least 1</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label>
            Output Model Name <span className="text-red-500">*</span>
          </Label>
          <Input
            placeholder={modelNamePlaceholder}
            value={trainingConfig.outputModelName}
            onChange={(e) => updateConfig({ outputModelName: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            This will be the name of your trained model on HuggingFace.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Job Description</Label>
          <Input
            placeholder={
              recordingConfig.task || "Describe what this training job is for..."
            }
            value={trainingConfig.jobDescription}
            onChange={(e) => updateConfig({ jobDescription: e.target.value })}
          />
        </div>

        <Separator />

        {/* ── Error Display ── */}
        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* ── Job Status Tracker ── */}
        {state.trainingJobId && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Training Progress</Label>
              <p className="text-xs font-mono text-muted-foreground">
                Job: {state.trainingJobId.slice(0, 8)}...
              </p>
            </div>

            {/* Phase Progress */}
            <div className="space-y-1">
              {TRAINING_PHASES.map((phase, i) => {
                const currentIdx = TRAINING_PHASES.indexOf(
                  jobPhase as (typeof TRAINING_PHASES)[number]
                );
                const isComplete = i < currentIdx;
                const isCurrent = phase === jobPhase;
                const isTerminalCurrent =
                  isCurrent &&
                  (jobStatus === "completed" ||
                    jobStatus === "failed" ||
                    jobStatus === "cancelled");
                const isDone = isComplete || (isTerminalCurrent && jobStatus === "completed");

                return (
                  <div
                    key={phase}
                    className={`flex items-center gap-2 rounded px-2 py-1 text-sm ${
                      isTerminalCurrent && jobStatus === "failed"
                        ? "text-red-600 font-medium"
                        : isTerminalCurrent && jobStatus === "cancelled"
                        ? "text-muted-foreground font-medium"
                        : isCurrent
                        ? "bg-primary/10 font-medium"
                        : isDone
                        ? "text-green-600"
                        : "text-muted-foreground"
                    }`}
                  >
                    {isDone ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-600 flex-shrink-0" />
                    ) : isTerminalCurrent && jobStatus === "failed" ? (
                      <XCircle className="h-3.5 w-3.5 text-red-600 flex-shrink-0" />
                    ) : isTerminalCurrent && jobStatus === "cancelled" ? (
                      <XCircle className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    ) : isCurrent ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary flex-shrink-0" />
                    ) : (
                      <div className="h-3.5 w-3.5 rounded-full border border-muted-foreground/30 flex-shrink-0" />
                    )}
                    <span>{PHASE_LABELS[phase] || phase}</span>
                  </div>
                );
              })}
            </div>

            {/* Status badges */}
            {jobStatus === "failed" && (
              <Alert variant="destructive">
                <XCircle className="h-4 w-4" />
                <AlertDescription>
                  Training job failed. You can try again with different parameters.
                </AlertDescription>
              </Alert>
            )}

            {jobStatus === "completed" && (
              <div className="space-y-2">
                <Alert>
                  <Sparkles className="h-4 w-4" />
                  <AlertDescription>
                    Training complete! Your model has been uploaded to HuggingFace.
                  </AlertDescription>
                </Alert>
                {state.trainingOutputModelId && (
                  <div className="rounded-md border bg-muted/50 p-3 space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Output Model (HuggingFace)</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 rounded bg-background px-2 py-1 text-sm font-mono border">
                        {state.trainingOutputModelId}
                      </code>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(state.trainingOutputModelId!);
                        }}
                      >
                        Copy
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      This will be pre-filled in the Inference step as your policy path.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-2">
              {jobStatus !== "completed" &&
                jobStatus !== "failed" &&
                jobStatus !== "cancelled" && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={cancelTraining}
                  >
                    <Square className="h-3.5 w-3.5 mr-1.5" />
                    Cancel Job
                  </Button>
                )}
              {(jobStatus === "completed" ||
                jobStatus === "failed" ||
                jobStatus === "cancelled") && (
                <Button variant="outline" size="sm" onClick={resetJob}>
                  Start New Training
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ── Submit Button ── */}
        {!state.trainingJobId && (
          <Button
            className="w-full"
            size="lg"
            disabled={!canSubmit || submitting}
            onClick={submitTraining}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Submitting...
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Start Training
              </>
            )}
          </Button>
        )}

        {!canSubmit && !state.trainingJobId && (
          <p className="text-xs text-center text-muted-foreground">
            {!keyValid
              ? "Configure your Qualia API key to start training."
              : !trainingConfig.datasetId
              ? "Select a dataset to train on."
              : needsModelId && !trainingConfig.modelId.trim()
              ? "Enter a base model ID for the selected model type."
              : !trainingConfig.instanceType
              ? "Select a GPU instance."
              : !trainingConfig.outputModelName
              ? "Enter an output model name."
              : trainingConfig.hours <= 0
              ? "Set training duration."
              : ""}
          </p>
        )}
      </div>
    </StepCard>
  );
}
