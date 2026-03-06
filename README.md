# DataWowsight

<p align="center">
  <img src="./logo.jpg" alt="DataWowsight logo" width="180" />
</p>

> A lightweight, full-stack analytics agent you can run fast.  
> One repo, frontend + backend together, deploy directly on Vercel.

DataWowsight is an open-source analytics agent that connects to your database, plans analysis steps, executes read-only SQL, and returns evidence-backed answers with traces and charts.

Unlike many heavy BI/agent stacks, DataWowsight is intentionally lean:

- single Next.js codebase (UI + API routes)
- minimal infra requirements
- deployable as-is on Vercel
- fast to fork, run, and customize

## Demo

<p align="center">
  <a href="https://pub-032d3556965b40dd91eeae2971b35392.r2.dev/show_demo_datawowsight_2.mp4">
    <img src="https://pub-032d3556965b40dd91eeae2971b35392.r2.dev/agents1.png" alt="Watch the DataWowsight demo video" width="900" />
  </a>
</p>

<p align="center">
  Click the image above to watch the product demo video.
</p>

<p align="center">
  <img src="https://pub-032d3556965b40dd91eeae2971b35392.r2.dev/agents2.png" alt="Multi-step SQL trace" width="48%" />
  <img src="https://pub-032d3556965b40dd91eeae2971b35392.r2.dev/agents3.png" alt="Chart generation" width="48%" />
</p>

## Why DataWowsight

Most chat-to-SQL tools hide execution details. DataWowsight does the opposite:

- transparent run lifecycle (planning -> SQL -> evidence -> answer)
- SQL trace visibility for every step
- safety-first execution with guardrails
- resumable runs with SSE + polling fallback
- configurable LLM providers for real production use

And it stays lightweight while doing that.

## Feature Highlights

- Read-only analytics agent loop
  - planner decides next action
  - SQL writer generates executable query
  - backend executes and feeds evidence back into the loop
- Built-in chart support
  - supports `line`, `bar`, `pie`
  - chart data is derived from SQL result sets (not fabricated)
  - can be auto-suggested by the agent when suitable
- SQL safety layer
  - blocks DDL/DML and unsafe patterns
  - strategy checks for costly/risky query shapes
- Real-time run updates
  - SSE stream with keepalive ping
  - polling fallback with stale-run resume
- Timeout-aware recovery
  - lightweight retry strategy after timeout
  - duplicate/timeout-shape avoidance
- Bilingual capability
  - English / Chinese prompt packs
  - default language: English
- Flexible model configuration
  - OpenRouter simple mode
  - OpenAI-compatible custom mode
- Persistent memory on Postgres
  - datasources, schema cache, conversations, messages
  - run events, SQL audit logs, knowledge terms

## Architecture (Current)

```text
Client UI (Next.js)
  -> API Routes
    -> Analysis Orchestrator
      -> LLM Provider Adapter
      -> Target DB Connector (pg/mysql/sqlite)
      -> SQL Safety Guard
    -> Memory DB (Postgres)
```

Core folders:

```text
app/
  api/
    analysis/
    auth/
    connections/
    conversations/
    knowledge/
    llm/
    settings/
lib/
  analysis/
  i18n/
  llm/
  memory-db.ts
  sql-safety.ts
  target-db/
  validation.ts
```

## Quick Start

### 1) Install

```bash
npm install
```

### 2) Configure env

```bash
cp .env.example .env.local
```

Required:

- `POSTGRES_URL` (memory/state database)

Optional:

- `APP_ACCESS_PASSWORD` (UI password gate)
- `APP_DEFAULT_LANGUAGE` (`en` or `zh`)
- `LLM_PROVIDER`
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL`
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`

### 3) Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## LLM Settings

DataWowsight supports per-datasource LLM settings with deterministic fallback.

Provider modes:

- `openrouter_simple`
  - API key (manual or env fallback)
  - built-in model suggestions + custom model input
- `openai_compatible_custom`
  - required: `apiKey`, `baseUrl`, `model`
  - optional: headers/query params/temperature/max tokens

## API Surface (Core)

- `POST /api/analysis/query`
- `GET /api/analysis/runs/:id`
- `GET /api/analysis/runs/:id/stream`
- `GET/POST /api/connections`
- `POST /api/connections/:id/introspect`
- `GET /api/conversations`
- `POST /api/conversations/:id/messages`
- `GET /api/llm/config`
- `GET /api/settings/llm`
- `PATCH /api/settings/llm/datasource/:id`

## Scripts

```bash
npm run dev
npm run lint
npm run build
npm run start
```

## Deployment Notes

- Designed for lightweight deployment, especially Vercel
- One-click style flow: connect repo -> set env -> deploy
- Ensure memory DB is reachable from runtime
- Use read-only credentials for target databases
- SQLite target support depends on runtime availability for `sqlite3`

## Security Notes

- `llm_settings` currently stores API keys in plaintext (current phase)
- never commit `.env.local`
- rotate exposed keys immediately

## Roadmap (Short-Term)

- tenant-aware SaaS layer (auth, org, quota)
- stronger key management options
- richer chart planning and export workflows
- first-class deployment templates

## Contributing

PRs are welcome.

Please include:

- problem statement
- implementation summary
- verification steps (`npm run lint`, `npm run build`)

## License

Licensed under the Apache License 2.0. See [LICENSE](./LICENSE).
