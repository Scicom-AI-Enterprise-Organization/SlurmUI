"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Briefcase, FolderOpen, AppWindow } from "lucide-react";

const tabs = [
  { label: "Jobs", href: "jobs", icon: Briefcase },
  { label: "Files", href: "files", icon: FolderOpen },
  { label: "Apps", href: "apps", icon: AppWindow },
];

export default function ClusterLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();

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
      <div className="pt-1">{children}</div>
    </div>
  );
}
