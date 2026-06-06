# SlurmUI API-layer observability

A self-contained Prometheus + Loki + Promtail + Grafana stack that traces the
SlurmUI web app's **API layer**: HTTP status codes, request rate, latency
(p50/p90/p95/p99), and structured request logs filterable by status code,
route, method, and latency.

This is independent of the per-cluster Grafana that monitors GPU/node
exporters — it watches the SlurmUI app itself.

## What's instrumented

The custom server (`web/server.ts`) wraps every HTTP request and records:

- **Metrics** (`web/lib/http-metrics.ts`, via `prom-client`):
  - `slurmui_http_requests_total{method,route,status,status_class}` — counter
  - `slurmui_http_request_duration_seconds{...}` — latency histogram
  - `slurmui_*` Node runtime metrics (event loop, heap, GC)
  - Exposed by the existing `GET /api/metrics` endpoint.
- **Logs** (`pino`, one JSON line per request to stdout):
  `{ service, kind:"http_access", method, route, path, status, statusClass,
  durationMs, userEmail, requestId, ip, bytes }`.
  Promtail tails the web container's stdout → Loki.

`route` is normalized (`/api/clusters/<cuid>/jobs` → `/api/clusters/:id/jobs`)
to keep Prometheus cardinality bounded; the raw path is kept in logs as `path`.
Each request also gets an `x-request-id` (echoed in the response header) so a
metric spike and its Loki log line can be correlated.

## Run it

```bash
# from repo root, with the web app already running (docker-compose.prod.yml)
docker compose -f monitoring/docker-compose.monitoring.yml up -d
```

- Grafana:    http://localhost:3001  (admin / admin — change on first login,
  or set `GRAFANA_USER` / `GRAFANA_PASSWORD`)
- Prometheus: http://localhost:9091

The dashboard **"SlurmUI — API Layer (Metrics & Logs)"** is auto-provisioned
(folder *SlurmUI*).

### Networking

The web app runs with `network_mode: host` on port 3000, so the bridged
monitoring containers reach it via `host.docker.internal:3000` (wired with a
`host-gateway` alias). Promtail discovers the web container over the Docker
socket and matches container names containing `web`/`slurmui`.

### Auth (optional)

If the app sets `METRICS_TOKEN`, write the token to
`monitoring/prometheus/metrics_token` and uncomment the `authorization` block
in `prometheus/prometheus.yml` (mount it into the prometheus container).

## Using the dashboard

- **Overview**: request rate, error %, p95, 5xx rate.
- **Filters** (top of dashboard): `route`, `method`, `status_class`.
- **Logs panel filters**:
  - *Log status (regex)* — e.g. `5..` for 5xx, `404`, `4..|5..`, `.+` for all.
  - *Min latency (ms)* — show only requests slower than N ms.

Example LogQL you can run in Explore:

```logql
{service="slurmui", kind="http_access"} | json | status >= 500
{service="slurmui"} | json | durationMs > 1000
{service="slurmui", route="/api/clusters/:id/jobs"} | json
```

## Notes / tuning

- Loki retention is 7 days (`loki/loki-config.yml`), Prometheus 15 days
  (`docker-compose.monitoring.yml`). Adjust for your traffic/disk.
- Under `next dev` the route handler and `server.ts` can run in different
  workers, so a scrape may briefly show empty HTTP metrics — production
  (`tsx server.ts` / the prod bundle) runs a single process and is unaffected.
- This covers SlurmUI only. The same `prom-client`/`pino` pattern ports to
  other apps by reusing `web/lib/http-metrics.ts` and adding a scrape target.
