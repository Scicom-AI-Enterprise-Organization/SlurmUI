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
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarProps {
  role: "ADMIN" | "USER";
}

type NavAction = { href: string; icon: React.ElementType; label: string };
type NavLink = { href: string; label: string; icon: React.ElementType; action?: NavAction };
type NavSection = { title?: string; links: NavLink[] };

const userSections: NavSection[] = [
  {
    links: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/jobs", label: "Jobs", icon: Briefcase },
    ],
  },
];

const adminSections: NavSection[] = [
  {
    links: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/jobs", label: "Jobs", icon: Briefcase },
      { href: "/admin/clusters", label: "Clusters", icon: Server, action: { href: "/admin/clusters/new", icon: Plus, label: "New Cluster" } },
      { href: "/admin/audit-log", label: "Audit Log", icon: ScrollText },
      { href: "/admin/settings", label: "Settings", icon: Settings },
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
            <span>Aura</span>
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
      <nav className="flex-1 overflow-y-auto p-2 space-y-4">
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
      </nav>
    </motion.aside>
  );
}
