# DataWowsight (Vercel Native V1)

Natural-language analytics assistant for read-only databases.

## Stack
- Next.js App Router (UI + Route Handlers)
- Vercel Postgres (memory + sessions + audit)
- Target DB connectors: MySQL / PostgreSQL / SQLite
- SQL safety guard with AST + keyword blocking

## Quick Start
1. Install deps
```bash
npm install
```

2. Configure env
```bash
cp .env.example .env.local
```

3. Run
```bash
npm run dev
```

Open `http://localhost:3000`.

## Environment Variables
- `POSTGRES_URL` (required): Vercel Postgres connection string for app memory DB.
- `LLM_PROVIDER` (optional): `openrouter` | `openai` | `anthropic` | `gemini` | `mock`.
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL`, `OPENROUTER_APP_URL`, `OPENROUTER_APP_NAME` (optional)
- `OPENAI_API_KEY`, `OPENAI_MODEL` (optional)
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (optional)
- `GEMINI_API_KEY`, `GEMINI_MODEL` (optional)

## API Endpoints
- `GET/POST /api/connections`
- `POST /api/connections/:id/test`
- `POST /api/connections/:id/introspect`
- `POST /api/analysis/query`
- `POST /api/analysis/clarify`
- `GET /api/analysis/runs/:id`
- `GET/POST/PATCH /api/knowledge/terms`
- `POST /api/knowledge/bindings`

## Notes
- All target DB queries are read-only guarded. Non-SELECT statements are blocked.
- Non-read-only credentials are allowed with warning; the app still executes read-only SQL only.
- Query row limit and timeout are enforced in server logic.
- Run `/api/connections/:id/introspect` before asking analysis questions.
