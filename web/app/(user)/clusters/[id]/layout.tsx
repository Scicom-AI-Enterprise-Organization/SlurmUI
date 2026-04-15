"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Briefcase, FolderOpen, AppWindow, ShieldOff } from "lucide-react";

const tabs = [
  { label: "Jobs", href: "jobs", icon: Briefcase },
  { label: "Files", href: "files", icon: FolderOpen },
  { label: "Apps", href: "apps", icon: AppWindow },
];

export default function ClusterLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const [provisioned, setProvisioned] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(`/api/clusters/${id}/my-status`)
      .then((r) => r.json())
      .then((d) => setProvisioned(d.provisioned === true))
      .catch(() => setProvisioned(false));
  }, [id]);

  return (
    <div className="space-y-4">
      <nav className="flex gap-1 border-b border-border pb-0">
        {tabs.map((tab) => {
          const href = `/clusters/${id}/${tab.href}`;
          const isActive = pathname.startsWith(href);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={href}
              className={cn(
                "flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                isActive
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <div className="pt-1">
        {provisioned === false ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-16 text-center text-muted-foreground gap-3">
            <ShieldOff className="h-10 w-10 opacity-40" />
            <p className="text-base font-medium">No user provisioned in this cluster</p>
            <p className="text-sm">Contact your admin to get access.</p>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
