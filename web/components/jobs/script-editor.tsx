"use client";

import { Label } from "@/components/ui/label";
import { CodeEditor } from "@/components/ui/code-editor";

interface ScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function ScriptEditor({ value, onChange }: ScriptEditorProps) {
  return (
    <div className="space-y-2">
      <Label>Job Script</Label>
      {/*
        Same code-editor surface as the files page so users see line
        numbers, a real fixed-width font, bracket matching, and search.
        Filename ends in ".sh" only as a hint for the indent fallback
        (we don't have a bash language pack installed); CodeMirror still
        gives us all the basics for plain text.
      */}
      <CodeEditor
        className="h-[540px] overflow-hidden rounded-md border"
        value={value}
        onChange={onChange}
        filename="job.sh"
        fontSize={12}
        placeholder={"#!/bin/bash\n#SBATCH --job-name=my-job\n..."}
      />
    </div>
  );
}
