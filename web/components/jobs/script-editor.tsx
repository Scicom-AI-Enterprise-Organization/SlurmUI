"use client";

import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface ScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
}

const TEMPLATE = `#!/bin/bash
#SBATCH --job-name=my-job
#SBATCH --output=output_%j.log
#SBATCH --error=error_%j.log
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=01:00:00

# Your commands here
echo "Job started at $(date)"
echo "Running on node: $(hostname)"

# Example: run a Python script
# python train.py --epochs 100

echo "Job completed at $(date)"
`;

export function ScriptEditor({ value, onChange }: ScriptEditorProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Job Script</Label>
        {!value && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => onChange(TEMPLATE)}
          >
            Load template
          </button>
        )}
      </div>
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
