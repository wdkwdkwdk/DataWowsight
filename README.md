# DataWowsight

DataWowsight is a full-stack natural language SQL analytics app.

It connects to read-only databases, runs iterative LLM-driven analysis, and returns answers with SQL traces, evidence, and optional charts.

## Features

- Multi-database target support
  - PostgreSQL
  - MySQL
  - SQLite (optional runtime dependency)
- Iterative analysis loop
  - planner -> SQL writer -> SQL execution -> evidence -> final answer
- SQL safety guardrails
  - read-only enforcement
  - DDL/DML blocking
  - risky query strategy blocking
- Real-time run updates
  - SSE stream with keepalive ping
  - polling fallback + stale-run resume
- Timeout-aware execution
  - SQL timeout
  - timeout recovery prompts and lightweight retry strategy
  - duplicate/shape guard to avoid repeating equivalent timed-out SQL
- Built-in memory/state on Postgres
  - datasources, schema index, notes
  - conversations, messages
  - runs, run events, SQL audit logs
  - business terms

## Bilingual + Model Settings (Implemented)

### Language

- App supports `en` and `zh`.
- Default language is **English**.
- Language affects:
  - UI settings text (settings modal)
  - analysis prompts (planner/sql-writer/summary/chart)
  - default LLM answer style

### Scoped LLM settings

Settings are persisted per scope with deterministic precedence:

1. conversation scope
2. datasource scope
3. environment defaults

### Provider modes

- `openrouter_simple`
  - user inputs API key only
  - defaults:
    - base URL: `https://openrouter.ai/api/v1`
    - model: env/default fallback
- `openai_compatible_custom`
  - required: `apiKey`, `baseUrl`, `model`
  - optional:
    - `providerLabel`
    - `extraHeaders` (JSON object)
    - `extraQueryParams` (JSON object)
    - `temperature`, `maxTokens`

### Model override behavior

- Request-level `llmModel` is still supported for backward compatibility.
- Persisted settings are resolved first; model override is applied for that single request only.

## Tech Stack

- Next.js 16 (App Router)
- React 19
- TypeScript
- Vercel Postgres (`@vercel/postgres`) for app memory DB
- `pg`, `mysql2`, `sqlite3` for target DB access
- `node-sql-parser` for SQL safety parsing

## Project Structure

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
  analysis/        # orchestration, prompts, planner flow
  i18n/            # UI/prompt language helpers
  llm/             # provider runtime + request assembly
  target-db/       # DB connectors and introspection
  memory-db.ts     # app memory persistence schema + access
  validation.ts    # zod request validation
  sql-safety.ts    # read-only SQL guardrails
```

## Quick Start

### 1) Install

```bash
npm install
```

### 2) Configure environment

```bash
cp .env.example .env.local
```

Required:

- `POSTGRES_URL`: memory DB for app state

Optional auth:

- `APP_ACCESS_PASSWORD`: enables app password gate

Optional LLM defaults (used when no saved settings):

- `APP_DEFAULT_LANGUAGE` (`en`/`zh`, default `en`)
- `LLM_PROVIDER`
- OpenRouter envs (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, etc.)
- OpenAI-compatible envs (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`)

### 3) Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## LLM Settings API

- `GET /api/llm/config`
  - provider defaults, selectable models, supported languages/provider modes
- `GET /api/settings/llm?datasourceId=...&conversationId=...`
  - returns effective + scoped settings
- `PATCH /api/settings/llm/datasource/:id`
  - upsert/reset datasource settings
- `PATCH /api/settings/llm/conversation/:id`
  - upsert/reset conversation override

## Core API

- `POST /api/analysis/query`
- `GET /api/analysis/runs/:id`
- `GET /api/analysis/runs/:id/stream`
- `GET/POST /api/connections`
- `POST /api/connections/:id/introspect`
- `GET /api/conversations`
- `POST /api/conversations/:id/messages`

## Scripts

```bash
npm run dev
npm run lint
npm run build
npm run start
```

## Build Status (current)

- `npm run lint` passes
- `npm run build` passes

## Deployment Notes

- Suitable for Vercel deployment
- Ensure `POSTGRES_URL` is configured
- Use read-only credentials for target databases
- For SQLite target access, runtime must support `sqlite3`

## Security Notes

- API keys in `llm_settings` are currently persisted in plaintext (current phase design)
- Do not commit `.env.local`
- Rotate any exposed credentials before open source release

## Limitations

- Very heavy scans can still timeout depending on target DB size/indexes
- Query quality depends on schema quality, note quality, and index design
- Serverless background execution is best-effort by platform limits

## License

No license file is included yet. Add a `LICENSE` (for example MIT) before publishing.
