"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

type Ctx = {
  collapsed: boolean;
  mobileOpen: boolean;
  togglePanel: () => void;
  closeMobile: () => void;
};

const SidebarStateContext = createContext<Ctx | null>(null);

export function SidebarStateProvider({ children }: { children: React.ReactNode }) {
  const collapsed = false;
  const [mobileOpen, setMobileOpen] = useState(false);

  const togglePanel = useCallback(() => {
    setMobileOpen((prev) => !prev);
  }, []);

  const closeMobile = useCallback(() => setMobileOpen(false), []);

  const value = useMemo(
    () => ({ collapsed, mobileOpen, togglePanel, closeMobile }),
    [collapsed, mobileOpen, togglePanel, closeMobile],
  );
  return <SidebarStateContext.Provider value={value}>{children}</SidebarStateContext.Provider>;
}

export function useSidebarState() {
  return (
    useContext(SidebarStateContext) ?? {
      collapsed: false,
      mobileOpen: false,
      togglePanel: () => {},
      closeMobile: () => {},
    }
  );
}
