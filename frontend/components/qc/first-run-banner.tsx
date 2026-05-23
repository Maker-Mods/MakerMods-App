"use client";

import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api, type QcSettings } from "@/lib/api";

interface Props {
  /** Called when the user clicks "Set up Auto Check". */
  onOpenSettings: () => void;
}

/**
 * Non-blocking banner shown after the first recording session when Auto Check
 * is still off. Honors "Not now" (24h snooze) and "Don't ask again".
 */
export function FirstRunBanner({ onOpenSettings }: Props) {
  const [settings, setSettings] = useState<QcSettings | null>(null);

  useEffect(() => {
    void api.qc.getSettings().then(setSettings);
  }, []);

  if (!settings) return null;
  if (settings.enabled || settings.first_run_dismissed) return null;
  if (
    settings.not_now_until &&
    new Date(settings.not_now_until).getTime() > Date.now()
  ) {
    return null;
  }

  const snooze = async () => {
    const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    setSettings(await api.qc.patchSettings({ not_now_until: until }));
  };
  const dismiss = async () => {
    setSettings(await api.qc.patchSettings({ first_run_dismissed: true }));
  };

  return (
    <Alert className="border-sky-200 bg-sky-50">
      <FlaskConical className="h-4 w-4" />
      <AlertTitle>Auto-check your recordings</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          MakerMods can review each episode after recording and flag failures,
          drops, or off-task takes. Uses your own model API keys. Off by
          default.
        </p>
        <div className="flex gap-2">
          <Button onClick={onOpenSettings}>Set up Auto Check</Button>
          <Button variant="ghost" onClick={() => void snooze()}>
            Not now
          </Button>
          <Button variant="ghost" onClick={() => void dismiss()}>
            Don&apos;t ask again
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
