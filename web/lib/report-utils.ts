/**
 * Shared helpers for the usage-report endpoints (/api/reports and
 * /api/reports/combined). Pure functions only — no DB or session access.
 */

// ── Timezone helpers (pure Intl, no external deps) ────────────────────────

// Convert "YYYY-MM-DD" to the UTC instant representing midnight in `tz`.
export function parseLocalMidnight(dateStr: string, tz: string): Date {
  const [y, mo, d] = dateStr.split("-").map(Number);
  // Probe at UTC noon — avoids the rare "24:00" display edge case at midnight.
  const probe = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hour12: false,
  }).formatToParts(probe);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
  const lh = get("hour") === 24 ? 0 : get("hour");
  const localNoonAsUTC = Date.UTC(get("year"), get("month") - 1, get("day"), lh, get("minute"), get("second"));
  const offsetMs = localNoonAsUTC - probe.getTime();
  return new Date(Date.UTC(y, mo - 1, d) - offsetMs);
}

// Format a Date as "YYYY-MM-DD" in `tz`.
export function toLocalDateStr(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

// Format a Date as "HH:MM" (24-hour) in `tz`.
export function fmtTimeInTZ(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  return `${parts.find((p) => p.type === "hour")!.value}:${parts.find((p) => p.type === "minute")!.value}`;
}

// Return every "YYYY-MM-DD" calendar string from fromStr to toStr (inclusive).
export function dateRangeStrings(fromStr: string, toStr: string): string[] {
  const dates: string[] = [];
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  let y = fy, m = fm, d = fd;
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i < 400; i++) {
    const s = `${y}-${pad(m)}-${pad(d)}`;
    dates.push(s);
    if (s >= toStr) break;
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    y = next.getUTCFullYear(); m = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  return dates;
}

// ── Job-script parsers ────────────────────────────────────────────────────

export function parseJobGresCpus(script: string): { gpus: number; cpus: number } {
  const gpuPatterns: RegExp[] = [
    /#SBATCH\s+--gres=gpu(?::[^:\s]+)?:(\d+)/,
    /#SBATCH\s+--gpus[=\s]+(?:[a-z0-9_-]+:)?(\d+)/i,
    /#SBATCH\s+-G[=\s]+(?:[a-z0-9_-]+:)?(\d+)/i,
    /#SBATCH\s+--gpus-per-task[=\s]+(?:[a-z0-9_-]+:)?(\d+)/i,
    /#SBATCH\s+--gpus-per-node[=\s]+(?:[a-z0-9_-]+:)?(\d+)/i,
  ];
  let gpus = 0;
  for (const re of gpuPatterns) {
    const m = script.match(re);
    if (m) gpus = Math.max(gpus, parseInt(m[1], 10) || 0);
  }
  const cpt = script.match(/#SBATCH\s+(?:--cpus-per-task|-c)[=\s]+(\d+)/);
  return { gpus, cpus: cpt ? parseInt(cpt[1], 10) || 1 : 1 };
}

export function parseJobName(script: string, id: string): string {
  const m = script.match(/#SBATCH\s+(?:--job-name|-J)[=\s]+(\S+)/);
  return m ? m[1] : `job-${id.slice(0, 8)}`;
}

// ── Formatting helpers ────────────────────────────────────────────────────

export function fmtElapsed(sec: number): string {
  if (sec <= 0) return "00:00:00";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const hms = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return d > 0 ? `${d}-${hms}` : hms;
}
