"use client";

import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface ScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function ScriptEditor({ value, onChange }: ScriptEditorProps) {
  return (
    <div className="space-y-2">
      <Label>Job Script</Label>
      <Textarea
        className="min-h-[400px] font-mono text-sm"
        placeholder="#!/bin/bash&#10;#SBATCH --job-name=my-job&#10;..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}
