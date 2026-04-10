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
