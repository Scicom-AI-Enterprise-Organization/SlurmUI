"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface StepBasicsProps {
  data: {
    clusterName: string;
    controllerHost: string;
    controllerIp: string;
    controllerSshPort: number;
    freeipaServer: string;
    freeipaDomain: string;
  };
  onChange: (data: StepBasicsProps["data"]) => void;
}

export function StepBasics({ data, onChange }: StepBasicsProps) {
  const update = (field: keyof StepBasicsProps["data"], value: string | number) => {
    onChange({ ...data, [field]: value });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="clusterName">Cluster Name</Label>
        <Input
          id="clusterName"
          placeholder="sci-cluster-01"
          value={data.clusterName}
          onChange={(e) => update("clusterName", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          A unique identifier for this cluster. Use lowercase and hyphens.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="controllerHost">Controller Hostname</Label>
        <Input
          id="controllerHost"
          placeholder="slm-master"
          value={data.controllerHost}
          onChange={(e) => update("controllerHost", e.target.value)}
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-2">
          <Label htmlFor="controllerIp">Controller IP</Label>
          <Input
            id="controllerIp"
            placeholder="192.168.1.1"
            value={data.controllerIp}
            onChange={(e) => update("controllerIp", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="controllerSshPort">SSH Port</Label>
          <Input
            id="controllerSshPort"
            type="number"
            placeholder="22"
            value={data.controllerSshPort}
            onChange={(e) => update("controllerSshPort", parseInt(e.target.value) || 22)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="freeipaServer">FreeIPA Server</Label>
        <Input
          id="freeipaServer"
          placeholder="ipa.scicom.internal"
          value={data.freeipaServer}
          onChange={(e) => update("freeipaServer", e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="freeipaDomain">FreeIPA Domain</Label>
        <Input
          id="freeipaDomain"
          placeholder="scicom.internal"
          value={data.freeipaDomain}
          onChange={(e) => update("freeipaDomain", e.target.value)}
        />
      </div>
    </div>
  );
}
