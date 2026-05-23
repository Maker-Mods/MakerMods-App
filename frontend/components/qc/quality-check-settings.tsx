"use client";

import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import {
  api,
  type QcCostEstimate,
  type QcProviderPreset,
  type QcSettings,
} from "@/lib/api";

import { ProviderCard } from "./provider-card";

export function QualityCheckSettings() {
  const [settings, setSettings] = useState<QcSettings | null>(null);
  const [presets, setPresets] = useState<QcProviderPreset[]>([]);
  const [cost, setCost] = useState<QcCostEstimate | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, p] = await Promise.all([
          api.qc.getSettings(),
          api.qc.presets(),
        ]);
        if (cancelled) return;
        setSettings(s);
        setPresets(p);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settings) return;
    void api.qc.costEstimate().then(setCost);
  }, [
    settings?.providers.vlm.model,
    settings?.providers.llm.model,
    settings?.providers.vlm.provider,
    settings?.providers.llm.provider,
  ]);

  const patch = async (p: Parameters<typeof api.qc.patchSettings>[0]) => {
    const next = await api.qc.patchSettings(p);
    setSettings(next);
  };

  if (loading || !settings) {
    return (
      <div className="text-muted-foreground text-sm">Loading settings…</div>
    );
  }

  const missingKey =
    settings.enabled &&
    (!settings.providers.vlm.api_key_ref ||
      !settings.providers.llm.api_key_ref);
  const providersDisabled = !settings.privacy.upload_frames;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Quality Check</h1>
        <p className="text-muted-foreground text-sm">
          Automatically review recordings and flag failed or noisy episodes.
        </p>
      </div>

      {missingKey && (
        <Alert>
          <AlertTitle>Setup incomplete</AlertTitle>
          <AlertDescription>
            Add an API key below to finish setup.
          </AlertDescription>
        </Alert>
      )}
      {providersDisabled && settings.enabled && (
        <Alert>
          <AlertTitle>Rule-only mode</AlertTitle>
          <AlertDescription>
            Frame upload is off — running locally with rule-based metrics only.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Enable Auto Check</CardTitle>
          <CardDescription>
            Run automatic quality review on every recording session. Flagged
            episodes can be deleted with one click.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <Label htmlFor="qc-enable" className="text-base">
              Auto Check
            </Label>
            <Switch
              id="qc-enable"
              checked={settings.enabled}
              onCheckedChange={(v) => void patch({ enabled: v })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>When to run</CardTitle>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={settings.trigger}
            onValueChange={(v) =>
              void patch({ trigger: v as QcSettings["trigger"] })
            }
            className="space-y-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id="trg-after" value="after_session" />
              <Label htmlFor="trg-after">After each recording session</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="trg-manual" value="manual" />
              <Label htmlFor="trg-manual">Only when I run it manually</Label>
            </div>
          </RadioGroup>
        </CardContent>
      </Card>

      <ProviderCard
        role="vlm"
        cfg={settings.providers.vlm}
        presets={presets}
        disabled={providersDisabled}
        onSettings={setSettings}
      />
      <ProviderCard
        role="llm"
        cfg={settings.providers.llm}
        presets={presets}
        disabled={providersDisabled}
        onSettings={setSettings}
      />

      <Card>
        <CardHeader>
          <CardTitle>Privacy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base">
                Upload frames to model providers
              </Label>
              <p className="text-muted-foreground text-sm">
                When off, Auto Check runs locally with rule-based metrics only
                (no VLM/LLM calls).
              </p>
            </div>
            <Switch
              checked={settings.privacy.upload_frames}
              onCheckedChange={(v) =>
                void patch({
                  privacy: { ...settings.privacy, upload_frames: v },
                })
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <Label className="text-base">
              Redact faces in uploaded frames
            </Label>
            <Switch
              checked={settings.privacy.redact_faces}
              disabled={!settings.privacy.upload_frames}
              onCheckedChange={(v) =>
                void patch({
                  privacy: { ...settings.privacy, redact_faces: v },
                })
              }
            />
          </div>

          <div className="grid grid-cols-[1fr_120px] items-center gap-3">
            <Label>Thumbnail retention (hours)</Label>
            <Input
              type="number"
              min={1}
              max={168}
              value={settings.privacy.thumbnail_ttl_hours}
              onChange={(e) =>
                void patch({
                  privacy: {
                    ...settings.privacy,
                    thumbnail_ttl_hours: Number(e.target.value),
                  },
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Spending limit</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[1fr_120px] items-center gap-3">
            <Label>
              Warn me when a session would spend more than (USD)
            </Label>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={settings.budget.warn_above_usd}
              onChange={(e) =>
                void patch({
                  budget: {
                    ...settings.budget,
                    warn_above_usd: Number(e.target.value),
                  },
                })
              }
            />
          </div>
          <div className="grid grid-cols-[1fr_120px] items-center gap-3">
            <Label>Stop a session if it would spend more than (USD)</Label>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={settings.budget.max_usd_per_session}
              onChange={(e) =>
                void patch({
                  budget: {
                    ...settings.budget,
                    max_usd_per_session: Number(e.target.value),
                  },
                })
              }
            />
          </div>
          <p className="text-muted-foreground text-sm">
            Estimated cost per 15s episode (2 cameras):{" "}
            <span className="font-medium">
              {cost == null
                ? "—"
                : `~ $${cost.per_episode_usd.toFixed(3)}`}
            </span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
