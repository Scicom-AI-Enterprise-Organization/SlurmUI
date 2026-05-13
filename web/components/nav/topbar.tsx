"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Menu } from "lucide-react";
import { UserMenu } from "./user-menu";
import { useSidebarState } from "./sidebar-state";

export type Crumb = { label: string; href?: string };

const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/jobs": "Jobs",
  "/explain": "Learn Slurm",
  "/profile": "Profile",
  "/profile/api-tokens": "API tokens",
  "/api-docs": "API docs",
  "/admin/clusters": "Clusters",
  "/admin/clusters/new": "New cluster",
  "/admin/organization": "Organization",
  "/admin/audit-log": "Audit log",
  "/admin/settings": "Settings",
};

function deriveCrumbs(pathname: string): Crumb[] {
  const exact = TITLES[pathname];
  if (exact) return [{ label: exact }];

  // Fall back to last segment, prettified
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [];
  const last = segments[segments.length - 1];
  const label = last
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
  return [{ label }];
}

export function Topbar({ crumbs }: { crumbs?: Crumb[] }) {
  const { togglePanel } = useSidebarState();
  const pathname = usePathname();
  const items = crumbs ?? deriveCrumbs(pathname);
  const lastCrumb = items[items.length - 1];

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-sidebar px-3 lg:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={togglePanel}
          className="inline-flex shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
          aria-label="Toggle sidebar"
        >
          <Menu className="h-4 w-4" />
        </button>
        <nav className="ml-2 hidden min-w-0 items-center gap-1 text-sm md:flex">
          {items.map((c, i) => (
            <span key={i} className="flex items-center gap-1 truncate text-muted-foreground">
              {i > 0 && <ChevronRight className="h-3.5 w-3.5" />}
              {c.href ? (
                <Link href={c.href} className="truncate hover:text-foreground">
                  {c.label}
                </Link>
              ) : (
                <span className="truncate text-foreground">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
        {lastCrumb && (
          <span className="ml-1 truncate text-sm text-foreground md:hidden">
            {lastCrumb.label}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <UserMenu />
      </div>
    </header>
  );
}
