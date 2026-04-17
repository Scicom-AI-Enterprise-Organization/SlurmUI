"use client";

import {
  AreaChart,
  Area,
  XAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface Bucket {
  hour: string;
  running: number;
  completed: number;
  failed: number;
}

interface Props {
  data: Bucket[];
}

// Pull colors from the app's CSS variables so the chart tracks the active
// theme (light / dark, and the Enterprise-Template brand tokens).
const COLORS = {
  running: "var(--chart-2)",    // primary-ish series
  completed: "var(--chart-3)",  // darker accent
  failed: "var(--destructive)",
  grid: "var(--border)",
  axis: "var(--muted-foreground)",
  tooltipBg: "var(--card)",
  tooltipBorder: "var(--border)",
  tooltipFg: "var(--foreground)",
};

export function JobsLast24hChart({ data }: Props) {
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="gradRunning" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLORS.running} stopOpacity={0.5} />
              <stop offset="100%" stopColor={COLORS.running} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradCompleted" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLORS.completed} stopOpacity={0.5} />
              <stop offset="100%" stopColor={COLORS.completed} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradFailed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLORS.failed} stopOpacity={0.5} />
              <stop offset="100%" stopColor={COLORS.failed} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="hour"
            tick={{ fontSize: 12, fill: COLORS.axis }}
            tickLine={{ stroke: COLORS.grid }}
            axisLine={{ stroke: COLORS.grid }}
            interval={3}
            minTickGap={24}
          />
          <Tooltip
            contentStyle={{
              background: COLORS.tooltipBg,
              border: `1px solid ${COLORS.tooltipBorder}`,
              borderRadius: 6,
              fontSize: 12,
              color: COLORS.tooltipFg,
            }}
            labelStyle={{ color: COLORS.tooltipFg }}
            itemStyle={{ color: COLORS.tooltipFg }}
            cursor={{ stroke: COLORS.grid }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, color: COLORS.axis }}
            iconType="circle"
          />
          <Area
            type="monotone"
            dataKey="running"
            name="Running"
            stroke={COLORS.running}
            fill="url(#gradRunning)"
            strokeWidth={2}
          />
          <Area
            type="monotone"
            dataKey="completed"
            name="Completed"
            stroke={COLORS.completed}
            fill="url(#gradCompleted)"
            strokeWidth={2}
          />
          <Area
            type="monotone"
            dataKey="failed"
            name="Failed"
            stroke={COLORS.failed}
            fill="url(#gradFailed)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
