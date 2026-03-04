import { randomUUID } from "crypto";
import { ANALYSIS_DEFAULTS } from "../config";
import { runSchemaIntelligence } from "./schema-intelligence";
import { callLlm } from "../llm/provider";
import {
  createConversation,
  createMessage,
  createRun,
  createRunEvent,
  getConversation,
  getDatasource,
  getEntityAnnotation,
  getSchemaEntities,
  getSession,
  insertSqlAuditLog,
  insertSqlStep,
  listMessages,
  touchConversation,
  updateRunStatus,
  upsertEntityAnnotation,
  upsertSession,
} from "../memory-db";
import { ensureSafeReadOnlySql } from "../sql-safety";
import { withTargetDb } from "../target-db/client";
import type { AnalysisDebugLog, AnalysisPlanStep, ClarifyRequest, DbKind, InsightChart, InsightReport, QueryRequest, RunEvent } from "../types";
import {
  buildChartPlannerSystemPrompt,
  buildChartPlannerUserPayload,
  buildPlannerStage1RetryContext,
  buildPlannerStage1SystemPrompt,
  buildPlannerStage1UserContext,
  buildSqlWriterRetryContext,
  buildSqlWriterSystemPrompt,
  buildSqlWriterUserContext,
  buildSummarySystemPrompt,
  buildSummaryUserPayload,
} from "./prompts";

type PlannerAction =
  | {
      action: "run_sql";
      title: string;
      rationale: string;
      sql: string;
    }
  | {
      action: "add_note";
      title: string;
      rationale: string;
      note: string;
    }
  | {
      action: "final_answer";
      summary: string;
      showChart?: boolean;
    };

type PlannerDecision =
  | {
      action: "run_sql";
      title: string;
      rationale: string;
      tables: string[];
    }
  | {
      action: "add_note";
      title: string;
      rationale: string;
      note: string;
    }
  | {
      action: "final_answer";
      summary: string;
      showChart?: boolean;
    };

type ProgressState = {
  phase: "planning" | "executing" | "completed" | "failed";
  step: number;
  maxSteps: number;
  title?: string;
  detail?: string;
};

export async function runAnalysisQuery(input: QueryRequest) {
  const datasource = await getDatasource(input.connectionId);
  if (!datasource) {
    throw new Error("Connection not found");
  }

  const conversationId = await ensureConversationId(input.conversationId, datasource.id, input.question);
  const sessionId = conversationId;
  const runId = randomUUID();
  const session = await getSession(sessionId);
  const context = session?.context ?? {};

  await upsertSession(sessionId, datasource.id, context);
  await touchConversation(conversationId, summarizeTitle(input.question));

  await createMessage({
    id: randomUUID(),
    conversationId,
    role: "user",
    content: input.question,
  });

  await createRun(runId, sessionId, input.question, "running");
  await updateRunStatus(runId, "running", {
    progress: {
      phase: "planning",
      step: 1,
      maxSteps: ANALYSIS_DEFAULTS.maxSqlPerRun,
      detail: "任务已创建，准备开始分析",
    },
  });

  await createRunEvent({
    runId,
    conversationId,
    eventType: "run_started",
    step: 0,
    payload: { question: input.question },
  });

  void executeAnalysisInBackground({
    runId,
    conversationId,
    sessionId,
    connectionId: datasource.id,
    uri: datasource.uri,
    dbKind: datasource.kind,
    question: input.question,
    context,
  });

  return {
    status: "running",
    sessionId,
    conversationId,
    runId,
  };
}

export async function applyClarifications(_input: ClarifyRequest) {
  void _input;
  throw new Error("Clarification flow is disabled. Use /api/analysis/query directly.");
}

async function ensureConversationId(inputConversationId: string | undefined, datasourceId: string, question: string) {
  if (!inputConversationId) {
    const id = randomUUID();
    await createConversation({ id, datasourceId, title: summarizeTitle(question) });
    return id;
  }

  const found = await getConversation(inputConversationId);
  if (!found) {
    throw new Error("Conversation not found");
  }
  if (found.datasourceId !== datasourceId) {
    throw new Error("Conversation does not belong to selected datasource");
  }
  return found.id;
}

async function executeAnalysisInBackground(input: {
  runId: string;
  conversationId: string;
  sessionId: string;
  connectionId: string;
  uri: string;
  dbKind: DbKind;
  question: string;
  context: Record<string, unknown>;
}) {
  try {
    const report = await executeAnalysis({
      runId: input.runId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      connectionId: input.connectionId,
      uri: input.uri,
      dbKind: input.dbKind,
      question: input.question,
      onProgress: async (progress) => {
        await updateRunStatus(input.runId, "running", { progress });
        await createRunEvent({
          runId: input.runId,
          conversationId: input.conversationId,
          eventType: mapPhaseToEvent(progress.phase),
          step: progress.step,
          payload: progress,
        });
      },
      onEvent: async (eventType, step, payload) => {
        await createRunEvent({
          runId: input.runId,
          conversationId: input.conversationId,
          eventType,
          step,
          payload,
        });
      },
    });

    await createMessage({
      id: randomUUID(),
      conversationId: input.conversationId,
      role: "assistant",
      content: report.summary,
      metaJson: { report },
    });

    await createRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      eventType: "final",
      step: report.sqlTraces.length,
      payload: { report },
    });

    await updateRunStatus(input.runId, "completed", {
      progress: {
        phase: "completed",
        step: report.sqlTraces.length,
        maxSteps: ANALYSIS_DEFAULTS.maxSqlPerRun,
        detail: "分析完成",
      },
      report,
    });

    await upsertSession(input.sessionId, input.connectionId, {
      ...input.context,
      lastQuestion: input.question,
      lastSummary: report.summary,
      lastUpdatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await createMessage({
      id: randomUUID(),
      conversationId: input.conversationId,
      role: "assistant",
      content: `分析失败：${message}`,
    });
    await createRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      eventType: "failed",
      step: 0,
      payload: { error: message },
    });
    await updateRunStatus(input.runId, "failed", {
      progress: {
        phase: "failed",
        step: 0,
        maxSteps: ANALYSIS_DEFAULTS.maxSqlPerRun,
        detail: "分析失败",
      },
      error: message,
    });
  }
}

async function executeAnalysis(input: {
  runId: string;
  conversationId: string;
  sessionId: string;
  connectionId: string;
  uri: string;
  dbKind: DbKind;
  question: string;
  onProgress?: (progress: ProgressState) => Promise<void>;
  onEvent?: (eventType: RunEvent["eventType"], step: number, payload: Record<string, unknown>) => Promise<void>;
}): Promise<InsightReport> {
  const entities = await getSchemaEntities(input.connectionId);
  if (!entities.length) {
    await runSchemaIntelligence(input.connectionId, input.uri, { maxTables: Number.MAX_SAFE_INTEGER });
  }
  const readyEntities = (await getSchemaEntities(input.connectionId)) ?? [];
  if (!readyEntities.length) {
    throw new Error("No schema found after reindex. Please check datasource permissions.");
  }
  const history = await buildRecentHistoryContext(input.conversationId, input.question);
  let datasourceNote = (
    await getEntityAnnotation({
      datasourceId: input.connectionId,
      entityType: "datasource",
      entityKey: "global_note",
    })
  )?.note ?? "";

  const evidence: Array<{ label: string; value: string }> = [];
  const traces: AnalysisPlanStep[] = [];
  const debugLogs: AnalysisDebugLog[] = [];
  const resultSets: Array<{ title: string; sql: string; rows: Array<Record<string, unknown>> }> = [];
  const triedSql = new Set<string>();
  let duplicateBlockCount = 0;
  let forceLightweightMode = false;
  let noteUpdatedInRun = false;
  let llmFinalSummary: string | null = null;
  let llmWantsChart = false;
  const runStartedAt = Date.now();
  const userExplicitlyAskedChart = shouldRequestChartFromQuestion(input.question);
  const pushDebugLog = (log: Omit<AnalysisDebugLog, "ts">) => {
    if (debugLogs.length >= 300) return;
    const keepFullLlmPayload = log.kind === "llm_request" || log.kind === "llm_response";
    debugLogs.push({
      ts: new Date().toISOString(),
      ...log,
      detail: log.detail ? trimLogText(log.detail, 2000) : undefined,
      payload: log.payload ? (keepFullLlmPayload ? log.payload : trimLogText(log.payload, 12000)) : undefined,
    });
  };

  await withTargetDb(input.uri, async (db) => {
    for (let stepIndex = 0; stepIndex < ANALYSIS_DEFAULTS.maxSqlPerRun; stepIndex++) {
      if (Date.now() - runStartedAt > ANALYSIS_DEFAULTS.runBudgetMs) {
        break;
      }

      const action = await planNextAction({
        question: input.question,
        dbKind: input.dbKind,
        entities: readyEntities,
        traces,
        evidence,
        stepIndex,
        datasourceNote,
        history,
        onDebugLog: pushDebugLog,
      });
      let guardedAction = guardPlannerAction(action, input.dbKind, input.question, readyEntities, stepIndex);

      // 当兜底把“动作 JSON 字符串”塞进 final_answer.summary 时，尝试恢复为真实动作继续执行。
      if (guardedAction.action === "final_answer") {
        const recovered = parsePlannerAction(guardedAction.summary);
        if (recovered && recovered.action !== "final_answer") {
          guardedAction = guardPlannerAction(recovered, input.dbKind, input.question, readyEntities, stepIndex);
        }
      }

      if (guardedAction.action === "final_answer") {
        llmWantsChart = guardedAction.showChart === true || (guardedAction.showChart !== false && userExplicitlyAskedChart);
        if (!isPlannerFallbackSummary(guardedAction.summary)) {
          llmFinalSummary = guardedAction.summary;
        }
        break;
      }

      if (guardedAction.action === "add_note") {
        const incoming = guardedAction.note.trim();
        if (!incoming) continue;
        const before = datasourceNote;
        const note = incoming;
        await upsertEntityAnnotation({
          datasourceId: input.connectionId,
          entityType: "datasource",
          entityKey: "global_note",
          note,
        });
        datasourceNote = note;
        const changed = note !== before;
        noteUpdatedInRun = noteUpdatedInRun || changed;
        const evidenceItem = {
          label: guardedAction.title || "更新数据库备注",
          value: changed ? `备注已更新：${incoming.slice(0, 180)}` : `备注未变化`,
        };
        evidence.push(evidenceItem);
        await input.onProgress?.({
          phase: "planning",
          step: stepIndex + 1,
          maxSteps: ANALYSIS_DEFAULTS.maxSqlPerRun,
          title: guardedAction.title,
          detail: guardedAction.title,
        });
        await input.onEvent?.("planning", stepIndex + 1, {
          title: guardedAction.title,
          detail: guardedAction.rationale,
        });
        await input.onEvent?.("evidence", stepIndex + 1, evidenceItem);

        // 对“备注指令类”问题，写入一次备注后立即收敛，避免重复 add_note 循环
        if (isNoteInstructionQuestion(input.question) || (!changed && noteUpdatedInRun)) {
          llmFinalSummary = changed
            ? "已记录该数据库备注，后续分析会按此前提执行。"
            : "该备注已存在，后续分析会按此前提执行。";
          break;
        }
        continue;
      }

      await input.onProgress?.({
        phase: "executing",
        step: stepIndex + 1,
        maxSteps: ANALYSIS_DEFAULTS.maxSqlPerRun,
        title: guardedAction.title,
        detail: guardedAction.title,
      });
      await input.onEvent?.("sql_started", stepIndex + 1, {
        title: guardedAction.title,
        sql: guardedAction.sql,
      });
      pushDebugLog({
        kind: "sql_started",
        title: guardedAction.title,
        payload: guardedAction.sql,
        detail: guardedAction.rationale,
      });

      const safety = ensureSafeReadOnlySql(guardedAction.sql);
      if (!safety.ok) {
        const item: AnalysisPlanStep = {
          id: randomUUID(),
          title: guardedAction.title,
          sql: guardedAction.sql,
          rationale: guardedAction.rationale,
          status: "blocked",
          reason: safety.reason,
          durationMs: 0,
          rowCount: 0,
        };
        traces.push(item);
        await insertSqlAuditLog({
          id: randomUUID(),
          runId: input.runId,
          sqlText: guardedAction.sql,
          durationMs: 0,
          rowCount: 0,
          status: "blocked",
          reason: safety.reason,
        });

        const evidenceItem = {
          label: guardedAction.title,
          value: `SQL 被安全策略拦截：${safety.reason}`,
        };
        evidence.push(evidenceItem);
        pushDebugLog({
          kind: "sql_blocked",
          title: guardedAction.title,
          detail: safety.reason,
          payload: guardedAction.sql,
        });
        await input.onEvent?.("sql_blocked", stepIndex + 1, { trace: item });
        await input.onEvent?.("evidence", stepIndex + 1, evidenceItem);
        continue;
      }

      const dedupeKey = safety.normalizedSql.toLowerCase();
      if (triedSql.has(dedupeKey)) {
        duplicateBlockCount += 1;
        const item: AnalysisPlanStep = {
          id: randomUUID(),
          title: guardedAction.title,
          sql: safety.normalizedSql,
          rationale: guardedAction.rationale,
          status: "blocked",
          reason: "Duplicate SQL detected",
          durationMs: 0,
          rowCount: 0,
        };
        traces.push(item);

        const evidenceItem = {
          label: guardedAction.title,
          value:
            duplicateBlockCount >= 2
              ? "SQL 与之前步骤重复多次，已跳过；请停止重复查结构，改为基于已知列查询业务数据。"
              : "SQL 与之前步骤重复，已跳过；LLM 需要换一个分析角度。",
        };
        evidence.push(evidenceItem);
        pushDebugLog({
          kind: "sql_blocked",
          title: guardedAction.title,
          detail: "Duplicate SQL detected",
          payload: safety.normalizedSql,
        });
        await input.onEvent?.("sql_blocked", stepIndex + 1, { trace: item });
        await input.onEvent?.("evidence", stepIndex + 1, evidenceItem);
        continue;
      }

      const strategyBlockReason = getSqlStrategyBlockReason(safety.normalizedSql, input.dbKind, forceLightweightMode);
      if (strategyBlockReason) {
        const item: AnalysisPlanStep = {
          id: randomUUID(),
          title: guardedAction.title,
          sql: safety.normalizedSql,
          rationale: guardedAction.rationale,
          status: "blocked",
          reason: strategyBlockReason,
          durationMs: 0,
          rowCount: 0,
        };
        traces.push(item);
        await insertSqlAuditLog({
          id: randomUUID(),
          runId: input.runId,
          sqlText: safety.normalizedSql,
          durationMs: 0,
          rowCount: 0,
          status: "blocked",
          reason: strategyBlockReason,
        });
        const evidenceItem = {
          label: guardedAction.title,
          value: `SQL 被策略拦截：${strategyBlockReason}`,
        };
        evidence.push(evidenceItem);
        pushDebugLog({
          kind: "sql_blocked",
          title: guardedAction.title,
          detail: strategyBlockReason,
          payload: safety.normalizedSql,
        });
        await input.onEvent?.("sql_blocked", stepIndex + 1, { trace: item });
        await input.onEvent?.("evidence", stepIndex + 1, evidenceItem);
        continue;
      }
      triedSql.add(dedupeKey);

      await insertSqlStep(randomUUID(), input.runId, guardedAction.title, safety.normalizedSql, guardedAction.rationale);

      const start = Date.now();
      try {
        const rows = await db.query<Record<string, unknown>>(safety.normalizedSql);
        duplicateBlockCount = 0;
        const duration = Date.now() - start;
        await insertSqlAuditLog({
          id: randomUUID(),
          runId: input.runId,
          sqlText: safety.normalizedSql,
          durationMs: duration,
          rowCount: rows.length,
          status: "ok",
        });

        const item: AnalysisPlanStep = {
          id: randomUUID(),
          title: guardedAction.title,
          sql: safety.normalizedSql,
          rationale: guardedAction.rationale,
          status: "ok",
          durationMs: duration,
          rowCount: rows.length,
        };
        traces.push(item);

        const evidenceItem = {
          label: guardedAction.title,
          value: buildEvidenceValue(safety.normalizedSql, rows),
        };
        evidence.push(evidenceItem);
        pushDebugLog({
          kind: "sql_result",
          title: guardedAction.title,
          detail: `rows=${rows.length}; durationMs=${duration}`,
          payload: JSON.stringify(rows.slice(0, 20)),
        });
        resultSets.push({
          title: guardedAction.title,
          sql: safety.normalizedSql,
          rows,
        });

        await input.onEvent?.("sql_finished", stepIndex + 1, {
          trace: item,
        });
        await input.onEvent?.("evidence", stepIndex + 1, evidenceItem);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        const item: AnalysisPlanStep = {
          id: randomUUID(),
          title: guardedAction.title,
          sql: safety.normalizedSql,
          rationale: guardedAction.rationale,
          status: "error",
          reason,
          durationMs: Date.now() - start,
          rowCount: 0,
        };
        traces.push(item);
        await insertSqlAuditLog({
          id: randomUUID(),
          runId: input.runId,
          sqlText: safety.normalizedSql,
          durationMs: Date.now() - start,
          rowCount: 0,
          status: "error",
          reason,
        });

        const evidenceItem = {
          label: guardedAction.title,
          value: `SQL 执行报错：${reason}`,
        };
        evidence.push(evidenceItem);
        pushDebugLog({
          kind: "sql_error",
          title: guardedAction.title,
          detail: reason,
          payload: safety.normalizedSql,
        });
        if (isTimeoutError(reason)) {
          forceLightweightMode = true;
          evidence.push({
            label: `${guardedAction.title}（性能降级提示）`,
            value: "检测到查询超时。后续请避免 JOIN，改为分步小查询（先单表过滤拿主键，再按主键查关联表）。",
          });
          const timeoutHint = buildTimeoutOptimizationHint(safety.normalizedSql, readyEntities);
          if (timeoutHint) {
            evidence.push({
              label: `${guardedAction.title}（DBA优化建议）`,
              value: timeoutHint,
            });
          }
        }
        const unknownColumnHint = buildUnknownColumnHint(reason, safety.normalizedSql, readyEntities);
        if (unknownColumnHint) {
          evidence.push({
            label: `${guardedAction.title}（列名纠偏提示）`,
            value: unknownColumnHint,
          });
        }
        await input.onEvent?.("sql_error", stepIndex + 1, { trace: item });
        await input.onEvent?.("evidence", stepIndex + 1, evidenceItem);
      }
    }
  });

  const rawSummary = llmFinalSummary ?? (await synthesizeFinalSummary(input.question, evidence, traces, datasourceNote, pushDebugLog));
  const summary = normalizeFinalSummaryText(rawSummary);
  const chart = llmWantsChart ? await buildInsightChart(input.question, summary, resultSets, pushDebugLog) : undefined;
  const resultTable = shouldIncludeResultTable(input.question) ? buildResultTable(resultSets) : undefined;

  return {
    summary,
    keyEvidence: evidence,
    analysisMethod: "LLM 每轮决定下一步 SQL，后端执行只读查询并回传证据，直到可直接输出结论。",
    chartSuggestion: chart ? undefined : "可使用按时间的折线图 + 关键维度柱状图。",
    chart,
    resultTable,
    sqlTraces: traces,
    debugLogs,
  };
}

async function planNextAction(input: {
  question: string;
  dbKind: DbKind;
  entities: Array<{ tableName: string; columns: Array<{ name: string; dataType: string }> }>;
  traces: AnalysisPlanStep[];
  evidence: Array<{ label: string; value: string }>;
  stepIndex: number;
  datasourceNote: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  onDebugLog?: (log: Omit<AnalysisDebugLog, "ts">) => void;
}): Promise<PlannerAction> {
  const allTableNames = input.entities.map((e) => e.tableName).sort((a, b) => a.localeCompare(b));
  const plannerSystemPrompt = buildPlannerStage1SystemPrompt();
  const plannerUserContext = buildPlannerStage1UserContext({
    question: input.question,
    dbKind: input.dbKind,
    stepIndex: input.stepIndex,
    datasourceNote: input.datasourceNote,
    history: input.history,
    allTableNames,
    entitiesCount: input.entities.length,
    traces: input.traces,
    evidence: input.evidence,
  });
  const maxFormatFailures = 3;
  let failures = 0;
  let lastRaw = "";

  while (failures <= maxFormatFailures) {
    input.onDebugLog?.({
      kind: "llm_request",
      title: "planner",
      detail: failures === 0 ? "initial" : `retry_${failures}`,
      payload: JSON.stringify([
        { role: "system", content: plannerSystemPrompt },
        { role: "user", content: failures === 0 ? plannerUserContext : buildPlannerStage1RetryContext(plannerUserContext, failures, lastRaw) },
      ]),
    });
    const llmRaw = await callLlm([
      {
        role: "system",
        content: plannerSystemPrompt,
      },
      {
        role: "user",
        content:
          failures === 0
            ? plannerUserContext
            : buildPlannerStage1RetryContext(plannerUserContext, failures, lastRaw),
      },
    ]);

    lastRaw = (llmRaw ?? "").trim();
    input.onDebugLog?.({
      kind: "llm_response",
      title: "planner",
      detail: failures === 0 ? "initial" : `retry_${failures}`,
      payload: lastRaw,
    });
    const decision = parsePlannerDecision(lastRaw);
    if (decision) {
      if (decision.action === "run_sql") {
        const requestedTables = normalizeSelectedTables(decision.tables, allTableNames);
        const fallbackTables = selectSchemaBriefForQuestion(input.question, input.entities)
          .slice(0, 6)
          .map((e) => e.tableName);
        const selectedTableNames = requestedTables.length ? requestedTables : fallbackTables;
        const selectedSchema = input.entities
          .filter((e) => selectedTableNames.includes(e.tableName))
          .map((e) => ({
            tableName: e.tableName,
            columns: e.columns.map((c) => ({ name: c.name, dataType: c.dataType })),
          }));
        if (!selectedSchema.length) {
          return {
            action: "final_answer",
            summary: lastRaw,
          };
        }
        return generateSqlFromSelectedTables({
          question: input.question,
          dbKind: input.dbKind,
          stepIndex: input.stepIndex,
          datasourceNote: input.datasourceNote,
          history: input.history,
          traces: input.traces,
          evidence: input.evidence,
          selectedSchema,
          seedTitle: decision.title,
          seedRationale: decision.rationale,
          onDebugLog: input.onDebugLog,
        });
      }
      return decision;
    }
    input.onDebugLog?.({
      kind: "system",
      title: "planner_parse_failed",
      detail: `failure_${failures + 1}`,
      payload: lastRaw,
    });
    failures += 1;
  }

  return {
    action: "final_answer",
    summary: lastRaw,
  };
}

async function generateSqlFromSelectedTables(input: {
  question: string;
  dbKind: DbKind;
  stepIndex: number;
  datasourceNote: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  traces: AnalysisPlanStep[];
  evidence: Array<{ label: string; value: string }>;
  selectedSchema: Array<{ tableName: string; columns: Array<{ name: string; dataType: string }> }>;
  seedTitle: string;
  seedRationale: string;
  onDebugLog?: (log: Omit<AnalysisDebugLog, "ts">) => void;
}): Promise<PlannerAction> {
  const sqlWriterSystemPrompt = buildSqlWriterSystemPrompt();
  const sqlWriterUserContext = buildSqlWriterUserContext({
    question: input.question,
    dbKind: input.dbKind,
    stepIndex: input.stepIndex,
    datasourceNote: input.datasourceNote,
    history: input.history,
    selectedSchema: input.selectedSchema,
    seedTitle: input.seedTitle,
    seedRationale: input.seedRationale,
    traces: input.traces,
    evidence: input.evidence,
  });

  const maxFormatFailures = 3;
  let failures = 0;
  let lastRaw = "";

  while (failures <= maxFormatFailures) {
    input.onDebugLog?.({
      kind: "llm_request",
      title: "sql_writer",
      detail: failures === 0 ? "initial" : `retry_${failures}`,
      payload: JSON.stringify([
        { role: "system", content: sqlWriterSystemPrompt },
        { role: "user", content: failures === 0 ? sqlWriterUserContext : buildSqlWriterRetryContext(sqlWriterUserContext, failures, lastRaw) },
      ]),
    });

    const llmRaw = await callLlm([
      { role: "system", content: sqlWriterSystemPrompt },
      {
        role: "user",
        content:
          failures === 0
            ? sqlWriterUserContext
            : buildSqlWriterRetryContext(sqlWriterUserContext, failures, lastRaw),
      },
    ]);

    lastRaw = (llmRaw ?? "").trim();
    input.onDebugLog?.({
      kind: "llm_response",
      title: "sql_writer",
      detail: failures === 0 ? "initial" : `retry_${failures}`,
      payload: lastRaw,
    });

    const parsed = parsePlannerAction(lastRaw);
    if (parsed?.action === "run_sql") {
      return parsed;
    }

    input.onDebugLog?.({
      kind: "system",
      title: "sql_writer_parse_failed",
      detail: `failure_${failures + 1}`,
      payload: lastRaw,
    });
    failures += 1;
  }

  return {
    action: "final_answer",
    summary: lastRaw,
  };
}

function parsePlannerAction(text: string): PlannerAction | null {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    const obj = tryParsePlannerJson(candidate);
    if (!obj) continue;
    if (obj.action === "final_answer" && typeof obj.summary === "string" && obj.summary.trim()) {
      return {
        action: "final_answer",
        summary: obj.summary.trim(),
        showChart: parseShowChartFlag(obj),
      };
    }
    if (
      obj.action === "add_note" &&
      typeof obj.note === "string" &&
      obj.note.trim()
    ) {
      return {
        action: "add_note",
        title: typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : "更新数据库备注",
        rationale: typeof obj.rationale === "string" && obj.rationale.trim() ? obj.rationale.trim() : "沉淀业务知识",
        note: obj.note.trim(),
      };
    }
    if (
      obj.action === "run_sql" &&
      typeof obj.title === "string" &&
      typeof obj.rationale === "string" &&
      typeof obj.sql === "string"
    ) {
      return {
        action: "run_sql",
        title: obj.title.trim() || "SQL 分析步骤",
        rationale: obj.rationale.trim() || "按问题继续取证",
        sql: sanitizeSql(obj.sql),
      };
    }
  }
  const recovered = recoverPlannerActionFromLooseText(text);
  if (recovered) return recovered;
  return null;
}

function parsePlannerDecision(text: string): PlannerDecision | null {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    const obj = tryParsePlannerJson(candidate) as Record<string, unknown> | null;
    if (!obj || typeof obj.action !== "string") continue;
    if (obj.action === "final_answer" && typeof obj.summary === "string" && obj.summary.trim()) {
      return {
        action: "final_answer",
        summary: obj.summary.trim(),
        showChart: parseShowChartFlag(obj),
      };
    }
    if (obj.action === "add_note" && typeof obj.note === "string" && obj.note.trim()) {
      return {
        action: "add_note",
        title: typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : "更新数据库备注",
        rationale: typeof obj.rationale === "string" && obj.rationale.trim() ? obj.rationale.trim() : "沉淀业务知识",
        note: obj.note.trim(),
      };
    }
    if (obj.action === "run_sql") {
      const tablesRaw = Array.isArray(obj.tables) ? obj.tables : [];
      const tables = tablesRaw
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter((t) => t.length > 0);
      return {
        action: "run_sql",
        title: typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : "SQL 分析步骤",
        rationale: typeof obj.rationale === "string" && obj.rationale.trim() ? obj.rationale.trim() : "按问题继续取证",
        tables,
      };
    }
  }
  const recovered = recoverPlannerDecisionFromLooseText(text);
  if (recovered) return recovered;
  return null;
}

function recoverPlannerDecisionFromLooseText(raw: string): PlannerDecision | null {
  const text = normalizeQuotes(raw);
  const action = extractLooseJsonStringField(text, "action");
  if (!action) return null;

  if (action === "final_answer") {
    const summary = extractLooseFinalAnswerSummary(text);
    if (!summary?.trim()) return null;
    return {
      action: "final_answer",
      summary: summary.trim(),
      showChart: extractLooseJsonBooleanField(text, "show_chart") ?? extractLooseJsonBooleanField(text, "showChart"),
    };
  }

  if (action === "add_note") {
    const note = extractLooseJsonStringField(text, "note");
    if (!note?.trim()) return null;
    return {
      action: "add_note",
      title: extractLooseJsonStringField(text, "title")?.trim() || "更新数据库备注",
      rationale: extractLooseJsonStringField(text, "rationale")?.trim() || "沉淀业务知识",
      note: note.trim(),
    };
  }

  return null;
}

function normalizeSelectedTables(tables: string[], allTableNames: string[]) {
  const all = new Set(allTableNames);
  const out: string[] = [];
  for (const t of tables) {
    if (!all.has(t)) continue;
    if (out.includes(t)) continue;
    out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

function recoverPlannerActionFromLooseText(raw: string): PlannerAction | null {
  const text = normalizeQuotes(raw);
  const action = extractLooseJsonStringField(text, "action");
  if (!action) return null;

  if (action === "final_answer") {
    const summary = extractLooseFinalAnswerSummary(text);
    if (summary?.trim()) {
      return {
        action: "final_answer",
        summary: summary.trim(),
        showChart: extractLooseJsonBooleanField(text, "show_chart") ?? extractLooseJsonBooleanField(text, "showChart"),
      };
    }
    return null;
  }

  if (action === "add_note") {
    const note = extractLooseJsonStringField(text, "note");
    if (!note?.trim()) return null;
    const title = extractLooseJsonStringField(text, "title")?.trim() || "更新数据库备注";
    const rationale = extractLooseJsonStringField(text, "rationale")?.trim() || "沉淀业务知识";
    return {
      action: "add_note",
      title,
      rationale,
      note: note.trim(),
    };
  }

  if (action === "run_sql") {
    const sql = extractLooseJsonStringField(text, "sql");
    if (!sql?.trim()) return null;
    const title = extractLooseJsonStringField(text, "title")?.trim() || "SQL 分析步骤";
    const rationale = extractLooseJsonStringField(text, "rationale")?.trim() || "按问题继续取证";
    return {
      action: "run_sql",
      title,
      rationale,
      sql: sanitizeSql(sql),
    };
  }
  return null;
}

async function synthesizeFinalSummary(
  question: string,
  evidence: Array<{ label: string; value: string }>,
  traces: AnalysisPlanStep[],
  datasourceNote: string,
  onDebugLog?: (log: Omit<AnalysisDebugLog, "ts">) => void,
) {
  try {
    const reqPayload = buildSummaryUserPayload(question, evidence, traces, datasourceNote);
    onDebugLog?.({
      kind: "llm_request",
      title: "summary",
      payload: reqPayload,
    });
    const out = await callLlm([
      {
        role: "system",
        content: buildSummarySystemPrompt(),
      },
      {
        role: "user",
        content: reqPayload,
      },
    ]);
    onDebugLog?.({
      kind: "llm_response",
      title: "summary",
      payload: out,
    });
    const summary = out.trim();
    if (summary) return summary;
  } catch {
    // ignore
  }

  if (evidence.length > 0) {
    const lines = evidence.slice(0, 3).map((e) => `- ${e.label}: ${e.value}`).join("\n");
    return `基于当前取证，先给出关键结果：\n${lines}\n可继续补充更明确的口径（时间范围/指标定义）以获得更精确结论。`;
  }
  return "当前未拿到有效证据，请重试并补充更明确的口径（时间范围、指标定义、目标对象）。";
}

async function buildInsightChart(
  question: string,
  summary: string,
  resultSets: Array<{ title: string; sql: string; rows: Array<Record<string, unknown>> }>,
  onDebugLog?: (log: Omit<AnalysisDebugLog, "ts">) => void,
): Promise<InsightChart | undefined> {
  const candidates = resultSets
    .map((s) => ({
      title: s.title,
      sql: s.sql,
      rowCount: s.rows.length,
      columns: Object.keys(s.rows[0] ?? {}),
      sample: s.rows.slice(0, 50),
    }))
    .filter((s) => s.rowCount > 0 && s.columns.length >= 2);
  if (!candidates.length) return undefined;

  try {
    const reqPayload = buildChartPlannerUserPayload(question, summary, candidates);
    onDebugLog?.({
      kind: "llm_request",
      title: "chart_planner",
      payload: reqPayload,
    });
    const raw = await callLlm([
      {
        role: "system",
        content: buildChartPlannerSystemPrompt(),
      },
      {
        role: "user",
        content: reqPayload,
      },
    ]);
    onDebugLog?.({
      kind: "llm_response",
      title: "chart_planner",
      payload: raw,
    });
    const parsed = parseChartAction(raw);
    if (!parsed || parsed.action === "none") return undefined;
    if (!validateChart(parsed.chart)) return undefined;
    return parsed.chart;
  } catch {
    return undefined;
  }
}

function parseChartAction(text: string): { action: "none" } | { action: "chart"; chart: InsightChart } | null {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    const obj = tryParseChartJson(candidate);
    if (!obj) continue;
    if (obj.action === "none") return { action: "none" };
    if (obj.action === "chart" && obj.chart) return { action: "chart", chart: obj.chart };
  }
  return null;
}

function tryParseChartJson(input: string): { action?: string; chart?: InsightChart } | null {
  const cleaned = cleanupJsonCandidate(input);
  const attempts = [
    cleaned,
    cleaned.replace(/,\s*([}\]])/g, "$1"),
  ];
  for (const text of attempts) {
    try {
      return JSON.parse(text) as { action?: string; chart?: InsightChart };
    } catch {
      // try next
    }
  }
  return null;
}

function validateChart(chart: InsightChart) {
  if (!chart || !Array.isArray(chart.data) || chart.data.length === 0) return false;
  if (!["line", "bar", "pie"].includes(chart.type)) return false;
  if (chart.type === "pie") {
    return typeof chart.labelKey === "string" && typeof chart.valueKey === "string";
  }
  return typeof chart.xKey === "string" && Array.isArray(chart.yKeys) && chart.yKeys.length > 0;
}

function shouldIncludeResultTable(question: string) {
  const q = question.toLowerCase();
  return /列出|全部|完整|名单|清单|list|show all|all users/.test(q);
}

function shouldRequestChartFromQuestion(question: string) {
  const q = question.toLowerCase();
  return /图表|可视化|画图|饼图|柱状图|折线图|line chart|bar chart|pie chart|chart/.test(q);
}

function isPlannerFallbackSummary(summary: string) {
  return /当前无法从模型获取有效下一步分析指令/.test(summary);
}

function buildResultTable(resultSets: Array<{ title: string; sql: string; rows: Array<Record<string, unknown>> }>) {
  const target = [...resultSets].reverse().find((s) => s.rows.length > 0);
  if (!target) return undefined;
  return {
    title: target.title,
    columns: Object.keys(target.rows[0] ?? {}),
    rows: target.rows,
  };
}

function stripCodeFence(text: string) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function sanitizeSql(sql: string) {
  return sql.replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function extractFirstJsonObject(text: string) {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function collectJsonCandidates(raw: string) {
  const trimmed = raw.trim();
  const normalized = normalizeQuotes(raw).trim();
  const out: string[] = [];
  const rawFenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (rawFenced?.[1]) out.push(rawFenced[1].trim());
  const rawStripped = stripCodeFence(trimmed).trim();
  if (rawStripped) out.push(rawStripped);
  const rawFirstObj = extractFirstJsonObject(rawStripped);
  if (rawFirstObj) out.push(rawFirstObj);
  const rawFirstObjDirect = extractFirstJsonObject(trimmed);
  if (rawFirstObjDirect) out.push(rawFirstObjDirect);

  // 回退候选：容忍模型将 JSON 键名输出为中文引号等情况。
  const fenced = normalized.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) out.push(fenced[1].trim());
  const stripped = stripCodeFence(normalized).trim();
  if (stripped) out.push(stripped);
  const firstObj = extractFirstJsonObject(stripped);
  if (firstObj) out.push(firstObj);
  const firstObjRaw = extractFirstJsonObject(normalized);
  if (firstObjRaw) out.push(firstObjRaw);
  return [...new Set(out.filter((x) => x.length > 0))];
}

function tryParsePlannerJson(input: string): Partial<PlannerAction> | null {
  const cleaned = cleanupJsonCandidate(input);
  const attempts = [
    cleaned,
    cleaned.replace(/,\s*([}\]])/g, "$1"), // remove trailing commas
  ];
  for (const text of attempts) {
    try {
      return JSON.parse(text) as Partial<PlannerAction>;
    } catch {
      // try next
    }
  }
  return null;
}

function cleanupJsonCandidate(input: string) {
  return input
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^\s*json\s*/i, "")
    .trim();
}

function normalizeQuotes(text: string) {
  return text.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'");
}

function normalizeFinalSummaryText(text: string) {
  const raw = (text ?? "").trim();
  if (!raw) return raw;

  const parsed = parsePlannerAction(raw);
  if (parsed?.action === "final_answer") {
    return parsed.summary.trim();
  }

  const looseSummary = extractLooseFinalAnswerSummary(raw);
  if (looseSummary) return looseSummary.trim();
  return raw;
}

function extractLooseFinalAnswerSummary(raw: string) {
  const actionMatch = raw.match(/"action"\s*:\s*"final_answer"/i);
  if (!actionMatch) return null;
  const summaryStart = raw.search(/"summary"\s*:\s*/i);
  if (summaryStart < 0) return null;

  const prefixMatch = raw.slice(summaryStart).match(/"summary"\s*:\s*/i);
  if (!prefixMatch) return null;
  const start = summaryStart + prefixMatch[0].length;
  const tail = raw.slice(start).trim();
  if (!tail) return null;

  // 优先按 JSON 字符串边界提取；若模型引号不规范，退化为“吃到结尾对象前”。
  if (tail.startsWith("\"")) {
    const endQuoteIndex = findLikelyClosingQuoteIndex(tail);
    const quoted = endQuoteIndex > 0 ? tail.slice(1, endQuoteIndex) : tail.slice(1);
    return unescapeLooseJsonString(quoted).trim() || null;
  }

  return tail
    .replace(/}\s*$/, "")
    .replace(/,\s*$/, "")
    .trim() || null;
}

function findLikelyClosingQuoteIndex(text: string) {
  let escaped = false;
  for (let i = text.length - 1; i >= 1; i--) {
    const ch = text[i];
    if (ch !== "\"") continue;
    let slashCount = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) slashCount += 1;
    escaped = slashCount % 2 === 1;
    if (!escaped) return i;
  }
  return -1;
}

function unescapeLooseJsonString(value: string) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function extractLooseJsonStringField(raw: string, fieldName: string) {
  const fieldMatch = new RegExp(`"${fieldName}"\\s*:\\s*"`, "i").exec(raw);
  if (!fieldMatch || fieldMatch.index < 0) return null;
  const start = fieldMatch.index + fieldMatch[0].length;
  let escaped = false;
  let out = "";
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      if (ch === "n") out += "\n";
      else if (ch === "t") out += "\t";
      else out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") return out;
    out += ch;
  }
  return out || null;
}

function extractLooseJsonBooleanField(raw: string, fieldName: string) {
  const fieldMatch = new RegExp(`"${fieldName}"\\s*:\\s*(true|false)`, "i").exec(raw);
  if (!fieldMatch?.[1]) return undefined;
  return fieldMatch[1].toLowerCase() === "true";
}

function parseShowChartFlag(obj: unknown) {
  if (!obj || typeof obj !== "object") return undefined;
  const record = obj as Record<string, unknown>;
  if (typeof record.show_chart === "boolean") return record.show_chart;
  if (typeof record.showChart === "boolean") return record.showChart;
  return undefined;
}

function trimLogText(text: string, maxLen: number) {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}... [truncated ${text.length - maxLen} chars]`;
}

function summarizeTitle(question: string) {
  const clean = question.replace(/\s+/g, " ").trim();
  return clean.length <= 36 ? clean : `${clean.slice(0, 36)}...`;
}

function mapPhaseToEvent(phase: ProgressState["phase"]): RunEvent["eventType"] {
  if (phase === "planning") return "planning";
  if (phase === "executing") return "planning";
  if (phase === "completed") return "final";
  return "failed";
}

function guardPlannerAction(
  action: PlannerAction,
  dbKind: DbKind,
  question: string,
  entities: Array<{ tableName: string; columns: Array<{ name: string; dataType: string }> }>,
  stepIndex: number,
): PlannerAction {
  void question;
  void entities;
  void stepIndex;
  if (action.action !== "run_sql") return action;
  if (dbKind !== "mysql") return action;

  const raw = action.sql.trim().replace(/;+$/g, "");
  const describeMatch = raw.match(/^describe\s+`?([a-zA-Z0-9_]+)`?$/i);
  if (describeMatch?.[1]) {
    const table = describeMatch[1];
    return {
      ...action,
      title: action.title || `inspect_${table}_columns`,
      rationale: "MySQL 结构查询改写为 INFORMATION_SCHEMA 以满足只读 SELECT 约束。",
      sql: `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION LIMIT 200`,
    };
  }

  const showColumnsMatch = raw.match(/^show\s+columns\s+from\s+`?([a-zA-Z0-9_]+)`?$/i);
  if (showColumnsMatch?.[1]) {
    const table = showColumnsMatch[1];
    return {
      ...action,
      title: action.title || `inspect_${table}_columns`,
      rationale: "MySQL 结构查询改写为 INFORMATION_SCHEMA 以满足只读 SELECT 约束。",
      sql: `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION LIMIT 200`,
    };
  }

  return action;
}

function isUserRelatedName(name: string) {
  const n = name.toLowerCase();
  return /user|users|用户|account|member|profile|customer/.test(n);
}

function selectSchemaBriefForQuestion(
  question: string,
  entities: Array<{ tableName: string; columns: Array<{ name: string; dataType: string }> }>,
) {
  const q = question.toLowerCase();
  const tokens = q.split(/[^a-z0-9_\u4e00-\u9fa5]+/).filter((t) => t.length >= 2);
  const scored = entities.map((e) => {
    const tn = e.tableName.toLowerCase();
    let score = 0;
    if (q.includes(tn)) score += 20;
    if (isUserRelatedName(tn) && /user|users|用户|账号|账户|account|member|profile|customer/.test(q)) score += 15;
    for (const t of tokens) {
      if (tn.includes(t)) score += 4;
    }
    for (const c of e.columns) {
      const cn = c.name.toLowerCase();
      for (const t of tokens) {
        if (cn.includes(t)) score += 1;
      }
    }
    return { entity: e, score };
  });

  scored.sort((a, b) => b.score - a.score || a.entity.tableName.localeCompare(b.entity.tableName));

  const topRelevant = scored.slice(0, 40).map((x) => x.entity);
  const mustIncludeUsers = entities.filter((e) => isUserRelatedName(e.tableName));

  const merged = [...mustIncludeUsers, ...topRelevant];
  const deduped: typeof entities = [];
  const seen = new Set<string>();
  for (const e of merged) {
    if (seen.has(e.tableName)) continue;
    seen.add(e.tableName);
    deduped.push(e);
    if (deduped.length >= 60) break;
  }
  return deduped;
}

async function buildRecentHistoryContext(
  conversationId: string,
  currentQuestion: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const rows = await listMessages(conversationId);
  const normalizedQuestion = currentQuestion.trim();
  const filtered: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of rows) {
    if (m.role === "user" || m.role === "assistant") {
      filtered.push({ role: m.role, content: m.content });
    }
  }

  // 去掉当前轮刚写入的用户问题，避免与“用户问题”字段重复
  if (filtered.length > 0) {
    const last = filtered[filtered.length - 1];
    if (last.role === "user" && last.content.trim() === normalizedQuestion) {
      filtered.pop();
    }
  }

  return filtered.slice(-4).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.role === "user" ? m.content : summarizeAssistantMessage(m.content),
  }));
}

function summarizeAssistantMessage(content: string) {
  return content.trim();
}

function isNoteInstructionQuestion(question: string) {
  const q = question.toLowerCase();
  return /备注|记住|记下来|保存|设为|以后|后续|不要用|别用|排除|无关/.test(q);
}

function getSqlStrategyBlockReason(sql: string, dbKind: DbKind, forceLightweightMode: boolean) {
  const lower = sql.toLowerCase();
  const joinCount = countMatches(lower, /\bjoin\b/g);
  const limitCount = countMatches(lower, /\blimit\b/g);
  const hasUnion = /\bunion\b/.test(lower);

  if (/\border\s+by\s+rand\s*\(/.test(lower)) {
    return "请避免 ORDER BY RAND()，开销过高。";
  }
  if (/\bcross\s+join\b/.test(lower)) {
    return "请避免 CROSS JOIN，优先更窄的关联条件。";
  }
  if (forceLightweightMode && joinCount > 0) {
    return "上一条查询已超时，已切换轻量模式：请先查单表并缩小范围，再分步关联。";
  }
  if (joinCount > 2) {
    return "当前策略要求轻量查询，单步 JOIN 不超过 2 个；请拆成多步 SQL。";
  }
  if (dbKind === "mysql" && hasUnion && limitCount >= 2 && !/\(\s*select/.test(lower)) {
    return "MySQL 中 UNION 的分支 LIMIT 写法不稳定，请拆成多步查询或使用子查询括号。";
  }
  return null;
}

function isTimeoutError(reason: string) {
  return /maximum statement execution time exceeded|statement timeout|query execution was interrupted|timeout/i.test(reason);
}

function buildTimeoutOptimizationHint(
  sql: string,
  entities: Array<{ tableName: string; columns: Array<{ name: string; dataType: string }> }>,
) {
  const tableNames = extractLikelyTableNamesFromSql(sql);
  if (!tableNames.length) {
    return "建议改为轻量 SQL：先查最少列 + 更小 LIMIT，并优先按主键倒序取样，再逐步补充筛选条件。";
  }
  const tableMap = new Map(entities.map((e) => [e.tableName.toLowerCase(), e]));
  const primary = tableMap.get(tableNames[0].toLowerCase());
  if (!primary) {
    return `建议先探测索引（information_schema.statistics），再查询表 ${tableNames[0]}，优先索引列排序/过滤。`;
  }
  const columnNamesLower = new Set(primary.columns.map((c) => c.name.toLowerCase()));
  const idCandidate = ["id", `${primary.tableName.toLowerCase()}_id`].find((c) => columnNamesLower.has(c));
  const hasDeletedAt = columnNamesLower.has("deleted_at");

  const tips: string[] = [];
  if (idCandidate) {
    tips.push(`表 ${primary.tableName} 可优先用 ${idCandidate} DESC + LIMIT 做最近样本提取`);
  } else {
    tips.push(`表 ${primary.tableName} 建议先查 information_schema.statistics 确认可用索引列`);
  }
  tips.push("先只取必要列（避免大文本字段）并控制 LIMIT（如 50/100）");
  if (hasDeletedAt) {
    tips.push("deleted_at 条件若非强业务必需，可先去掉验证路径，再做二次过滤");
  }
  return tips.join("；");
}

function countMatches(text: string, pattern: RegExp) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function buildEvidenceValue(sql: string, rows: Array<Record<string, unknown>>) {
  const lower = sql.toLowerCase();
  const first = rows[0] ?? {};
  const hasColumnName = Object.keys(first).some((k) => k.toLowerCase() === "column_name");
  const isColumnMeta = lower.includes("information_schema.columns") && hasColumnName;
  if (isColumnMeta) {
    const names = rows
      .map((r) => r.COLUMN_NAME ?? r.column_name)
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    const uniq = [...new Set(names)];
    return `columns=${uniq.length}; names=${uniq.slice(0, 80).join(", ")}`;
  }
  return `rows=${rows.length}; sample=${JSON.stringify(rows.slice(0, 3)).slice(0, 320)}`;
}

function buildUnknownColumnHint(
  reason: string,
  sql: string,
  entities: Array<{ tableName: string; columns: Array<{ name: string; dataType: string }> }>,
) {
  const lowerReason = reason.toLowerCase();
  if (!/unknown column|column .* does not exist|no such column/.test(lowerReason)) {
    return null;
  }

  const unknownColumn = extractUnknownColumnName(reason);
  const tableNames = extractLikelyTableNamesFromSql(sql);
  const tableMap = new Map(entities.map((e) => [e.tableName.toLowerCase(), e]));
  const matchedTables = tableNames
    .map((t) => tableMap.get(t.toLowerCase()))
    .filter((e): e is { tableName: string; columns: Array<{ name: string; dataType: string }> } => Boolean(e));
  const targets = matchedTables.length ? matchedTables : entities.slice(0, 3);
  const tableHints = targets
    .slice(0, 4)
    .map((table) => {
      const columns = table.columns.slice(0, 20).map((c) => c.name).join(", ");
      return `${table.tableName}: [${columns}]`;
    })
    .join(" | ");

  if (!tableHints) return null;
  if (unknownColumn) {
    return `字段「${unknownColumn}」不存在。请改用这些表中的真实列名：${tableHints}`;
  }
  return `检测到字段不存在错误。请改用这些表中的真实列名：${tableHints}`;
}

function extractUnknownColumnName(reason: string) {
  const mysql = reason.match(/Unknown column ['"`]([^'"`]+)['"`]/i);
  if (mysql?.[1]) return mysql[1];
  const postgres = reason.match(/column ["`]([^"`]+)["`] does not exist/i);
  if (postgres?.[1]) return postgres[1];
  const sqlite = reason.match(/no such column:\s*([a-zA-Z0-9_.]+)/i);
  if (sqlite?.[1]) return sqlite[1];
  return null;
}

function extractLikelyTableNamesFromSql(sql: string) {
  const names = new Set<string>();
  const regex = /\b(?:from|join)\s+([`"'[\]a-zA-Z0-9_.]+)/gi;
  for (const match of sql.matchAll(regex)) {
    const raw = match[1] ?? "";
    const cleaned = raw.replace(/[`"'\[\]]/g, "").trim();
    if (!cleaned) continue;
    const withoutSchema = cleaned.includes(".") ? cleaned.split(".").pop() ?? cleaned : cleaned;
    if (withoutSchema) names.add(withoutSchema);
  }
  return [...names];
}
