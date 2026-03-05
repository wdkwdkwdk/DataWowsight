export const ANALYSIS_DEFAULTS = {
  sampleRowsPerTable: 100,
  maxIntrospectTables: 10000,
  schemaLlmMaxTables: 8,
  maxSqlPerRun: 8,
  maxRowsPerQuery: 200,
  queryTimeoutMs: 100_000,
  runBudgetMs: 260_000,
  llmTimeoutMs: 8_000,
  defaultRecentDays: 30,
};

export const BLOCKED_SQL_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "truncate",
  "grant",
  "revoke",
  "create",
  "replace",
  "merge",
  "copy",
  "load",
  "call",
  "do",
  "attach",
  "detach",
  "vacuum",
];

export const REDACTED_FIELD_PATTERNS = ["phone", "mobile", "email", "id_card", "ssn"];
