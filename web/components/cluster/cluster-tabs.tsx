"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const tabs = [
  { slug: "configuration", label: "Configuration", requiresNodes: false },
  { slug: "ssh", label: "SSH", requiresNodes: false },
  { slug: "nodes", label: "Nodes", requiresNodes: false },
  { slug: "storage", label: "Storage", requiresNodes: true },
  { slug: "users", label: "Users", requiresNodes: true },
  { slug: "packages", label: "Packages", requiresNodes: true },
];

interface ClusterTabsProps {
  clusterId: string;
  hasNodes: boolean;
}

export function ClusterTabs({ clusterId, hasNodes }: ClusterTabsProps) {
  const pathname = usePathname();
  const base = `/admin/clusters/${clusterId}`;

  return (
    <div className="flex gap-1 border-b">
      {tabs.map((tab) => {
        const href = `${base}/${tab.slug}`;
        const isActive = pathname === href || pathname.startsWith(href + "/");
        const disabled = tab.requiresNodes && !hasNodes;

        if (disabled) {
          return (
            <span
              key={tab.slug}
              className="relative px-4 py-2 text-sm font-medium text-muted-foreground/40 cursor-not-allowed"
              title="Add nodes first"
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
