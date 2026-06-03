"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

type TestStatus = "idle" | "testing" | "ok" | "failed";

export function NewGpuProviderForm() {
  const router = useRouter();
  const [kind, setKind] = useState("runpod");
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMsg, setTestMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Any credential change invalidates a previous test result.
  function resetTest() {
    setTestStatus("idle");
    setTestMsg("");
  }

  const canTest = !!apiKey.trim() && testStatus !== "testing";
  const canSave = !!(name.trim() && apiKey.trim() && testStatus === "ok") && !saving;

  async function handleTest() {
    setTestStatus("testing");
    setTestMsg("");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/admin/gpu-providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, apiKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTestStatus("failed");
        setTestMsg(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setTestStatus(data.ok ? "ok" : "failed");
      setTestMsg(data.message);
    } catch {
      setTestStatus("failed");
      setTestMsg("Request failed");
    }
  }

  async function handleSave() {
    setSaving(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/admin/gpu-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind, apiKey }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push("/admin/gpu-providers");
      router.refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to save provider");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Provider account</CardTitle>
          <CardDescription>
            The API key is verified on save and never shown again — only its last 4
            characters stay visible.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="provider-kind">Provider</Label>
              <Select value={kind} onValueChange={(v) => { setKind(v); resetTest(); }}>
                <SelectTrigger id="provider-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="runpod">RunPod</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="provider-name">Name</Label>
              <Input
                id="provider-name"
                placeholder="my-runpod-account"
                value={name}
                onChange={(e) => { setName(e.target.value); setErrorMsg(null); }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="provider-api-key">API Key</Label>
            <Input
              id="provider-api-key"
              type="password"
              placeholder="rpa_..."
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); resetTest(); setErrorMsg(null); }}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Create one at runpod.io → Settings → API Keys. The key needs pod read/write access.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 text-sm">
          {testStatus === "ok" && (
            <p className="flex items-center gap-1.5 text-green-600">
              <Check className="h-4 w-4 shrink-0" /> {testMsg}
            </p>
          )}
          {testStatus === "failed" && (
            <p className="flex items-center gap-1.5 text-destructive">
              <X className="h-4 w-4 shrink-0" /> {testMsg}
            </p>
          )}
          {errorMsg && <p className="text-destructive">{errorMsg}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={handleTest} disabled={!canTest}>
            {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Test connection
          </Button>
          <Button
            variant="ghost"
            onClick={() => router.push("/admin/gpu-providers")}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!canSave}
            title={testStatus !== "ok" ? "Run a successful connection test first" : undefined}
            className={cn(testStatus !== "ok" && "cursor-not-allowed")}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saving ? "Saving..." : "Save Provider"}
          </Button>
        </div>
      </div>
    </div>
  );
}
