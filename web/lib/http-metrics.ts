// API-layer (RED) instrumentation: per-request status codes + latency as
// Prometheus metrics, plus a structured JSON request log shipped via stdout
// → Promtail → Loki. Both are recorded from the custom server's request
// wrapper (server.ts) — the one place that sees every HTTP request in a
// single long-lived Node process. middleware.ts can't do this: it runs on
// the Edge runtime and can't hold a prom-client registry in process memory.
//
// The registry here is module-global, so the /api/metrics route handler
// (same Node process) can serialize it alongside the existing business
// gauges without a second endpoint.
import {
  Registry,
  Counter,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";
import pino from "pino";

// Dedicated registry so HTTP metrics live next to the existing hand-built
// business metrics in /api/metrics. We expose its output by appending it
// to that route's body.
export const httpRegistry = new Registry();

// Process/event-loop/GC/heap metrics — cheap and invaluable for spotting
// event-loop stalls behind latency spikes.
collectDefaultMetrics({ register: httpRegistry, prefix: "slurmui_" });

const httpRequestsTotal = new Counter({
  name: "slurmui_http_requests_total",
  help: "Total HTTP requests handled, by method, normalized route, and status code",
  labelNames: ["method", "route", "status", "status_class"] as const,
  registers: [httpRegistry],
});

const httpRequestDuration = new Histogram({
  name: "slurmui_http_request_duration_seconds",
  help: "HTTP request latency in seconds, by method, normalized route, and status code",
  labelNames: ["method", "route", "status", "status_class"] as const,
  // Tuned for an interactive web/API app: sub-10ms static hits up to
  // multi-second SSH/Prometheus-proxy calls.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [httpRegistry],
});

const httpRequestsInFlight = new Counter({
  name: "slurmui_http_requests_in_flight_total",
  help: "Counter of requests entering the handler (paired with _total to spot drops)",
  labelNames: ["method"] as const,
  registers: [httpRegistry],
});

// Structured request logger. Pino writes newline-delimited JSON to stdout;
// Promtail tails the container's stdout and ships to Loki, where LogQL can
// filter `| json | status >= 500` / `| durationMs > 1000` / by route.
// `service` is a stable label so the Loki/Grafana queries don't depend on
// the container name.
export const httpLogger = pino({
  name: "slurmui-http",
  base: { service: "slurmui", kind: "http_access" },
  level: process.env.HTTP_LOG_LEVEL ?? "info",
  // Render the well-known fields predictably; everything else is passed
  // through as JSON.
  redact: {
    paths: ["headers.authorization", "headers.cookie"],
    remove: true,
  },
});

/**
 * Collapse high-cardinality path segments (cuids, uuids, numeric ids, opaque
 * tokens) to `:id` so each logical endpoint is ONE Prometheus series instead
 * of one-per-resource. Without this, `/api/clusters/<cuid>/jobs` would mint a
 * new time series per cluster — the classic metrics-cardinality blowup.
 */
const CUID = /^c[a-z0-9]{20,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const LONG_OPAQUE = /^[A-Za-z0-9_-]{20,}$/; // base64url tokens, long hashes
const HEX = /^[0-9a-f]{16,}$/i;

export function normalizeRoute(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  // Drop trailing slash (except root) for stable labels.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const segments = path.split("/").map((seg) => {
    if (!seg) return seg;
    if (
      CUID.test(seg) ||
      UUID.test(seg) ||
      NUMERIC.test(seg) ||
      HEX.test(seg) ||
      LONG_OPAQUE.test(seg)
    ) {
      return ":id";
    }
    return seg;
  });
  const normalized = segments.join("/") || "/";
  // Safety net against unbounded cardinality from unexpected deep paths.
  return normalized.length > 200 ? normalized.slice(0, 200) : normalized;
}

function statusClass(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "1xx";
}

export function markInFlight(method: string) {
  httpRequestsInFlight.inc({ method });
}

/**
 * Record one finished request: increment the counter, observe the latency
 * histogram, and emit a structured access log. Called once per request from
 * server.ts on the response `finish`/`close` event.
 */
export function recordHttpRequest(opts: {
  method: string;
  pathname: string;
  status: number;
  durationMs: number;
  userEmail?: string | null;
  requestId?: string;
  ip?: string | null;
  bytes?: number;
}) {
  const route = normalizeRoute(opts.pathname);
  const cls = statusClass(opts.status);
  const labels = {
    method: opts.method,
    route,
    status: String(opts.status),
    status_class: cls,
  };
  httpRequestsTotal.inc(labels);
  httpRequestDuration.observe(labels, opts.durationMs / 1000);

  // One JSON line per request. `level` reflects severity so 5xx stand out
  // in Loki without parsing status.
  const fields = {
    method: opts.method,
    route, // normalized — stable for dashboards
    path: opts.pathname, // raw — for drill-down
    status: opts.status,
    statusClass: cls,
    durationMs: Math.round(opts.durationMs * 1000) / 1000,
    userEmail: opts.userEmail ?? undefined,
    requestId: opts.requestId,
    ip: opts.ip ?? undefined,
    bytes: opts.bytes,
  };
  if (opts.status >= 500) httpLogger.error(fields, "http_request");
  else if (opts.status >= 400) httpLogger.warn(fields, "http_request");
  else httpLogger.info(fields, "http_request");
}
