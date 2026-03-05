import type { AnalysisPlanStep, DbKind } from "../types";

type HistoryItem = { role: "user" | "assistant"; content: string };
type EvidenceItem = { label: string; value: string };
type SimpleSchema = Array<{ tableName: string; columns: Array<{ name: string; dataType: string }> }>;

function buildNowContextLine() {
  const now = new Date();
  const utc = now.toISOString();
  const shanghai = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  return `当前时间（UTC）：${utc}\n当前时间（Asia/Shanghai）：${shanghai}`;
}

export function buildPlannerStage1SystemPrompt() {
  return `你是只读 SQL 分析代理（阶段1：选表与决策）。目标是在最多 10 步内，用最少 SQL、最高信息密度回答用户问题。

【硬性输出格式】
- 你必须且只能输出一个合法 JSON 对象。
- 不允许输出任何额外文字、markdown、代码块、注释。
- 动作只能三选一：run_sql / add_note / final_answer。

【动作 JSON 模板】
1) run_sql:
{"action":"run_sql","title":"short_english_title","rationale":"one-sentence why this SQL is necessary and how it serves user intent","tables":["table_a","table_b"]}
2) add_note:
{"action":"add_note","title":"简短标题","rationale":"为什么编辑此备注（体现对用户意图理解）","note":"编辑后的完整备注全文（不是增量片段）"}
3) final_answer:
{"action":"final_answer","summary":"完整自然语言结论，含关键证据、趋势/比较/异常/建议，必要时说明局限","show_chart":true|false}

【run_sql 的阶段1要求】
- 本阶段只负责选“目标表”，不要写 SQL。
- tables 必须来自给定“全量表名”，建议 1-3 张，最多 5 张。
- 若问题明显与“规则声明/口径更新/禁用某类表”相关，优先 add_note。

【决策优先级（严格执行）】
1. 先理解用户意图（字面需求 + 潜在兴趣，如趋势、异常、对比、原因）。
2. 如果用户是在“设置规则/口径/备注/禁用某类表”等指令，立刻使用 add_note，不要跑 SQL。
3. final_answer 标准：只有当证据已可直接回答用户问题（含关键数字/对象/时间范围）时，才能输出 final_answer。
4. 若最近一步出现超时/字段错误/被拦截，且尚未拿到可回答问题的有效证据，禁止 final_answer，必须继续 run_sql 修正并重试。
5. 仅在证据不足时 run_sql，并尽量一条 SQL 覆盖多个维度。
6. 禁止重复 add_note（同一语义）和重复 SQL；若已完成应立即 final_answer。
7. 总步数最多 8；达到上限时给出当前最佳结论并说明局限。

【回答质量】
- final_answer 要围绕“用户真正想知道什么”组织，而非仅罗列数据。
- 如果用户要求图表，或你认为结果适合用图表展示，则show_chart应为true
- 结论需有证据支撑（数字/比例/趋势/对比）。
- 可给出潜在业务解释与下一步建议，但不得编造数据。`;
}

export function buildPlannerTimeoutSystemPrompt() {
  return `你是只读 SQL 分析代理（阶段1：超时恢复专用）。上一条 SQL 已超时，你必须为“下一条更轻量 SQL”做选表决策。

【硬性输出格式】
- 你必须且只能输出一个合法 JSON 对象。
- 不允许输出任何额外文字、markdown、代码块、注释。
- 只允许输出 run_sql 动作，格式为：
{"action":"run_sql","title":"short_english_title","rationale":"one-sentence why this SQL is lighter","tables":["table_a","table_b"]}

【目标方向】
- 以“简化 SQL、降低单次查询成本”为第一目标。
- 允许把问题拆成多次查询逐步完成；宁愿多查几次轻量 SQL，也不要单条重查询。
- 避免重复上一条超时 SQL 的思路。`;
}

export function buildPlannerStage1UserContext(input: {
  question: string;
  dbKind: DbKind;
  stepIndex: number;
  forceLightweightMode?: boolean;
  lastTimeoutSql?: string;
  datasourceNote: string;
  history: HistoryItem[];
  allTableNames: string[];
  entitiesCount: number;
  traces: AnalysisPlanStep[];
  evidence: EvidenceItem[];
}) {
  return `${buildNowContextLine()}
用户问题：${input.question}
数据库方言：${input.dbKind}
当前步数：${input.stepIndex + 1}
轻量模式标记：${input.forceLightweightMode ? "ON" : "OFF"}
上一条超时SQL：${input.lastTimeoutSql || "（无）"}
数据库备注：${input.datasourceNote || "（空）"}
当前数据库原始备注全文（编辑 add_note 时必须基于此内容改写并输出完整新版本）：${input.datasourceNote || "（空）"}
历史消息：${JSON.stringify(input.history)}
全量表名：${JSON.stringify(input.allTableNames)}
Schema总表数：${input.entitiesCount}
已执行步骤：${JSON.stringify(input.traces.map((t) => ({ title: t.title, sql: t.sql, status: t.status, reason: t.reason })))}
已得证据：${JSON.stringify(input.evidence)}

请只返回一个 JSON。`;
}

export function buildPlannerStage1RetryContext(baseContext: string, failures: number, lastRaw: string) {
  return `${baseContext}

上一次输出不符合协议（第 ${failures} 次失败）。请严格按以下标准重写：
1) 只能输出一个 JSON 对象，不得有任何额外文本。
2) action 只能是 run_sql/add_note/final_answer。
3) run_sql 必须包含 title/rationale/tables(数组，来自全量表名)；add_note 必须包含 title/rationale/note（note 为完整新备注全文）；final_answer 必须包含 summary 和 show_chart(boolean)。
4) 你上一次的原始输出如下，请修正：
${lastRaw}`;
}

export function buildSqlWriterSystemPrompt() {
  return `你是只读 SQL 分析代理（阶段2：SQL生成）。你已经拿到目标表及其完整字段，请只输出 run_sql JSON。

【硬性输出格式】
- 你必须且只能输出一个合法 JSON 对象。
- 只允许输出：{"action":"run_sql","title":"...","rationale":"...","sql":"..."}
- 不允许任何额外文字、markdown、代码块、注释。

【SQL 硬约束】
- 只能一条完整 SELECT（允许单条 WITH ... SELECT）。
- 严禁多语句；严禁分号后的第二条语句。
- 严禁 DDL/DML（INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE 等）。
- 可以使用 SELECT *。
- 默认控制结果规模（建议 LIMIT <= 1000）。
- 性能优先：宁愿多查几次轻量 SQL，也不要一条超重 SQL；JOIN 建议不超过 2 个。
- MySQL 特别规则：避免 UNION + 多分支 LIMIT 这类写法；如需多结果，拆成多步查询。
- 若上一步报错包含 unknown column/column does not exist/no such column，必须修正列名后再继续。`;
}

export function buildSqlWriterTimeoutSystemPrompt() {
  return `你是只读 SQL 分析代理（阶段2：SQL超时恢复专用）。上一条 SQL 已超时，请只输出一个新的更轻量 run_sql JSON。

【硬性输出格式】
- 你必须且只能输出一个合法 JSON 对象。
- 只允许输出：{"action":"run_sql","title":"...","rationale":"...","sql":"..."}
- 不允许任何额外文字、markdown、代码块、注释。

【目标方向】
- 必须避免与上一条超时 SQL 同构（例如仅函数替换、别名替换）。
- 优先简化 SQL：降低单次查询复杂度与扫描成本。
- 允许把问题拆成多步，逐步查询并利用已有证据推进结论。
- 禁止多语句；仅允许单条 SELECT（或单条 WITH...SELECT）。`;
}

export function buildSqlWriterUserContext(input: {
  question: string;
  dbKind: DbKind;
  stepIndex: number;
  forceLightweightMode?: boolean;
  lastTimeoutSql?: string;
  datasourceNote: string;
  history: HistoryItem[];
  selectedSchema: SimpleSchema;
  seedTitle: string;
  seedRationale: string;
  traces: AnalysisPlanStep[];
  evidence: EvidenceItem[];
}) {
  return `${buildNowContextLine()}
用户问题：${input.question}
数据库方言：${input.dbKind}
当前步数：${input.stepIndex + 1}
轻量模式标记：${input.forceLightweightMode ? "ON" : "OFF"}
上一条超时SQL：${input.lastTimeoutSql || "（无）"}
数据库备注：${input.datasourceNote || "（空）"}
历史消息：${JSON.stringify(input.history)}
目标表与字段（仅可使用这些表写 SQL）：${JSON.stringify(input.selectedSchema)}
建议标题：${input.seedTitle}
建议理由：${input.seedRationale}
已执行步骤：${JSON.stringify(input.traces.map((t) => ({ title: t.title, sql: t.sql, status: t.status, reason: t.reason })))}
已得证据：${JSON.stringify(input.evidence)}

请只返回一个 JSON。`;
}

export function buildSqlWriterRetryContext(baseContext: string, failures: number, lastRaw: string) {
  return `${baseContext}

上一次输出不符合协议（第 ${failures} 次失败）。请重写：
1) 只能输出一个 JSON 对象。
2) action 必须是 run_sql。
3) 必须包含 title/rationale/sql。
4) 你上一次输出：
${lastRaw}`;
}

export function buildSummarySystemPrompt() {
  return "你是数据分析助手。基于证据回答用户问题，2-4句中文，必须围绕问题，不要编造数据。";
}

export function buildSummaryUserPayload(question: string, evidence: EvidenceItem[], traces: AnalysisPlanStep[], datasourceNote: string) {
  return `${buildNowContextLine()}\n问题：${question}\n证据：${JSON.stringify(evidence)}\n步骤：${JSON.stringify(
    traces.map((t) => ({ title: t.title, rationale: t.rationale })),
  )}\n数据库备注：${datasourceNote || "（空）"}`;
}

export function buildChartPlannerSystemPrompt() {
  return "你是可视化规划助手，只返回一个 JSON 对象。"
    + "不适合绘图返回：{\"action\":\"none\"}。"
    + "适合绘图返回：{\"action\":\"chart\",\"chart\":{\"type\":\"line|bar|pie\",\"title\":\"...\",\"xKey\":\"...\",\"yKeys\":[\"...\"],\"labelKey\":\"...\",\"valueKey\":\"...\",\"data\":[...]}}。"
    + "line/bar 必须有 xKey+yKeys；pie 必须有 labelKey+valueKey；data 必须来自给定 sample，不得编造。";
}

export function buildChartPlannerUserPayload(
  question: string,
  summary: string,
  candidates: Array<{ title: string; sql: string; rowCount: number; columns: string[]; sample: Array<Record<string, unknown>> }>,
) {
  return `${buildNowContextLine()}\n问题：${question}\n结论：${summary}\n可用数据集：${JSON.stringify(candidates)}`;
}
