"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const tabs = [
  { slug: "configuration", label: "Configuration", requiresActive: false },
  { slug: "ssh", label: "SSH", requiresActive: false },
  { slug: "nodes", label: "Nodes", requiresActive: true },
  { slug: "partitions", label: "Partitions", requiresActive: true },
  { slug: "storage", label: "Storages", requiresActive: true },
  { slug: "packages", label: "Packages", requiresActive: true },
  { slug: "python", label: "Python", requiresActive: true },
  { slug: "users", label: "Users", requiresActive: true },
];

interface ClusterTabsProps {
  clusterId: string;
  isActive: boolean;
}

export function ClusterTabs({ clusterId, isActive: clusterIsActive }: ClusterTabsProps) {
  const pathname = usePathname();
  const base = `/admin/clusters/${clusterId}`;

  return (
    <div className="flex gap-1 border-b">
      {tabs.map((tab) => {
        const href = `${base}/${tab.slug}`;
        const isActive = pathname === href || pathname.startsWith(href + "/");
        const disabled = tab.requiresActive && !clusterIsActive;

        if (disabled) {
          return (
            <span
              key={tab.slug}
              className="relative px-4 py-2 text-sm font-medium text-muted-foreground/40 cursor-not-allowed"
              title="Bootstrap the cluster first"
            >
              {tab.label}
            </span>
          );
        }

        return (
          <Link
            key={tab.slug}
            href={href}
            className={cn(
              "relative px-4 py-2 text-sm font-medium transition-colors rounded-t-md",
              isActive
                ? "text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
