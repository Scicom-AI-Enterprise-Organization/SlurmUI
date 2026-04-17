"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Key, GitBranch, Bell } from "lucide-react";

const sections = [
  { href: "/admin/settings/ssh-keys", label: "SSH Keys", icon: Key },
  { href: "/admin/settings/alerts", label: "Alerts", icon: Bell },
  { href: "/admin/settings/git-sync", label: "Git Sync", icon: GitBranch },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">Global admin configuration</p>
      </div>

      <div className="grid gap-6 md:grid-cols-[200px_1fr]">
        {/* Sub sidebar */}
        <nav className="space-y-1 self-start sticky top-4">
          {sections.map((s) => {
            const Icon = s.icon;
            const active = pathname === s.href || pathname.startsWith(s.href + "/");
            return (
              <Link
                key={s.href}
                href={s.href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-muted text-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {s.label}
              </Link>
            );
          })}
        </nav>

        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
