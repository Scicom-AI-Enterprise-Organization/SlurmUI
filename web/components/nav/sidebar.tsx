"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Server,
  Plus,
  Monitor,
  Briefcase,
  Settings,
  PanelLeftOpen,
  PanelLeftClose,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarProps {
  role: "ADMIN" | "USER";
}

const adminLinks = [
  { href: "/admin/clusters", label: "Clusters", icon: Server },
  { href: "/admin/clusters/new", label: "New Cluster", icon: Plus },
];

const userLinks = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/clusters", label: "Clusters", icon: Monitor },
];

const EXPANDED_WIDTH = 256;
const COLLAPSED_WIDTH = 44;

export function Sidebar({ role }: SidebarProps) {
  const pathname = usePathname();
  const links = role === "ADMIN" ? [...adminLinks, ...userLinks] : userLinks;

  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("sidebar-collapsed");
    if (saved !== null) {
      setIsCollapsed(saved === "true");
    }
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
      {/* Header: logo + collapse toggle */}
      <div
        className={cn(
          "flex h-14 items-center border-b border-sidebar-border px-2",
          isCollapsed ? "justify-center" : "justify-between px-4"
        )}
      >
        {!isCollapsed && (
          <Link
            href="/"
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

      {/* Nav links */}
      <nav className="flex-1 space-y-0.5 p-2">
        {links.map((link) => {
          const Icon = link.icon;
          const isActive = pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              title={isCollapsed ? link.label : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors",
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
          );
        })}
      </nav>

      {/* Bottom: settings */}
      <div className="border-t border-sidebar-border p-2">
        <button
          title={isCollapsed ? "Settings" : undefined}
          className={cn(
            "flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors",
            isCollapsed ? "justify-center" : ""
          )}
        >
          <Settings className="h-4 w-4 shrink-0" />
          {!isCollapsed && <span className="whitespace-nowrap">Settings</span>}
        </button>
      </div>
    </motion.aside>
  );
}
