"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";

interface Day { day: string; gpu: number; cpu: number }

export function ResourceHours7d({ data }: { data: Day[] }) {
  const total = data.reduce((a, b) => a + b.gpu + b.cpu, 0);
  if (total === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No finished jobs in the last 7 days.</p>;
  }
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} width={30} />
          <Tooltip
            contentStyle={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="gpu" name="GPU-hours" stroke="var(--chart-2)" strokeWidth={2} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="cpu" name="CPU-hours" stroke="var(--chart-3)" strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
