"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Trash2 } from "lucide-react";

interface DeleteClusterButtonProps {
  clusterId: string;
  clusterName: string;
}

export function DeleteClusterButton({ clusterId, clusterName }: DeleteClusterButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}`, { method: "DELETE" });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Delete failed" }));
        alert(error);
        return;
      }
      setOpen(false);
      router.push("/admin/clusters");
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={
        <Button variant="destructive" size="sm">
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </Button>
      } />
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete "{clusterName}"?</DialogTitle>
          <DialogDescription>
            This will permanently delete the cluster and all associated jobs. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={deleting}>Cancel</Button>} />
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete cluster"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
