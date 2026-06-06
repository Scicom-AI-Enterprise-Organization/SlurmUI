// Each subsection under /admin/settings/ (ssh-keys, alerts, git-sync,
// gitops-jobs) is now a direct destination from the main sidebar — the
// old sub-sidebar + "Settings" wrapper title duplicated what's already
// there, so this file becomes a thin pass-through. Each subpage owns its
// own heading + chrome.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
