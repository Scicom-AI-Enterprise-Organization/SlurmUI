# Aura Web UI Revamp — Design Spec

**Date:** 2026-04-10
**Status:** Approved
**Scope:** UI layer only — no changes to API routes, lib/, Prisma, auth, NATS, or middleware

---

## Overview

Replace the current Aura Web UI (Tailwind v3, plain shadcn components, ad-hoc layout) with the visual language of the enterprise template: Tailwind v4 OKLch CSS vars, collapsible icon sidebar, dark-first theme, dual-mode accent, and Framer Motion micro-animations.

All functional code stays untouched. Only the presentation layer changes.

---

## Design Decisions

### Layout: Collapsible Icon Sidebar

- **Collapsed state:** 44px icon strip (logo + nav icons + settings icon)
- **Expanded state:** 256px full sidebar (logo + labeled nav items + section headers)
- **Toggle:** click the logo/hamburger icon; state persisted in localStorage
- **Pattern:** VS Code / Linear sidebar style
- No top navigation bar (top-right user menu replaces it inline in the content header)

### Default Theme: Dark

- App opens dark by default unless the user has a saved `localStorage` preference
- System `prefers-color-scheme` overrides the hard default if no saved preference exists
- Users can toggle light/dark via a button in the top-right of every page

### Accent Color: Dual-Mode (Enterprise Template Default)

- **Light mode:** Indigo / Violet — `oklch(0.6231 0.1880 259.8145)`
- **Dark mode:** Amber / Orange — `oklch(0.6957 0.1867 48.9622)`
- Exactly as the enterprise template ships; no custom overrides

---

## Architecture

### What Changes

| Layer | Files | Change |
|---|---|---|
| CSS / Design tokens | `web/app/globals.css` | Replace with enterprise template's `globals.css` (OKLch vars, @theme inline, sidebar tokens) |
| Tailwind config | `web/tailwind.config.ts` → deleted, `web/postcss.config.mjs` | Upgrade to Tailwind v4 — no config file needed, PostCSS uses `@tailwindcss/postcss` |
| UI primitives | `web/components/ui/` | Replace all shadcn primitives with enterprise template versions (data-slot attrs, CVA, Framer Motion) |
| Navigation | `web/components/nav/` (new) | New collapsible sidebar component + top-right user menu component |
| Theme hook | `web/hooks/use-theme-mode.ts` (new) | Copied from enterprise template |
| Root layout | `web/app/layout.tsx` | Wrap with sidebar shell, apply dark default, add ThemeProvider if needed |
| Sub-layouts | `web/app/(admin)/layout.tsx`, `web/app/(user)/layout.tsx` | Use new AppShell with collapsible sidebar |
| Package deps | `web/package.json` | Add framer-motion, tw-animate-css; upgrade tailwindcss to v4 |

### What Does NOT Change

- `web/app/api/` — all API routes
- `web/lib/` — auth, nats, prisma, freeipa, bootstrap, ws, heartbeat
- `web/middleware.ts`
- `web/prisma/`
- `web/server.ts`
- `web/docker-compose.yml`, `web/Dockerfile`
- `web/app/(admin)/clusters/`, `web/(admin)/nodes/`, `web/(user)/` — page content components (only their wrapping layouts change)

---

## Component Design

### Collapsible Sidebar (`components/nav/sidebar.tsx`)

```
State: collapsed (44px) | expanded (256px)
- Logo block (top): always visible, click = toggle
- Nav items: icon-only when collapsed, icon + label when expanded
- Section dividers: hidden when collapsed
- Bottom: settings icon (always visible)
- Framer Motion: layout animation on width change (spring, duration 0.2s)
- Persistence: localStorage key "sidebar-collapsed"
```

Nav items (admin role):
- Clusters (⬡ icon)
- Nodes (⊞ icon)

Nav items (user role):
- Dashboard (⊞ icon)
- Jobs (☰ icon)

Settings (bottom, all roles):
- Settings (⚙ icon)

### Top-Right User Menu (`components/nav/user-menu.tsx`)

```
- Theme toggle button (sun/moon icon)
- Avatar with dropdown: profile info, sign out
- Position: top-right of each page's content area header
```

### App Shell (`components/nav/app-shell.tsx`)

```
- Outer: flex row, full height
- Left: <Sidebar />
- Right: flex column, flex-1
  - Page content (children)
```

---

## Tailwind v4 Migration Notes

- Remove `web/tailwind.config.ts` (v4 doesn't use a JS/TS config file)
- Update `web/postcss.config.mjs`: replace `tailwindcss: {}` with `"@tailwindcss/postcss": {}`
- Replace `web/app/globals.css` with v4 syntax:
  - `@import "tailwindcss"` (not `@tailwind base/components/utilities`)
  - `@import "tw-animate-css"`
  - `@custom-variant dark (&:is(.dark *))`
  - All OKLch CSS vars in `:root` and `.dark`
  - `@theme inline {}` block
- All existing Tailwind utility classes (`bg-`, `text-`, `border-`) remain valid — v4 is utility-compatible
- shadcn component imports stay the same (only their implementations change)

---

## Dependencies

Add to `web/package.json`:

```json
"framer-motion": "^12.0.0",
"tw-animate-css": "^1.0.0",
"@tailwindcss/postcss": "^4.0.0",
"tailwindcss": "^4.0.0"
```

Remove or update:
```json
"tailwindcss": "^3.x"  →  "^4.0.0"
```

Keep (no change):
- `next-themes` is NOT needed — we use the `useThemeMode` hook pattern from the enterprise template (direct classList + localStorage)
- All existing `@radix-ui/*` packages stay

---

## Dark Mode Strategy

The enterprise template uses a class-based dark mode strategy with a custom CSS variant:

```css
@custom-variant dark (&:is(.dark *));
```

This means: the `.dark` class on `<html>` enables dark mode. The `useThemeMode` hook adds/removes `.dark` from `document.documentElement`. No `next-themes` provider needed.

Root layout adds `suppressHydrationWarning` to `<html>` to prevent flicker.

---

## Framer Motion Usage

Animations are additive enhancements, not structural requirements:

- Sidebar expand/collapse: `motion.div` with `animate={{ width }}` spring
- Page transitions: optional `AnimatePresence` on route changes (stretch goal, not required)
- Card hover states: `whileHover` scale on cluster cards (stretch goal)

Core requirement: sidebar animation only.

---

## Success Criteria

1. App opens in dark mode with amber accent by default
2. Sidebar collapses to 44px icon strip; expands to 256px with labels on click
3. Light mode shows indigo accent
4. All existing pages (clusters, nodes, dashboard, jobs, wizard) still render correctly with new styles
5. All existing API routes and auth flows continue to work unchanged
6. `npm run build` completes with no errors
