# Cache Investigator

Cache Investigator is an agent that investigates generated telemetry from a catalog service with a seeded cache regression. It can query the evidence but cannot see the planted cause. Each investigation can be followed live, stays available as a finished report, and gets compressed into a Slack message.

When someone starts an investigation, the model works in a bounded loop that decides what to check next. It can query metrics, logs, deployments and dependencies. The page shows these steps as they happen and saves progress so the investigation continues if the browser closes. The same route becomes the finished report when the run ends, and a Slack message is sent.

## Design decisions

I first tried a queue failure in a media-processing service. But the investigations were too quick. So I switched to a cache regression because it offered several signals change together, and the agent has to connect them before it can explain what happened.

I used a familiar structure like Linear, something engineers already know how to navigate. Like treating investigations as issues.

For an information-dense surface like the finished investigation, I went with a scroll to read first and then click to dig in, progressive disclosure pattern. The easy scrolling tells the big picture, conclusions, recommendations, impact and signals. Clicking lets you inspect individual claims and their evidence more closely. Each kind of information got its own visual treatment so it stays easy to scan and digest.

For the live view, time was constrained, so I focused on making the flow work and having clear states. Like what the agent is doing, work completed, whether it is waiting, failed, finished, etc. I traded visual and interaction design, and polish, for clear and reliable use. The screen is more generic than I wanted but the flow should work across every state.

A few of the design explorations I did for the index and finished view [Paper scratchpad](https://app.paper.design/file/01K4QW3RP4YWQJ9M64RTFCPBN6/01K4QW3RP4423XVE8ZJ1ND6KX3).

I spent more time than I wanted on the backend. With more time, I would focus on the product's overall visual and interaction design, especially on the live view. Like visually nicer live states or better tool transitions and motion. Also, improve UX flaws like starting the investigation from the index. If I were to go deeper, I would spend more time getting familiar with the data so I could design better representations and visual hierarchies.

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
