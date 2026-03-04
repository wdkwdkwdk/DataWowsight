import { sql } from "@vercel/postgres";
import type { BusinessTerm, ChatConversation, ChatMessage, DataSourceConfig, RunEvent, SchemaEntity } from "./types";

let initPromise: Promise<void> | null = null;

async function ensureSchema() {
  if (!process.env.POSTGRES_URL) {
    throw new Error("POSTGRES_URL is required. Configure Vercel Postgres first.");
  }

  if (!initPromise) {
    initPromise = (async () => {
      await sql`
        create table if not exists datasources (
          id text primary key,
          name text not null,
          kind text not null,
          uri text not null,
          created_at timestamptz not null default now()
        );
      `;
      await sql`
        create table if not exists schema_entities (
          id bigserial primary key,
          datasource_id text not null,
          table_name text not null,
          table_type text not null,
          columns_json jsonb not null,
          relations_json jsonb not null,
          sample_rows_json jsonb not null,
          description text,
          created_at timestamptz not null default now(),
          unique(datasource_id, table_name)
        );
      `;
      await sql`
        create table if not exists entity_annotations (
          id bigserial primary key,
          datasource_id text not null,
          entity_type text not null,
          entity_key text not null,
          note text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique(datasource_id, entity_type, entity_key)
        );
      `;
      await sql`
        create table if not exists knowledge_terms (
          id text primary key,
          term text not null,
          definition text not null,
          scope text not null,
          confidence numeric not null,
          source text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique(term, scope)
        );
      `;
      await sql`
        create table if not exists clarification_history (
          id text primary key,
          session_id text not null,
          run_id text not null,
          question_id text not null,
          question_hash text not null,
          scope text not null,
          answer text not null,
          created_at timestamptz not null default now(),
          unique(question_hash, scope)
        );
      `;
      await sql`
        create table if not exists analysis_sessions (
          id text primary key,
          connection_id text not null,
          context_json jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `;
      await sql`
        create table if not exists analysis_runs (
          id text primary key,
          session_id text not null,
          question text not null,
          status text not null,
          result_json jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `;
      await sql`create index if not exists idx_analysis_runs_status_created_at on analysis_runs(status, created_at desc);`;
      await sql`
        create table if not exists analysis_sql_steps (
          id text primary key,
          run_id text not null,
          title text not null,
          sql_text text not null,
          rationale text,
          created_at timestamptz not null default now()
        );
      `;
      await sql`
        create table if not exists sql_audit_logs (
          id text primary key,
          run_id text not null,
          sql_text text not null,
          duration_ms integer not null,
          row_count integer not null,
          status text not null,
          reason text,
          created_at timestamptz not null default now()
        );
      `;
      await sql`
        create table if not exists chat_conversations (
          id text primary key,
          datasource_id text not null,
          title text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `;
      await sql`create index if not exists idx_chat_conversations_ds_updated on chat_conversations(datasource_id, updated_at desc);`;
      await sql`
        create table if not exists chat_messages (
          id text primary key,
          conversation_id text not null,
          role text not null,
          content text not null,
          meta_json jsonb,
          created_at timestamptz not null default now()
        );
      `;
      await sql`create index if not exists idx_chat_messages_conv_created on chat_messages(conversation_id, created_at asc);`;
      await sql`
        create table if not exists run_events (
          id bigserial primary key,
          run_id text not null,
          conversation_id text not null,
          event_type text not null,
          step integer not null default 0,
          payload_json jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now()
        );
      `;
      await sql`create index if not exists idx_run_events_run_created on run_events(run_id, created_at asc);`;
    })();
  }

  return initPromise;
}

function mapDatasource(row: Record<string, unknown>): DataSourceConfig {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as DataSourceConfig["kind"],
    uri: String(row.uri),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export async function createDatasource(input: DataSourceConfig) {
  await ensureSchema();
  await sql`
    insert into datasources (id, name, kind, uri, created_at)
    values (${input.id}, ${input.name}, ${input.kind}, ${input.uri}, now())
  `;
  return input;
}

export async function listDatasources() {
  await ensureSchema();
  const res = await sql`select * from datasources order by created_at desc`;
  return res.rows.map(mapDatasource);
}

export async function getDatasource(id: string) {
  await ensureSchema();
  const res = await sql`select * from datasources where id = ${id} limit 1`;
  if (!res.rows.length) return null;
  return mapDatasource(res.rows[0]);
}

export async function renameDatasource(id: string, name: string) {
  await ensureSchema();
  await sql`
    update datasources
    set name = ${name}
    where id = ${id}
  `;
}

export async function saveSchemaEntities(entities: SchemaEntity[]) {
  await ensureSchema();
  for (const entity of entities) {
    const tableName = typeof entity.tableName === "string" ? entity.tableName.trim() : "";
    if (!tableName) {
      console.warn(`[schema_entities] skip empty table_name for datasource=${entity.datasourceId}`);
      continue;
    }
    await sql`
      insert into schema_entities (
        datasource_id, table_name, table_type, columns_json, relations_json, sample_rows_json, description
      ) values (
        ${entity.datasourceId}, ${tableName}, ${entity.tableType},
        ${JSON.stringify(entity.columns)}::jsonb,
        ${JSON.stringify(entity.relations)}::jsonb,
        ${JSON.stringify(entity.sampleRows)}::jsonb,
        ${entity.description ?? null}
      )
      on conflict (datasource_id, table_name)
      do update set
        table_type = excluded.table_type,
        columns_json = excluded.columns_json,
        relations_json = excluded.relations_json,
        sample_rows_json = excluded.sample_rows_json,
        description = excluded.description,
        created_at = now()
    `;
  }
}

export async function getSchemaEntities(datasourceId: string): Promise<SchemaEntity[]> {
  await ensureSchema();
  const res = await sql`
    select * from schema_entities where datasource_id = ${datasourceId} order by table_name asc
  `;
  return res.rows.map((r) => ({
    datasourceId,
    tableName: String(r.table_name),
    tableType: r.table_type as "table" | "view",
    columns: (r.columns_json as SchemaEntity["columns"]) ?? [],
    relations: (r.relations_json as SchemaEntity["relations"]) ?? [],
    sampleRows: (r.sample_rows_json as Record<string, unknown>[]) ?? [],
    description: (r.description as string | null) ?? undefined,
  }));
}

export async function upsertKnowledgeTerm(term: BusinessTerm) {
  await ensureSchema();
  await sql`
    insert into knowledge_terms (id, term, definition, scope, confidence, source, created_at, updated_at)
    values (${term.id}, ${term.term}, ${term.definition}, ${term.scope}, ${term.confidence}, ${term.source}, now(), now())
    on conflict (term, scope)
    do update set
      definition = excluded.definition,
      confidence = excluded.confidence,
      source = excluded.source,
      updated_at = now()
  `;
}

export async function listKnowledgeTerms(keyword?: string): Promise<BusinessTerm[]> {
  await ensureSchema();
  const res = keyword
    ? await sql`select * from knowledge_terms where term ilike ${`%${keyword}%`} order by updated_at desc`
    : await sql`select * from knowledge_terms order by updated_at desc`;

  return res.rows.map((row) => ({
    id: String(row.id),
    term: String(row.term),
    definition: String(row.definition),
    scope: String(row.scope),
    confidence: Number(row.confidence),
    source: row.source as "llm" | "user",
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  }));
}

export async function patchKnowledgeTerm(id: string, definition: string, confidence: number) {
  await ensureSchema();
  await sql`
    update knowledge_terms
    set definition = ${definition}, confidence = ${confidence}, source = 'user', updated_at = now()
    where id = ${id}
  `;
}

export async function upsertSession(sessionId: string, connectionId: string, context: Record<string, unknown>) {
  await ensureSchema();
  await sql`
    insert into analysis_sessions (id, connection_id, context_json, created_at, updated_at)
    values (${sessionId}, ${connectionId}, ${JSON.stringify(context)}::jsonb, now(), now())
    on conflict (id)
    do update set context_json = excluded.context_json, updated_at = now()
  `;
}

export async function getSession(sessionId: string) {
  await ensureSchema();
  const res = await sql`select * from analysis_sessions where id = ${sessionId} limit 1`;
  if (!res.rows.length) return null;
  return {
    id: String(res.rows[0].id),
    connectionId: String(res.rows[0].connection_id),
    context: (res.rows[0].context_json as Record<string, unknown>) ?? {},
  };
}

export async function createRun(runId: string, sessionId: string, question: string, status: string) {
  await ensureSchema();
  await sql`
    insert into analysis_runs (id, session_id, question, status, created_at, updated_at)
    values (${runId}, ${sessionId}, ${question}, ${status}, now(), now())
  `;
}

export async function updateRunStatus(runId: string, status: string, resultJson?: unknown) {
  await ensureSchema();
  await sql`
    update analysis_runs
    set status = ${status}, result_json = ${resultJson ? JSON.stringify(resultJson) : null}::jsonb, updated_at = now()
    where id = ${runId}
  `;
}

export async function touchRun(runId: string) {
  await ensureSchema();
  await sql`
    update analysis_runs
    set updated_at = now()
    where id = ${runId}
  `;
}

export async function getRun(runId: string) {
  await ensureSchema();
  const res = await sql`select * from analysis_runs where id = ${runId} limit 1`;
  if (!res.rows.length) return null;
  return {
    id: String(res.rows[0].id),
    sessionId: String(res.rows[0].session_id),
    question: String(res.rows[0].question),
    status: String(res.rows[0].status),
    result: res.rows[0].result_json,
    createdAt: new Date(String(res.rows[0].created_at)).toISOString(),
    updatedAt: new Date(String(res.rows[0].updated_at)).toISOString(),
  };
}

export async function insertSqlStep(id: string, runId: string, title: string, sqlText: string, rationale: string) {
  await ensureSchema();
  await sql`
    insert into analysis_sql_steps (id, run_id, title, sql_text, rationale, created_at)
    values (${id}, ${runId}, ${title}, ${sqlText}, ${rationale}, now())
  `;
}

export async function insertSqlAuditLog(input: {
  id: string;
  runId: string;
  sqlText: string;
  durationMs: number;
  rowCount: number;
  status: string;
  reason?: string;
}) {
  await ensureSchema();
  await sql`
    insert into sql_audit_logs (id, run_id, sql_text, duration_ms, row_count, status, reason, created_at)
    values (${input.id}, ${input.runId}, ${input.sqlText}, ${input.durationMs}, ${input.rowCount}, ${input.status}, ${input.reason ?? null}, now())
  `;
}

export async function saveClarificationAnswer(input: {
  id: string;
  sessionId: string;
  runId: string;
  questionId: string;
  questionHash: string;
  scope: string;
  answer: string;
}) {
  await ensureSchema();
  await sql`
    insert into clarification_history (id, session_id, run_id, question_id, question_hash, scope, answer, created_at)
    values (${input.id}, ${input.sessionId}, ${input.runId}, ${input.questionId}, ${input.questionHash}, ${input.scope}, ${input.answer}, now())
    on conflict (question_hash, scope)
    do update set answer = excluded.answer, created_at = now(), run_id = excluded.run_id, session_id = excluded.session_id
  `;
}

export async function upsertEntityAnnotation(input: {
  datasourceId: string;
  entityType: "table" | "field" | "metric" | "term" | "datasource";
  entityKey: string;
  note: string;
}) {
  await ensureSchema();
  await sql`
    insert into entity_annotations (datasource_id, entity_type, entity_key, note, created_at, updated_at)
    values (${input.datasourceId}, ${input.entityType}, ${input.entityKey}, ${input.note}, now(), now())
    on conflict (datasource_id, entity_type, entity_key)
    do update set note = excluded.note, updated_at = now()
  `;
}

export async function getEntityAnnotation(input: {
  datasourceId: string;
  entityType: "table" | "field" | "metric" | "term" | "datasource";
  entityKey: string;
}) {
  await ensureSchema();
  const res = await sql`
    select note, updated_at
    from entity_annotations
    where datasource_id = ${input.datasourceId}
      and entity_type = ${input.entityType}
      and entity_key = ${input.entityKey}
    limit 1
  `;
  if (!res.rows.length) return null;
  return {
    note: String(res.rows[0].note),
    updatedAt: new Date(String(res.rows[0].updated_at)).toISOString(),
  };
}

function mapConversation(row: Record<string, unknown>): ChatConversation {
  return {
    id: String(row.id),
    datasourceId: String(row.datasource_id),
    title: String(row.title),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: row.role as ChatMessage["role"],
    content: String(row.content),
    metaJson: (row.meta_json as Record<string, unknown> | null) ?? undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export async function createConversation(input: { id: string; datasourceId: string; title: string }) {
  await ensureSchema();
  await sql`
    insert into chat_conversations (id, datasource_id, title, created_at, updated_at)
    values (${input.id}, ${input.datasourceId}, ${input.title}, now(), now())
  `;
  return input;
}

export async function listConversations(datasourceId: string): Promise<ChatConversation[]> {
  await ensureSchema();
  const res = await sql`
    select * from chat_conversations where datasource_id = ${datasourceId} order by updated_at desc
  `;
  return res.rows.map(mapConversation);
}

export async function getConversation(id: string): Promise<ChatConversation | null> {
  await ensureSchema();
  const res = await sql`select * from chat_conversations where id = ${id} limit 1`;
  if (!res.rows.length) return null;
  return mapConversation(res.rows[0]);
}

export async function touchConversation(id: string, title?: string) {
  await ensureSchema();
  await sql`
    update chat_conversations
    set title = coalesce(${title ?? null}, title), updated_at = now()
    where id = ${id}
  `;
}

export async function createMessage(input: {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metaJson?: Record<string, unknown>;
}) {
  await ensureSchema();
  await sql`
    insert into chat_messages (id, conversation_id, role, content, meta_json, created_at)
    values (
      ${input.id},
      ${input.conversationId},
      ${input.role},
      ${input.content},
      ${input.metaJson ? JSON.stringify(input.metaJson) : null}::jsonb,
      now()
    )
  `;
  await touchConversation(input.conversationId);
}

export async function listMessages(conversationId: string): Promise<ChatMessage[]> {
  await ensureSchema();
  const res = await sql`
    select * from chat_messages where conversation_id = ${conversationId} order by created_at asc
  `;
  return res.rows.map(mapMessage);
}

export async function createRunEvent(input: {
  runId: string;
  conversationId: string;
  eventType: RunEvent["eventType"];
  step: number;
  payload?: Record<string, unknown>;
}) {
  await ensureSchema();
  await sql`
    insert into run_events (run_id, conversation_id, event_type, step, payload_json, created_at)
    values (
      ${input.runId},
      ${input.conversationId},
      ${input.eventType},
      ${input.step},
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      now()
    )
  `;
}

export async function listRunEvents(runId: string, sinceId?: number): Promise<RunEvent[]> {
  await ensureSchema();
  const res = sinceId
    ? await sql`select * from run_events where run_id = ${runId} and id > ${sinceId} order by id asc`
    : await sql`select * from run_events where run_id = ${runId} order by id asc`;
  return res.rows.map((row) => ({
    id: Number(row.id),
    runId: String(row.run_id),
    conversationId: String(row.conversation_id),
    eventType: row.event_type as RunEvent["eventType"],
    step: Number(row.step),
    payload: (row.payload_json as Record<string, unknown>) ?? {},
    createdAt: new Date(String(row.created_at)).toISOString(),
  }));
}

export async function deleteConversationCascade(conversationId: string) {
  await ensureSchema();
  await sql`
    delete from run_events
    where conversation_id = ${conversationId}
  `;
  await sql`
    delete from chat_messages
    where conversation_id = ${conversationId}
  `;
  await sql`
    delete from analysis_sql_steps
    where run_id in (select id from analysis_runs where session_id = ${conversationId})
  `;
  await sql`
    delete from sql_audit_logs
    where run_id in (select id from analysis_runs where session_id = ${conversationId})
  `;
  await sql`
    delete from clarification_history
    where session_id = ${conversationId}
       or run_id in (select id from analysis_runs where session_id = ${conversationId})
  `;
  await sql`
    delete from analysis_runs
    where session_id = ${conversationId}
  `;
  await sql`
    delete from analysis_sessions
    where id = ${conversationId}
  `;
  await sql`
    delete from chat_conversations
    where id = ${conversationId}
  `;
}

export async function deleteDatasourceCascade(datasourceId: string) {
  await ensureSchema();
  const conversations = await listConversations(datasourceId);
  for (const c of conversations) {
    await deleteConversationCascade(c.id);
  }

  await sql`
    delete from analysis_sql_steps
    where run_id in (
      select r.id
      from analysis_runs r
      join analysis_sessions s on s.id = r.session_id
      where s.connection_id = ${datasourceId}
    )
  `;
  await sql`
    delete from sql_audit_logs
    where run_id in (
      select r.id
      from analysis_runs r
      join analysis_sessions s on s.id = r.session_id
      where s.connection_id = ${datasourceId}
    )
  `;
  await sql`
    delete from clarification_history
    where scope = ${datasourceId}
       or session_id in (select id from analysis_sessions where connection_id = ${datasourceId})
       or run_id in (
         select r.id
         from analysis_runs r
         join analysis_sessions s on s.id = r.session_id
         where s.connection_id = ${datasourceId}
       )
  `;
  await sql`
    delete from analysis_runs
    where session_id in (select id from analysis_sessions where connection_id = ${datasourceId})
  `;
  await sql`
    delete from analysis_sessions
    where connection_id = ${datasourceId}
  `;
  await sql`
    delete from schema_entities
    where datasource_id = ${datasourceId}
  `;
  await sql`
    delete from entity_annotations
    where datasource_id = ${datasourceId}
  `;
  await sql`
    delete from knowledge_terms
    where scope = ${datasourceId}
  `;
  await sql`
    delete from datasources
    where id = ${datasourceId}
  `;
}
