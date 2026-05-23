"use client";

import { AlertTriangle, Check, MinusCircle, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";

type Tone = "success" | "warn" | "danger" | "neutral";

const TONES: Record<Tone, { className: string; icon: React.ReactNode }> = {
  success: {
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: <Check className="h-3 w-3" />,
  },
  warn: {
    className: "border-amber-200 bg-amber-50 text-amber-800",
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  danger: {
    className: "border-rose-200 bg-rose-50 text-rose-700",
    icon: <X className="h-3 w-3" />,
  },
  neutral: {
    className: "border-slate-200 bg-slate-50 text-slate-600",
    icon: <MinusCircle className="h-3 w-3" />,
  },
};

export function StatusBadge({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <Badge variant="outline" className={`gap-1 ${t.className}`}>
      {t.icon}
      <span>{children}</span>
    </Badge>
  );
}
