"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Server,
  Plus,
  Briefcase,
  PanelLeftOpen,
  PanelLeftClose,
  Settings,
  ScrollText,
  BookOpen,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarProps {
  // "USER" retained only for legacy session tokens predating the role
  // collapse — displayed as a regular non-admin sidebar.
  role: "ADMIN" | "VIEWER" | "USER";
}

type NavAction = { href: string; icon: React.ElementType; label: string };
type NavLink = { href: string; label: string; icon: React.ElementType; action?: NavAction };
type NavSection = { title?: string; links: NavLink[] };

const userSections: NavSection[] = [
  {
    links: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/jobs", label: "Jobs", icon: Briefcase },
      { href: "/explain", label: "Learn Slurm", icon: BookOpen },
    ],
  },
];

const adminSections: NavSection[] = [
  {
    links: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/jobs", label: "Jobs", icon: Briefcase },
      { href: "/admin/clusters", label: "Clusters", icon: Server, action: { href: "/admin/clusters/new", icon: Plus, label: "New Cluster" } },
      { href: "/admin/organization", label: "Organization", icon: Users },
      { href: "/admin/audit-log", label: "Audit Log", icon: ScrollText },
      { href: "/admin/settings", label: "Settings", icon: Settings },
      { href: "/explain", label: "Learn Slurm", icon: BookOpen },
    ],
  },
];

const EXPANDED_WIDTH = 256;
const COLLAPSED_WIDTH = 44;

export function Sidebar({ role }: SidebarProps) {
  const pathname = usePathname();
  const sections = role === "ADMIN" ? adminSections : userSections;

  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("sidebar-collapsed");
    if (saved !== null) setIsCollapsed(saved === "true");
  }, []);

  const toggleCollapsed = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  };

  return (
    <motion.aside
      animate={{ width: isCollapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
      transition={{ type: "spring", stiffness: 350, damping: 35, mass: 0.8 }}
      className="flex h-full flex-col border-r bg-sidebar overflow-hidden shrink-0"
    >
      {/* Header */}
      <div
        className={cn(
          "flex h-14 items-center border-b border-sidebar-border px-2",
          isCollapsed ? "justify-center" : "justify-between px-4"
        )}
      >
        {!isCollapsed && (
          <Link
            href="/dashboard"
            className="flex items-center gap-2 font-semibold text-sidebar-foreground"
          >
            <Briefcase className="h-5 w-5 text-sidebar-primary" />
            <span>SlurmUI</span>
          </Link>
        )}
        <button
          onClick={toggleCollapsed}
          title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex size-8 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
        >
          {isCollapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Nav */}
      <nav className="flex flex-1 flex-col overflow-y-auto p-2">
        <div className="space-y-4 flex-1">
        {sections.map((section, si) => (
          <div key={si} className="space-y-0.5">
            {section.title && !isCollapsed && (
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
                {section.title}
              </p>
            )}
            {section.links.map((link) => {
              const Icon = link.icon;
              const isActive =
                link.href === "/clusters"
                  ? pathname.startsWith("/clusters") && !pathname.startsWith("/clusters/") ||
                    pathname === "/clusters"
                  : pathname === link.href || pathname.startsWith(link.href + "/");
              return (
                <div key={link.href} className="flex items-center gap-0.5">
                  <Link
                    href={link.href}
                    title={isCollapsed ? link.label : undefined}
                    className={cn(
                      "flex flex-1 items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors",
                      isCollapsed ? "justify-center" : "",
                      isActive
                        ? "bg-sidebar-accent text-sidebar-primary font-semibold"
                        : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {!isCollapsed && (
                      <span className="whitespace-nowrap">{link.label}</span>
                    )}
                  </Link>
                  {link.action && !isCollapsed && (
                    <Link
                      href={link.action.href}
                      title={link.action.label}
                      className="flex w-8 self-stretch items-center justify-center rounded-md text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
                    >
                      <link.action.icon className="h-4 w-4" />
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        </div>

        {/* Footer — open-source pointer pinned to the bottom of the sidebar */}
        <div className="mt-2 pt-2 border-t border-sidebar-border">
          <a
            href="https://github.com/Scicom-AI-Enterprise-Organization/SlurmUI"
            target="_blank"
            rel="noreferrer"
            title={isCollapsed ? "SlurmUI on GitHub" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
              isCollapsed && "justify-center",
            )}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 shrink-0 fill-current">
              <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.92.58.11.79-.25.79-.56 0-.27-.01-1.18-.02-2.13-3.2.7-3.88-1.36-3.88-1.36-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.27.73-1.56-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.9-.39.99 0 1.98.13 2.9.39 2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/>
            </svg>
            {!isCollapsed && <span className="whitespace-nowrap">GitHub</span>}
          </a>
        </div>
      </nav>
    </motion.aside>
  );
}
