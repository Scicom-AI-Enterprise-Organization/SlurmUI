"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Terminal as TerminalIcon } from "lucide-react";
import { ClusterShellPane } from "@/components/cluster/cluster-shell-pane";

interface TerminalButtonProps {
  clusterId: string;
}

export function TerminalButton({ clusterId }: TerminalButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <TerminalIcon className="mr-2 h-4 w-4" />
        Terminal
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Cluster Terminal</DialogTitle>
          </DialogHeader>
          {open && <ClusterShellPane clusterId={clusterId} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
