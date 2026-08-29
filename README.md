# Cache Investigator

Cache Investigator is an agent that investigates generated telemetry from a catalog service with a seeded cache regression. The agent can query the dataset but has no access to the planted cause. Each run is isolated and persists across browser disconnects.

I initially considered investigating a queue failure in a media-processing service. But the cause could be exposed by a single configuration change, making the investigation too straightforward. A cache regression offered a richer problem: several signals change together, and the agent has to connect them before it can explain what happened.

## Try the live investigation

Open [Watchtower](https://cache-investigator.ferd1az.workers.dev), then click
the **Needs attention** row. This starts a real investigation and opens its
permanent URL. The page shows the agent's work live, then becomes the completed
investigation at the same URL.

## Run locally

Use Node.js 22, then:

```bash
npm install
npm run simulator:validate
npm run dev
```

## Test agent states

The same investigation surface handles every state. Scenario flags make the
otherwise nondeterministic paths reproducible without adding test controls to
the product UI.

For chaos scenarios, add this non-secret flag to `.dev.vars` and restart the
development server:

```dotenv
INVESTIGATION_CHAOS=enabled
```

Start a scenario with:

```bash
npm run investigate -- --scenario slow
```

The command prints a permalink to open while the investigation runs. Available
scenarios:

- `normal` — completes a real investigation without injected behavior.
- `slow` — delays a tool call and emits truthful elapsed progress.
- `tool-failure` — fails one tool attempt, preserves the failure, and retries.
- `fatal` — collects partial evidence, then stops on a non-retryable tool
  failure.
- `no-findings` — investigates a quiet pre-incident window, persists three
  checks, then ends with no actionable finding.
- `invalid-final` — returns invalid final findings until the bounded retry
  budget is exhausted.

To test connection recovery, start `normal` or `tool-failure`, close the
permalink while it is running, then reopen it. The run continues in its Durable
Object and the route hydrates from persisted state.

Use `--base-url <url>` or set `CACHE_INVESTIGATOR_URL` to run a scenario against
another deployment.

Run the full project checks with:

```bash
npm run check
```
