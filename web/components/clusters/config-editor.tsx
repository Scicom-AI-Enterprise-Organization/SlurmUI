"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Save, RotateCcw } from "lucide-react";

interface ConfigEditorProps {
  clusterId: string;
  initialConfig: Record<string, unknown>;
}

export function ConfigEditor({ clusterId, initialConfig }: ConfigEditorProps) {
  const [configText, setConfigText] = useState(
    JSON.stringify(initialConfig, null, 2)
  );
  const [isSaving, setIsSaving] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const handleChange = (value: string) => {
    setConfigText(value);
    try {
      JSON.parse(value);
      setParseError(null);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Invalid JSON");
    }
  };

  const handleSave = async () => {
    if (parseError) return;

    setIsSaving(true);
    try {
      const config = JSON.parse(configText);
      const res = await fetch(`/api/clusters/${clusterId}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });

      const data = await res.json();

      if (res.ok || res.status === 207) {
        toast.success("Config saved", {
          description: data.warning ?? "Configuration saved and propagated successfully.",
        });
      } else {
        toast.error("Error", {
          description: data.error ?? "Failed to save configuration.",
        });
      }
    } catch {
      toast.error("Error", {
        description: "Failed to save configuration.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setConfigText(JSON.stringify(initialConfig, null, 2));
    setParseError(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={handleReset}>
          <RotateCcw className="mr-2 h-3 w-3" />
          Reset
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!!parseError || isSaving}
        >
          <Save className="mr-2 h-3 w-3" />
          {isSaving ? "Saving..." : "Save & Propagate"}
        </Button>
      </div>

      {parseError && (
        <p className="text-sm text-destructive">JSON Error: {parseError}</p>
      )}

      <ScrollArea className="h-[500px] rounded-md border bg-background">
        <textarea
          className="h-full w-full resize-none bg-background text-foreground p-4 font-mono text-sm focus:outline-none"
          value={configText}
          onChange={(e) => handleChange(e.target.value)}
          spellCheck={false}
        />
      </ScrollArea>
    </div>
  );
}
