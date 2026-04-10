# Aura Web UI Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revamp Aura Web's UI layer to match the enterprise template — Tailwind v4, OKLch design tokens, collapsible icon sidebar, dark-first theme, dual-mode accent (indigo light / amber dark), Framer Motion sidebar animation.

**Architecture:** Upgrade Tailwind CSS v3 → v4 (postcss plugin swap, delete tailwind.config.ts, new globals.css). Replace shadcn primitive components with enterprise template versions (data-slot pattern, CVA). Rebuild the sidebar as a collapsible 44px ↔ 256px strip using Framer Motion. Add a useThemeMode hook and a theme toggle in the user menu. Only UI layer files change — all API routes, lib/, prisma, middleware, and docker files are untouched.

**Tech Stack:** Next.js 14, React 18, Tailwind CSS v4, tw-animate-css, framer-motion v12, @radix-ui/react-avatar, @radix-ui/react-dropdown-menu, @radix-ui/react-slot, @radix-ui/react-tabs

---

## File Map

**Modified:**
- `web/package.json` — upgrade tailwindcss, add new packages
- `web/postcss.config.mjs` — swap to @tailwindcss/postcss
- `web/app/globals.css` — full replacement with v4 syntax + OKLch tokens
- `web/app/layout.tsx` — add suppressHydrationWarning + dark default script
- `web/app/(user)/layout.tsx` — use new AppShell, remove inline header
- `web/components/nav/sidebar.tsx` — full rebuild with Framer Motion collapsible
- `web/components/nav/user-menu.tsx` — add theme toggle + avatar dropdown
- `web/components/ui/button.tsx` — enterprise template version
- `web/components/ui/badge.tsx` — enterprise template version
- `web/components/ui/card.tsx` — enterprise template version
- `web/components/ui/input.tsx` — enterprise template version
- `web/components/ui/label.tsx` — enterprise template version
- `web/components/ui/textarea.tsx` — enterprise template version
- `web/components/ui/tabs.tsx` — enterprise template version

**Created:**
- `web/hooks/use-theme-mode.ts` — theme hook from enterprise template
- `web/components/ui/avatar.tsx` — new component from enterprise template
- `web/components/ui/dropdown-menu.tsx` — new component from enterprise template
- `web/app/(admin)/layout.tsx` — admin route group layout (currently missing)

**Deleted:**
- `web/tailwind.config.ts` — not needed in Tailwind v4

**Untouched (do not modify):**
- `web/app/api/` — all API routes
- `web/lib/` — auth, nats, prisma, freeipa, bootstrap, ws, heartbeat
- `web/middleware.ts`
- `web/prisma/`
- `web/server.ts`
- `web/docker-compose.yml`, `web/Dockerfile`
- `web/components/ui/dialog.tsx` — uses @base-ui/react, keep as-is
- `web/components/ui/select.tsx` — uses @base-ui/react, keep as-is
- `web/components/ui/scroll-area.tsx`, `separator.tsx`, `table.tsx`, `sonner.tsx`, `toaster.tsx` — keep as-is

---

## Task 1: Upgrade Dependencies

**Files:**
- Modify: `web/package.json`
- Modify: `web/postcss.config.mjs`
- Delete: `web/tailwind.config.ts`

- [ ] **Step 1: Update postcss.config.mjs to use Tailwind v4 plugin**

Replace the entire file content at `web/postcss.config.mjs`:

```js
/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

- [ ] **Step 2: Update package.json — upgrade tailwindcss and add new packages**

In `web/package.json`, make these changes to the `dependencies` block — add the new packages and update tailwindcss:

```json
{
  "dependencies": {
    "@auth/prisma-adapter": "^2.11.1",
    "@base-ui/react": "^1.3.0",
    "@prisma/client": "^5.22.0",
    "@radix-ui/react-avatar": "^1.1.3",
    "@radix-ui/react-dropdown-menu": "^2.1.6",
    "@radix-ui/react-slot": "^1.1.2",
    "@radix-ui/react-tabs": "^1.1.3",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "framer-motion": "^12.0.0",
    "lucide-react": "^1.7.0",
    "nats": "^2.29.3",
    "next": "^14.2.0",
    "next-auth": "^5.0.0-beta.30",
    "next-themes": "^0.4.6",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "shadcn": "^4.1.2",
    "sonner": "^2.0.7",
    "tailwind-merge": "^3.5.0",
    "tsx": "^4.21.0",
    "tw-animate-css": "^1.4.0",
    "ws": "^8.20.0"
  }
}
```

In `devDependencies`, upgrade tailwindcss and add the postcss plugin:

```json
{
  "devDependencies": {
    "@tailwindcss/postcss": "^4.0.0",
    "@types/node": "^20",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "@types/ws": "^8.18.1",
    "autoprefixer": "^10.4.27",
    "eslint": "^8",
    "eslint-config-next": "^14.2.0",
    "postcss": "^8",
    "prisma": "^5.22.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5"
  }
}
```

- [ ] **Step 3: Delete tailwind.config.ts (not used in Tailwind v4)**

```bash
rm web/tailwind.config.ts
```

- [ ] **Step 4: Install dependencies**

```bash
cd web && npm install
```

Expected: packages install without error. There will be a peer dep warning about framer-motion and React 18 vs 19 — this is safe to ignore.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/postcss.config.mjs
git rm web/tailwind.config.ts
git commit -m "chore(web): upgrade Tailwind to v4, add framer-motion and radix packages"
```

---

## Task 2: Replace globals.css with Enterprise Design Tokens

**Files:**
- Modify: `web/app/globals.css`

- [ ] **Step 1: Replace globals.css with the enterprise template's design token system**

Completely replace `web/app/globals.css` with:

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --background: oklch(0.9670 0.0029 264.5419);
  --foreground: oklch(0.2103 0.0059 285.8852);
  --card: oklch(0.9846 0.0017 247.8389);
  --card-foreground: oklch(0.3211 0 0);
  --popover: oklch(1.0000 0 0);
  --popover-foreground: oklch(0.3211 0 0);
  --primary: oklch(0.6231 0.1880 259.8145);
  --primary-foreground: oklch(0.9846 0.0017 247.8389);
  --secondary: oklch(0.5461 0.2152 262.8809);
  --secondary-foreground: oklch(0.9846 0.0017 247.8389);
  --muted: oklch(0.9846 0.0017 247.8389);
  --muted-foreground: oklch(0.5510 0.0234 264.3637);
  --accent: oklch(0.9276 0.0058 264.5313);
  --accent-foreground: oklch(0.2103 0.0059 285.8852);
  --destructive: oklch(0.6368 0.2078 25.3313);
  --destructive-foreground: oklch(1.0000 0 0);
  --border: oklch(0.9276 0.0058 264.5313);
  --input: oklch(0.9276 0.0058 264.5313);
  --ring: oklch(0.5461 0.2152 262.8809);
  --chart-1: oklch(0.8726 0.0619 265.9564);
  --chart-2: oklch(0.6824 0.1668 263.9786);
  --chart-3: oklch(0.5461 0.2152 262.8809);
  --chart-4: oklch(0.4244 0.1809 265.6377);
  --chart-5: oklch(0.2823 0.0874 267.9352);
  --sidebar: oklch(0.9846 0.0017 247.8389);
  --sidebar-foreground: oklch(0.3211 0 0);
  --sidebar-primary: oklch(0.6231 0.1880 259.8145);
  --sidebar-primary-foreground: oklch(1.0000 0 0);
  --sidebar-accent: oklch(0.9276 0.0058 264.5313);
  --sidebar-accent-foreground: oklch(0.4244 0.1809 265.6377);
  --sidebar-border: oklch(0.9276 0.0058 264.5313);
  --sidebar-ring: oklch(0.5461 0.2152 262.8809);
  --font-sans: Inter, sans-serif;
  --font-mono: JetBrains Mono, monospace;
  --radius: 0.375rem;
  --shadow-2xs: 0 1px 3px 0px hsl(210 20% 98% / 0.05);
  --shadow-xs: 0 1px 3px 0px hsl(210 20% 98% / 0.05);
  --shadow-sm: 0 1px 3px 0px hsl(210 20% 98% / 0.10), 0 1px 2px -1px hsl(210 20% 98% / 0.10);
  --shadow: 0 1px 3px 0px hsl(210 20% 98% / 0.10), 0 1px 2px -1px hsl(210 20% 98% / 0.10);
  --shadow-md: 0 1px 3px 0px hsl(210 20% 98% / 0.10), 0 2px 4px -1px hsl(210 20% 98% / 0.10);
  --shadow-lg: 0 1px 3px 0px hsl(210 20% 98% / 0.10), 0 4px 6px -1px hsl(210 20% 98% / 0.10);
  --shadow-xl: 0 1px 3px 0px hsl(210 20% 98% / 0.10), 0 8px 10px -1px hsl(210 20% 98% / 0.10);
  --shadow-2xl: 0 1px 3px 0px hsl(210 20% 98% / 0.25);
}

.dark {
  --background: oklch(0.2046 0 0);
  --foreground: oklch(0.9219 0 0);
  --card: oklch(0.2686 0 0);
  --card-foreground: oklch(0.9219 0 0);
  --popover: oklch(0.2686 0 0);
  --popover-foreground: oklch(0.9219 0 0);
  --primary: oklch(0.6957 0.1867 48.9622);
  --primary-foreground: oklch(1.0000 0 0);
  --secondary: oklch(0.7486 0.1613 44.8682);
  --secondary-foreground: oklch(1.0000 0 0);
  --muted: oklch(0.2393 0 0);
  --muted-foreground: oklch(0.7155 0 0);
  --accent: oklch(0.4386 0 0);
  --accent-foreground: oklch(0.9219 0 0);
  --destructive: oklch(0.7106 0.1661 22.2162);
  --destructive-foreground: oklch(1.0000 0 0);
  --border: oklch(0.3715 0 0);
  --input: oklch(0.4386 0 0);
  --ring: oklch(0.7486 0.1613 44.8682);
  --chart-1: oklch(0.8456 0.0869 37.3783);
  --chart-2: oklch(0.7486 0.1613 44.8682);
  --chart-3: oklch(0.5565 0.1495 48.9078);
  --chart-4: oklch(0.2824 0.0760 48.7446);
  --chart-5: oklch(0.2133 0.0571 49.0990);
  --sidebar: oklch(0.2686 0 0);
  --sidebar-foreground: oklch(0.9219 0 0);
  --sidebar-primary: oklch(0.7486 0.1613 44.8682);
  --sidebar-primary-foreground: oklch(1.0000 0 0);
  --sidebar-accent: oklch(0.3715 0 0);
  --sidebar-accent-foreground: oklch(0.9752 0.0122 29.8685);
  --sidebar-border: oklch(0.3715 0 0);
  --sidebar-ring: oklch(0.9016 0.0520 34.3546);
  --font-sans: Inter, sans-serif;
  --font-mono: JetBrains Mono, monospace;
  --radius: 0.375rem;
  --shadow-color: oklch(0 0 0);
  --shadow-2xs: 0 1px 3px 0px hsl(0 0% 0% / 0.05);
  --shadow-xs: 0 1px 3px 0px hsl(0 0% 0% / 0.05);
  --shadow-sm: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 1px 2px -1px hsl(0 0% 0% / 0.10);
  --shadow: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 1px 2px -1px hsl(0 0% 0% / 0.10);
  --shadow-md: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 2px 4px -1px hsl(0 0% 0% / 0.10);
  --shadow-lg: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 4px 6px -1px hsl(0 0% 0% / 0.10);
  --shadow-xl: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 8px 10px -1px hsl(0 0% 0% / 0.10);
  --shadow-2xl: 0 1px 3px 0px hsl(0 0% 0% / 0.25);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --shadow-2xs: var(--shadow-2xs);
  --shadow-xs: var(--shadow-xs);
  --shadow-sm: var(--shadow-sm);
  --shadow: var(--shadow);
  --shadow-md: var(--shadow-md);
  --shadow-lg: var(--shadow-lg);
  --shadow-xl: var(--shadow-xl);
  --shadow-2xl: var(--shadow-2xl);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}

/* Collapsible animations */
@keyframes collapsible-down {
  from { height: 0; opacity: 0; }
  to { height: var(--radix-collapsible-content-height); opacity: 1; }
}
@keyframes collapsible-up {
  from { height: var(--radix-collapsible-content-height); opacity: 1; }
  to { height: 0; opacity: 0; }
}
[data-slot="collapsible-content"][data-state="open"] {
  animation: collapsible-down 200ms ease-out;
}
[data-slot="collapsible-content"][data-state="closed"] {
  animation: collapsible-up 200ms ease-out;
}
```

- [ ] **Step 2: Attempt a dev build to confirm CSS parses correctly**

```bash
cd web && npm run build 2>&1 | head -50
```

Expected: Build may have type errors from later tasks, but should NOT have CSS parse errors. If you see "Unknown at rule @custom-variant" that means the postcss upgrade from Task 1 didn't apply — re-run `npm install`.

- [ ] **Step 3: Commit**

```bash
git add web/app/globals.css
git commit -m "feat(web): replace globals.css with enterprise template OKLch design tokens (Tailwind v4)"
```

---

## Task 3: Add useThemeMode Hook

**Files:**
- Create: `web/hooks/use-theme-mode.ts`

- [ ] **Step 1: Create the hooks directory and useThemeMode hook**

Create `web/hooks/use-theme-mode.ts`:

```ts
"use client";

import { useState, useEffect } from "react";

/**
 * Hook to manage dark/light mode state.
 * Syncs with document.documentElement.classList ("dark") and persists to localStorage.
 */
export function useThemeMode() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    // On mount: check saved preference, then system preference
    const saved = localStorage.getItem("theme");
    const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

    if (saved === "dark" || (!saved && systemPrefersDark)) {
      setIsDark(true);
      document.documentElement.classList.add("dark");
    } else {
      setIsDark(false);
      document.documentElement.classList.remove("dark");
    }
  }, []);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [isDark]);

  const toggleTheme = () => setIsDark((prev) => !prev);

  return { isDark, setIsDark, toggleTheme };
}
```

- [ ] **Step 2: Commit**

```bash
git add web/hooks/use-theme-mode.ts
git commit -m "feat(web): add useThemeMode hook for dark/light toggle with localStorage persistence"
```

---

## Task 4: Replace UI Primitive Components with Enterprise Template Versions

**Files:**
- Modify: `web/components/ui/button.tsx`
- Modify: `web/components/ui/badge.tsx`
- Modify: `web/components/ui/card.tsx`
- Modify: `web/components/ui/input.tsx`
- Modify: `web/components/ui/label.tsx`
- Modify: `web/components/ui/textarea.tsx`
- Modify: `web/components/ui/tabs.tsx`
- Create: `web/components/ui/avatar.tsx`
- Create: `web/components/ui/dropdown-menu.tsx`

**Note:** Do NOT modify dialog.tsx (uses @base-ui/react), select.tsx (uses @base-ui/react), scroll-area.tsx, separator.tsx, table.tsx, sonner.tsx, or toaster.tsx.

- [ ] **Step 1: Replace button.tsx**

Replace the entire content of `web/components/ui/button.tsx`:

```tsx
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
```

- [ ] **Step 2: Replace badge.tsx**

Replace the entire content of `web/components/ui/badge.tsx`:

```tsx
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border border-transparent px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
```

- [ ] **Step 3: Replace card.tsx**

Replace the entire content of `web/components/ui/card.tsx`:

```tsx
import * as React from "react"

import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
```

- [ ] **Step 4: Replace input.tsx**

Replace the entire content of `web/components/ui/input.tsx`:

```tsx
import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
```

- [ ] **Step 5: Replace label.tsx**

Replace the entire content of `web/components/ui/label.tsx`:

```tsx
import * as React from "react"

import { cn } from "@/lib/utils"

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm font-medium leading-none select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
```

- [ ] **Step 6: Replace textarea.tsx**

Replace the entire content of `web/components/ui/textarea.tsx`:

```tsx
import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex min-h-[60px] w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
```

- [ ] **Step 7: Replace tabs.tsx**

Replace the entire content of `web/components/ui/tabs.tsx`:

```tsx
"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "rounded-lg p-[3px] group-data-[orientation=horizontal]/tabs:h-9 data-[variant=line]:rounded-none group/tabs-list text-muted-foreground inline-flex w-fit items-center justify-center group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "data-[state=active]:bg-background dark:data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 data-[state=active]:text-foreground",
        "after:bg-foreground after:absolute after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
```

- [ ] **Step 8: Create avatar.tsx**

Create `web/components/ui/avatar.tsx`:

```tsx
"use client"

import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

import { cn } from "@/lib/utils"

function Avatar({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: "default" | "sm" | "lg"
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "group/avatar relative flex size-8 shrink-0 overflow-hidden rounded-full select-none data-[size=lg]:size-10 data-[size=sm]:size-6",
        className
      )}
      {...props}
    />
  )
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full", className)}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "bg-muted text-muted-foreground flex size-full items-center justify-center rounded-full text-sm group-data-[size=sm]/avatar:text-xs",
        className
      )}
      {...props}
    />
  )
}

export { Avatar, AvatarImage, AvatarFallback }
```

- [ ] **Step 9: Create dropdown-menu.tsx**

Create `web/components/ui/dropdown-menu.tsx`:

```tsx
"use client"

import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  )
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md",
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1.5 text-sm font-medium data-[inset]:pl-8",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
}
```

- [ ] **Step 10: Commit all UI component changes**

```bash
git add web/components/ui/
git commit -m "feat(web): replace UI primitives with enterprise template versions (data-slot, CVA)"
```

---

## Task 5: Rebuild the Collapsible Sidebar with Framer Motion

**Files:**
- Modify: `web/components/nav/sidebar.tsx`

- [ ] **Step 1: Rewrite sidebar.tsx as a collapsible 44px ↔ 256px strip**

Replace the entire content of `web/components/nav/sidebar.tsx`:

```tsx
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
```

- [ ] **Step 2: Commit**

```bash
git add web/components/nav/sidebar.tsx
git commit -m "feat(web): collapsible icon sidebar with Framer Motion (44px collapsed / 256px expanded)"
```

---

## Task 6: Update UserMenu with Theme Toggle and Avatar Dropdown

**Files:**
- Modify: `web/components/nav/user-menu.tsx`

- [ ] **Step 1: Rewrite user-menu.tsx to include theme toggle and avatar dropdown**

Replace the entire content of `web/components/nav/user-menu.tsx`:

```tsx
"use client";

import { signOut, useSession } from "next-auth/react";
import { Sun, Moon, LogOut, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useThemeMode } from "@/hooks/use-theme-mode";

export function UserMenu() {
  const { data: session } = useSession();
  const { isDark, toggleTheme } = useThemeMode();

  if (!session?.user) return null;

  const name = session.user.name ?? session.user.email ?? "User";
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="flex items-center gap-2">
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        title={isDark ? "Switch to light mode" : "Switch to dark mode"}
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>

      {/* Avatar dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar size="default">
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>
            <div className="flex flex-col">
              <span className="text-sm font-medium">{name}</span>
              {session.user.email && (
                <span className="text-xs text-muted-foreground">
                  {session.user.email}
                </span>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem>
              <User className="h-4 w-4" />
              Profile
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => signOut()}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/nav/user-menu.tsx
git commit -m "feat(web): user menu with theme toggle and avatar dropdown"
```

---

## Task 7: Update Layouts for Dark Default and App Shell

**Files:**
- Modify: `web/app/layout.tsx`
- Modify: `web/app/(user)/layout.tsx`
- Create: `web/app/(admin)/layout.tsx`

- [ ] **Step 1: Update root layout — add suppressHydrationWarning and dark-default inline script**

Replace the entire content of `web/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { SessionProvider } from "@/components/providers/session-provider";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Aura - Cluster Management",
  description: "Scicom Aura GPU Cluster Management Platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply dark class before first paint to prevent flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var saved = localStorage.getItem('theme');
                var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                if (saved === 'dark' || (!saved && prefersDark) || (!saved && !prefersDark)) {
                  // Default to dark when no preference saved
                  if (!saved) localStorage.setItem('theme', 'dark');
                  document.documentElement.classList.add('dark');
                }
              } catch(e) {}
            `,
          }}
        />
      </head>
      <body className={inter.className}>
        <SessionProvider>
          {children}
          <Toaster />
        </SessionProvider>
      </body>
    </html>
  );
}
```

**Note on the inline script logic:** When `saved` is null (first visit), we default to dark mode and save "dark" to localStorage. Subsequent visits follow the saved preference. `suppressHydrationWarning` on `<html>` prevents React from warning about the class mismatch between SSR (no `.dark`) and CSR (`.dark` added by the script).

- [ ] **Step 2: Update (user)/layout.tsx — remove inline header, use single flex row**

Replace the entire content of `web/app/(user)/layout.tsx`:

```tsx
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/nav/sidebar";
import { UserMenu } from "@/components/nav/user-menu";

export default async function UserLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/api/auth/signin");
  }

  return (
    <div className="flex h-screen bg-background">
      <Sidebar role={(session.user as any).role} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-end border-b border-border px-6">
          <UserMenu />
        </header>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create (admin)/layout.tsx**

Create `web/app/(admin)/layout.tsx`:

```tsx
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/nav/sidebar";
import { UserMenu } from "@/components/nav/user-menu";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/api/auth/signin");
  }

  // Middleware already blocks non-admin users from /admin/* routes.
  // This layout renders the same shell for admin pages.
  return (
    <div className="flex h-screen bg-background">
      <Sidebar role={(session.user as any).role} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-end border-b border-border px-6">
          <UserMenu />
        </header>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add web/app/layout.tsx web/app/(user)/layout.tsx web/app/(admin)/layout.tsx
git commit -m "feat(web): dark-first root layout, app shell layouts for admin and user route groups"
```

---

## Task 8: Build Verification

**Files:** None changed — verification only.

- [ ] **Step 1: Run full Next.js build**

```bash
cd web && npm run build 2>&1
```

Expected output ending with:
```
Route (app)                              Size     First Load JS
...
✓ Compiled successfully
```

If you see TypeScript errors:

- **"Property 'role' does not exist on type 'User'"** — this is expected from the NextAuth session type. Cast with `(session.user as any).role` (already done in layouts above).
- **"Module not found: @radix-ui/react-tabs"** — run `npm install @radix-ui/react-tabs` then rebuild.
- **"Module not found: @radix-ui/react-avatar"** or `@radix-ui/react-dropdown-menu` — run `npm install` again in `web/`.
- **"Cannot find module 'framer-motion'"** — run `cd web && npm install framer-motion`.

- [ ] **Step 2: Start dev server and visually verify**

```bash
cd web && npm run dev
```

Open `http://localhost:3000`. Verify:
1. Page opens in **dark mode** (dark background, amber/orange accent on buttons)
2. Sidebar is collapsed to **44px** icon strip on first visit (no localStorage)
3. Clicking the panel-left-open icon **expands** sidebar to 256px with labels
4. Sidebar animates smoothly (spring animation from Framer Motion)
5. Clicking the **sun/moon** icon in the top-right toggles light/dark mode
6. In **light mode**, primary buttons and active nav items show **indigo/blue**
7. The cluster cards use the new **Card** component with rounded-xl styling
8. Existing pages (clusters list, cluster detail, nodes, jobs) still render without errors

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat(web): complete UI revamp — enterprise template design language, collapsible sidebar, dark-first theme"
```
