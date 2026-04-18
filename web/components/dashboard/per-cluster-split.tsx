"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";

interface Row {
  cluster: string;
  completed: number;
  failed: number;
  pending: number;
  running: number;
}

export function PerClusterSplit({ data }: { data: Row[] }) {
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 8, left: -20, bottom: 0 }} barSize={16}>
          <XAxis type="number" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="cluster" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} width={60} />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            contentStyle={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="completed" stackId="x" fill="var(--chart-3)" radius={[3, 0, 0, 3]} />
          <Bar dataKey="running" stackId="x" fill="var(--chart-2)" />
          <Bar dataKey="pending" stackId="x" fill="var(--chart-4)" />
          <Bar dataKey="failed" stackId="x" fill="var(--destructive)" radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
