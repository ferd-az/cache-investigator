# Cache Investigator

Cache Investigator is an agent that investigates generated telemetry from a catalog service with a seeded cache regression. The agent can query the dataset but has no access to the planted cause.

I initially considered investigating a queue failure in a media-processing service. But the cause could be exposed by a single configuration change, making the investigation too straightforward. A cache regression offered a richer problem: several signals change together, and the agent has to connect them before it can explain what happened.

## Run locally

Use Node.js 22, then:

```bash
npm install
npm run simulator:validate
npm run dev
```

Run the full project checks with:

```bash
npm run check
npm run build
```
