"use client";

interface Day { date: string; count: number }

// 60-day compact heatmap: columns are ISO weeks (7 rows = Mon..Sun),
// cell intensity scales to the busiest day in the window.
export function ActivityHeatmap({ data }: { data: Day[] }) {
  const max = data.reduce((m, d) => Math.max(m, d.count), 0);
  const intensity = (c: number) => {
    if (c === 0) return 0;
    if (max === 0) return 0;
    return Math.min(4, Math.ceil((c / max) * 4));
  };
  const LEVEL_CLASS = [
    "bg-muted border border-border",
    "bg-chart-2/30",
    "bg-chart-2/55",
    "bg-chart-2/80",
    "bg-chart-2",
  ];

  // Group into columns: first column may be partial if the window starts
  // mid-week. Day index = getDay() with 0=Sunday, remap so Monday=0.
  const cells = data.map((d) => {
    const js = new Date(d.date + "T00:00:00Z").getUTCDay(); // 0 Sun … 6 Sat
    const row = (js + 6) % 7; // 0 Mon … 6 Sun
    return { ...d, row };
  });

  const columns: typeof cells[] = [];
  let cur: typeof cells = [];
  let lastRow = -1;
  for (const c of cells) {
    if (c.row <= lastRow) {
      columns.push(cur);
      cur = [];
    }
    cur.push(c);
    lastRow = c.row;
  }
  if (cur.length) columns.push(cur);

  return (
    <div className="space-y-2">
      <div className="grid gap-[3px] w-3/4" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((col, i) => {
          const filled: (Day & { row: number } | null)[] = Array(7).fill(null);
          for (const c of col) filled[c.row] = c;
          return (
            <div key={i} className="flex flex-col gap-[3px]">
              {filled.map((c, r) => (
                <span
                  key={r}
                  className={`block h-3 w-full rounded-[2px] ${c ? LEVEL_CLASS[intensity(c.count)] : "bg-transparent"}`}
                  title={c ? `${c.date}: ${c.count} job${c.count === 1 ? "" : "s"}` : ""}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
        <span>less</span>
        {LEVEL_CLASS.map((cls, i) => (
          <span key={i} className={`block h-2 w-2 rounded-[2px] ${cls}`} />
        ))}
        <span>more</span>
      </div>
    </div>
  );
}
