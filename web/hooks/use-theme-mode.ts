"use client";

import { useState, useEffect, useCallback } from "react";

export function useThemeMode() {
  const [isDark, setIsDark] = useState(false);

  // On mount: read saved preference and sync state + class
  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    // Default to dark when no preference saved
    const shouldBeDark = saved ? saved === "dark" : (systemPrefersDark || true);
    setIsDark(shouldBeDark);
    document.documentElement.classList.toggle("dark", shouldBeDark);
  }, []);

  // Toggle handler: directly update both DOM and state (no effect race)
  const applyTheme = useCallback((dark: boolean) => {
    setIsDark(dark);
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, []);

  const toggleTheme = useCallback(() => {
    applyTheme(!isDark);
  }, [isDark, applyTheme]);

  return { isDark, setIsDark: applyTheme, toggleTheme };
}
