"use client";

import { useMemo, useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  api,
  type QcProviderConfig,
  type QcProviderPreset,
  type QcProviderRole,
  type QcProviderTestResponse,
  type QcSettings,
} from "@/lib/api";

import { SecretInput } from "./secret-input";
import { StatusBadge } from "./status-badge";

const TITLES: Record<QcProviderRole, { title: string; description: string }> = {
  vlm: {
    title: "Vision model (per-camera chunks)",
    description: "Used to describe what each camera sees in 5-frame chunks.",
  },
  llm: {
    title: "Reasoning model (trajectory-level)",
    description:
      "Combines all camera reports with telemetry to judge each episode.",
  },
};

function relative(ts: string | null | undefined): string {
  if (!ts) return "";
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)} s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  return `${Math.round(diff / 86400)} d ago`;
}

interface Props {
  role: QcProviderRole;
  cfg: QcProviderConfig;
  presets: QcProviderPreset[];
  disabled?: boolean;
  onSettings: (next: QcSettings) => void;
}

export function ProviderCard({
  role,
  cfg,
  presets,
  disabled,
  onSettings,
}: Props) {
  const preset = useMemo(
    () => presets.find((p) => p.provider === cfg.provider) ?? presets[0],
    [presets, cfg.provider],
  );
  const modelOptions = useMemo(
    () => (role === "vlm" ? preset?.vlm_models : preset?.llm_models) ?? [],
    [preset, role],
  );

  const [testing, setTesting] = useState(false);
  const [lastTest, setLastTest] = useState<QcProviderTestResponse | null>(null);

  const patch = async (partial: Partial<QcProviderConfig>) => {
    const next = await api.qc.patchSettings({
      providers: {
        ...(await api.qc.getSettings()).providers,
        [role]: { ...cfg, ...partial, last_verified_at: null },
      },
    });
    onSettings(next);
  };

  const onProviderChange = async (provider: string) => {
    const p = presets.find((x) => x.provider === provider) ?? preset;
    const defaultModel =
      role === "vlm" ? p?.vlm_models[0] : p?.llm_models[0];
    await patch({
      provider: provider as QcProviderConfig["provider"],
      base_url: p?.base_url || cfg.base_url || "",
      model: defaultModel ?? cfg.model,
    });
  };

  const onTest = async () => {
    setTesting(true);
    try {
      const r = await api.qc.testProvider(role);
      setLastTest(r);
      if (r.ok) {
        const refreshed = await api.qc.getSettings();
        onSettings(refreshed);
      }
    } finally {
      setTesting(false);
    }
  };

  const onCommitKey = async (key: string) => {
    const next = await api.qc.setKey(role, key);
    onSettings(next);
    setLastTest(null);
  };

  const onClearKey = async () => {
    const next = await api.qc.clearKey(role);
    onSettings(next);
    setLastTest(null);
  };

  const status: { tone: "success" | "warn" | "danger" | "neutral"; text: string } =
    !cfg.api_key_ref
      ? { tone: "neutral", text: "Not configured" }
      : lastTest && !lastTest.ok
        ? { tone: "danger", text: lastTest.error ?? "Unreachable" }
        : cfg.last_verified_at
          ? { tone: "success", text: `Verified · ${relative(cfg.last_verified_at)}` }
          : { tone: "warn", text: "Untested" };

  const cantTest = disabled || !cfg.api_key_ref || !cfg.base_url;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{TITLES[role].title}</CardTitle>
        <CardDescription>{TITLES[role].description}</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-[140px_1fr] items-center gap-x-4 gap-y-3">
        <Label>Provider</Label>
        <Select
          value={cfg.provider}
          onValueChange={onProviderChange}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {presets.map((p) => (
              <SelectItem key={p.provider} value={p.provider}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Label>Model</Label>
        {modelOptions.length > 0 ? (
          <Select
            value={cfg.model}
            onValueChange={(v) => void patch({ model: v })}
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={cfg.model}
            onChange={(e) => void patch({ model: e.target.value })}
            disabled={disabled}
            placeholder="model id"
          />
        )}

        <Label>API base URL</Label>
        <Input
          value={cfg.base_url ?? ""}
          onChange={(e) => void patch({ base_url: e.target.value })}
          disabled={disabled}
          placeholder="https://..."
        />

        <Label>API key</Label>
        <SecretInput
          hasValue={!!cfg.api_key_ref}
          disabled={disabled}
          onCommit={onCommitKey}
          onClear={onClearKey}
        />

        <Label>Status</Label>
        <div className="flex items-center gap-2">
          <StatusBadge tone={status.tone}>{status.text}</StatusBadge>
          {lastTest?.ok && (
            <span className="text-muted-foreground text-xs">
              {lastTest.latency_ms?.toFixed(0)} ms · est. $
              {lastTest.est_cost_usd?.toFixed(3)} / episode
            </span>
          )}
        </div>

        <div />
        <div>
          <Button
            variant="secondary"
            disabled={cantTest}
            onClick={onTest}
          >
            {testing ? "Testing…" : "Test connection"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
