export type DbKind = "postgres" | "mysql" | "sqlite";
export type UiLanguage = "en" | "zh";
export type LlmProviderMode = "openrouter_simple" | "openai_compatible_custom";

export interface DataSourceConfig {
  id: string;
  name: string;
  kind: DbKind;
  uri: string;
  createdAt: string;
}

export interface SchemaEntity {
  datasourceId: string;
  tableName: string;
  tableType: "table" | "view";
  columns: SchemaColumn[];
  relations: SchemaRelation[];
  sampleRows: Record<string, unknown>[];
  description?: string;
}

export interface SchemaColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  description?: string;
}

export interface SchemaRelation {
  tableName: string;
  columnName: string;
  refTableName: string;
  refColumnName: string;
}

export interface BusinessTerm {
  id: string;
  term: string;
  definition: string;
  scope: string;
  confidence: number;
  source: "llm" | "user";
  createdAt: string;
  updatedAt: string;
}

export interface ClarificationQuestion {
  id: string;
  sessionId: string;
  runId: string;
  question: string;
  reason: string;
  targetType: "term" | "time_range" | "metric" | "field";
  targetKey: string;
  options?: string[];
}

export interface AnalysisPlanStep {
  id: string;
  title: string;
  sql: string;
  rationale: string;
  status?: "ok" | "blocked" | "error";
  reason?: string;
  durationMs?: number;
  rowCount?: number;
}

export interface InsightReport {
  summary: string;
  keyEvidence: Array<{ label: string; value: string }>;
  analysisMethod: string;
  chartSuggestion?: string;
  chart?: InsightChart;
  resultTable?: InsightResultTable;
  sqlTraces: AnalysisPlanStep[];
  debugLogs?: AnalysisDebugLog[];
}

export interface AnalysisDebugLog {
  ts: string;
  kind: "llm_request" | "llm_response" | "sql_started" | "sql_result" | "sql_blocked" | "sql_error" | "system";
  title: string;
  detail?: string;
  payload?: string;
}

export interface InsightChart {
  type: "line" | "bar" | "pie";
  title: string;
  xKey?: string;
  yKeys?: string[];
  labelKey?: string;
  valueKey?: string;
  data: Array<Record<string, unknown>>;
}

export interface InsightResultTable {
  title: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export interface SqlAuditRecord {
  id: string;
  runId: string;
  sql: string;
  durationMs: number;
  rowCount: number;
  status: "ok" | "blocked" | "error";
  reason?: string;
}

export interface QueryRequest {
  connectionId: string;
  question: string;
  sessionId?: string;
  conversationId?: string;
  llmModel?: string;
  language?: UiLanguage;
  llmRuntime?: ResolvedLlmRuntime;
}

export interface LlmSetting {
  id: string;
  scopeType: "datasource" | "conversation";
  scopeId: string;
  language: UiLanguage;
  providerMode: LlmProviderMode;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  providerLabel?: string;
  extraHeaders?: Record<string, string>;
  extraQueryParams?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  createdAt: string;
  updatedAt: string;
}

export interface LlmSettingInput {
  language: UiLanguage;
  providerMode: LlmProviderMode;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  providerLabel?: string;
  extraHeaders?: Record<string, string>;
  extraQueryParams?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
}

export interface ResolvedLlmRuntime {
  language: UiLanguage;
  providerMode: LlmProviderMode;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  providerLabel?: string;
  extraHeaders?: Record<string, string>;
  extraQueryParams?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  fromScope: "conversation" | "datasource" | "env";
}

export interface ClarifyRequest {
  sessionId: string;
  runId: string;
  answers: Array<{ questionId: string; answer: string }>;
}

export interface ChatConversation {
  id: string;
  datasourceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metaJson?: Record<string, unknown>;
  createdAt: string;
}

export interface RunEvent {
  id: number;
  runId: string;
  conversationId: string;
  eventType:
    | "run_started"
    | "planning"
    | "sql_started"
    | "sql_finished"
    | "sql_blocked"
    | "sql_error"
    | "evidence"
    | "final"
    | "failed";
  step: number;
  payload: Record<string, unknown>;
  createdAt: string;
}
