"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

interface Bucket { label: string; count: number }

export function DurationHistogram({ data }: { data: Bucket[] }) {
  const total = data.reduce((a, b) => a + b.count, 0);
  if (total === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No finished jobs in the last 24h.</p>;
  }
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} allowDecimals={false} width={28} />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            contentStyle={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
            }}
          />
          <Bar dataKey="count" radius={[3, 3, 0, 0]}>
            {data.map((_, i) => <Cell key={i} fill="var(--chart-2)" />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
