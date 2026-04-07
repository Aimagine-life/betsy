# Tracing (Wave 4)

OpenTelemetry tracing for the multi-tenant agent. Disabled by default and
**no-op'd at zero overhead** when the SDK is not installed or
`BC_OTEL_ENABLED` is not set to `1`.

## Enabling

```bash
export BC_OTEL_ENABLED=1
export BC_OTEL_ENDPOINT=http://localhost:4318/v1/traces   # default
npm install                                               # pulls optionalDependencies
```

`@opentelemetry/api` is a hard dependency (tiny). The SDK + exporter
(`@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`,
`@opentelemetry/resources`, `@opentelemetry/semantic-conventions`) live in
`optionalDependencies` so packaged distributions can omit them.

If the SDK packages are missing, `initTracing()` logs a warning and the
runtime continues with no-op tracing — no exceptions, no behaviour change.

## Spans

When tracing is enabled, the multi runtime emits spans for the key paths:

- `betsy.runBetsy` / `betsy.runBetsyStream` — full assistant turn
  (attributes: `workspaceId`, `channel`, `userMsgLen`).
- `betsy.gemini.run` — single Gemini tool-loop call.
- `betsy.tool.<name>` — each tool execute.
- `betsy.subagent.<name>` — sub-agent delegation.
- `betsy.skill.<name>` — skill executions.
- `betsy.mcp.<server>.<tool>` — MCP tool calls.

Each span:

- gets `OK` status on success or `ERROR` + `recordException` on failure;
- carries the `traceId` into `AsyncLocalStorage` so logs emitted inside the
  span can be correlated (`getCurrentTraceId()` from
  `src/multi/observability/trace-context.ts`).

## Local Jaeger

```bash
docker run -d --name jaeger \
  -p 16686:16686 -p 4318:4318 \
  jaegertracing/all-in-one:latest
BC_OTEL_ENABLED=1 npm run dev
# open http://localhost:16686
```

## Adding a span

```ts
import { withSpan } from './observability/tracing.js'

await withSpan('betsy.my.thing', async (span) => {
  span?.setAttributes({ workspaceId })
  return doWork()
}, { workspaceId })
```

`withSpan` is a transparent passthrough when tracing is disabled — safe to
sprinkle anywhere without worrying about runtime cost or test pollution.
