"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface StepStorageProps {
  data: {
    mgmtNfsServer: string;
    mgmtNfsPath: string;
    dataNfsServer: string;
    dataNfsPath: string;
    nfsAllowedNetwork: string;
  };
  onChange: (data: StepStorageProps["data"]) => void;
}

export function StepStorage({ data, onChange }: StepStorageProps) {
  const update = (field: keyof StepStorageProps["data"], value: string) => {
    onChange({ ...data, [field]: value });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-3 font-medium">Management NFS</h3>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mgmtNfsServer">NFS Server</Label>
            <Input
              id="mgmtNfsServer"
              placeholder="192.168.1.1"
              value={data.mgmtNfsServer}
              onChange={(e) => update("mgmtNfsServer", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mgmtNfsPath">Export Path</Label>
            <Input
              id="mgmtNfsPath"
              placeholder="/mgmt"
              value={data.mgmtNfsPath}
              onChange={(e) => update("mgmtNfsPath", e.target.value)}
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="mb-3 font-medium">User Data NFS</h3>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="dataNfsServer">NFS Server</Label>
            <Input
              id="dataNfsServer"
              placeholder="192.168.1.1"
              value={data.dataNfsServer}
              onChange={(e) => update("dataNfsServer", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dataNfsPath">Export Path</Label>
            <Input
              id="dataNfsPath"
              placeholder="/aura-usrdata"
              value={data.dataNfsPath}
              onChange={(e) => update("dataNfsPath", e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="nfsAllowedNetwork">Allowed Network (CIDR)</Label>
        <Input
          id="nfsAllowedNetwork"
          placeholder="192.168.1.0/24"
          value={data.nfsAllowedNetwork}
          onChange={(e) => update("nfsAllowedNetwork", e.target.value)}
        />
      </div>
    </div>
  );
}
