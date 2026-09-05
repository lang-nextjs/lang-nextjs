# Load Tests

k6-based load test suite for measuring performance under concurrent load.

## Requirements

- [k6](https://k6.io/docs/getting-started/installation/) v0.55.0+

## Environment Variables

| Variable                 | Default                 | Description                                    |
| ------------------------ | ----------------------- | ---------------------------------------------- |
| `LANGGRAPH_PLATFORM_URL` | `http://localhost:8000` | LangGraph Platform API URL                     |
| `OPEN_SWE_ASSISTANT_ID`  | `open-swe`              | Assistant ID for run creation                  |
| `LANGGRAPH_API_KEY`      | _(empty)_               | API key for LangGraph Platform                 |
| `OPENSWE_URL`            | `http://localhost:3001` | Next.js open-swe proxy URL                     |
| `BACKEND_URL`            | `http://localhost:8001` | FastAPI backend URL                            |
| `TARGET_RPS`             | `50`                    | Target requests per second for sustained tests |
| `DURATION`               | `5m`                    | Duration for sustained tests                   |

## Scripts

### `sandbox-creation.js`

Measures container/run creation latency under increasing concurrency.

**Scenarios:**

1. Warmup — 1 VU for 5s
2. Ramp to 50 VUs over 30s, hold 1m
3. Ramp to 100 VUs over 30s, hold 1m
4. Ramp down

**Key metrics:**

- Run creation latency (p50/p95/p99)
- Error rate at each concurrency level
- Throughput (runs/sec) as concurrency increases

**Run:**

```bash
LANGGRAPH_PLATFORM_URL=http://localhost:8000 \
OPEN_SWE_ASSISTANT_ID=open-swe \
k6 run tests/load/sandbox-creation.js
```

### `streaming.js`

Measures SSE stream consumption under concurrent load.

**Scenarios:**

1. Burst — 20 VUs constant for 30s (baseline latency)
2. Ramp — 0→50→100 VUs over time, finds breaking point

**Key metrics:**

- Time-to-first-byte (TTFB) p50/p95/p99
- Messages/second throughput
- Premature stream close rate
- Error rate (502s, 503s, timeouts)

**Run:**

```bash
LANGGRAPH_PLATFORM_URL=http://localhost:8000 \
OPENSWE_URL=http://localhost:3001 \
k6 run tests/load/streaming.js
```

### `sustained-throughput.js`

Fixed-rate run creation and optional mixed workload over extended period.

**Scenarios:**

1. Constant arrival rate at `TARGET_RPS` runs/sec for `DURATION`

**Key metrics:**

- Achieved RPS vs target RPS
- Latency distribution under sustained load
- Error rate drift over time
- p50/p95/p99 container creation time under load

**Run:**

```bash
LANGGRAPH_PLATFORM_URL=http://localhost:8000 \
OPENSWE_URL=http://localhost:3001 \
TARGET_RPS=50 DURATION=5m \
k6 run tests/load/sustained-throughput.js
```

## Output Formats

```bash
# Text summary (default)
k6 run tests/load/streaming.js

# JSON for CI / dashboards
k6 run --out json=results.json tests/load/streaming.js

# Prometheus / InfluxDB remote write
k6 run --out influxdb=http://localhost:8086/k6 tests/load/streaming.js

# CSV for offline analysis
k6 run --out csv=results.csv tests/load/streaming.js
```

## Interpreting Results

### Sandbox Creation

- **p99 > 5000ms** at 50 VUs → platform bottleneck; check LangGraph Platform scaling
- **Error rate > 5%** at 100 VUs → circuit breaker activating; expected behavior
- **p50 spike** during ramp → sign to investigate proxy layer

### Streaming

- **TTFB p99 > 2000ms** → proxy buffering issue or upstream backpressure
- **Message throughput drop** at 100 VUs → streaming pipeline saturation
- **Premature closes** → upstream connection drops under load

### Sustained Throughput

- **Achieved RPS < 80% of target** → bottleneck somewhere in stack
- **p95 latency increasing over time** → memory leak or connection pool exhaustion
- **Error rate drift** → platform or Docker daemon degradation

## CI / Nightly Integration

```yaml
# .github/workflows/load-test.yml
name: load-tests

on:
  schedule:
    - cron: "0 2 * * *" # 2am nightly
  workflow_dispatch:

jobs:
  load-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: grafana/k6-action@v0.3
        with:
          flags: run --out json=load-test-results.json tests/load/
      - upload-artifact: load-test-results.json
```

## Troubleshooting

**k6 exits with "context deadline exceeded":**
→ Increase `--max` open files: `ulimit -n 65535` before running k6.

**Too many file descriptors:**
→ Add to k6 command: `k6 run --system-tags=url tests/load/...` to reduce per-VU overhead.

**Platform unreachable errors from start:**
→ Verify `LANGGRAPH_PLATFORM_URL` is reachable from where k6 runs (check docker-compose networking if running in CI).
