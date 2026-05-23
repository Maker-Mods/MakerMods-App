"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SecretInputProps {
  /** True when a key is already on file (server returns a non-null api_key_ref). */
  hasValue: boolean;
  placeholder?: string;
  disabled?: boolean;
  onCommit: (key: string) => Promise<void> | void;
  onClear?: () => Promise<void> | void;
}

export function SecretInput({
  hasValue,
  placeholder = "sk-...",
  disabled,
  onCommit,
  onClear,
}: SecretInputProps) {
  const [editing, setEditing] = useState(!hasValue);
  const [show, setShow] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <Input
          value="••••••••••••••••"
          readOnly
          className="font-mono"
          disabled
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            setDraft("");
            setEditing(true);
          }}
        >
          Change
        </Button>
        {onClear && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => void onClear()}
          >
            Remove
          </Button>
        )}
      </div>
    );
  }

  const commit = async () => {
    const value = draft.trim();
    if (value.length < 16) return;
    setBusy(true);
    try {
      await onCommit(value);
      setEditing(false);
      setDraft("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        type={show ? "text" : "password"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft && void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
        }}
        placeholder={placeholder}
        className="font-mono"
        disabled={disabled || busy}
        autoFocus
        spellCheck={false}
        autoComplete="off"
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setShow((s) => !s)}
        disabled={disabled}
        aria-label={show ? "Hide key" : "Show key"}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
      {hasValue && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setEditing(false);
            setDraft("");
          }}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}
