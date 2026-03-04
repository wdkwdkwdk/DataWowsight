import { Parser } from "node-sql-parser";
import { ANALYSIS_DEFAULTS, BLOCKED_SQL_KEYWORDS } from "./config";

const parser = new Parser();

export function ensureSafeReadOnlySql(sql: string): { ok: true; normalizedSql: string } | { ok: false; reason: string } {
  const normalized = normalizeSql(sql);
  if (!normalized) {
    return { ok: false, reason: "Empty SQL" };
  }

  if (hasMultipleStatements(normalized)) {
    return { ok: false, reason: "Only a single SQL statement is allowed" };
  }

  const lowered = normalized.toLowerCase();

  for (const kw of BLOCKED_SQL_KEYWORDS) {
    const regex = new RegExp(`\\b${kw}\\b`, "i");
    if (regex.test(lowered)) {
      return { ok: false, reason: `Blocked SQL keyword detected: ${kw}` };
    }
  }

  const parseOk = tryParseAsSelect(normalized);
  if (!parseOk && !looksLikeReadOnlySelect(normalized)) {
    return { ok: false, reason: "SQL parse failed and fallback validation rejected" };
  }

  if (!/\blimit\b/i.test(normalized)) {
    return {
      ok: true,
      normalizedSql: `${normalized} LIMIT ${ANALYSIS_DEFAULTS.maxRowsPerQuery}`,
    };
  }

  return { ok: true, normalizedSql: normalized };
}

function tryParseAsSelect(sql: string) {
  const dialects = [undefined, "postgresql", "mysql", "sqlite"];
  for (const dialect of dialects) {
    try {
      const ast = dialect ? parser.astify(sql, { database: dialect }) : parser.astify(sql);
      const statements = Array.isArray(ast) ? ast : [ast];
      if (statements.length !== 1) {
        return false;
      }
      const statementType = (statements[0] as { type?: string }).type;
      if (statementType === "select") {
        return true;
      }
    } catch {
      // try next dialect
    }
  }
  return false;
}

function looksLikeReadOnlySelect(sql: string) {
  const trimmed = sql.trim().toLowerCase();
  if (!(trimmed.startsWith("select ") || trimmed.startsWith("with "))) return false;
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|replace|call|do)\b/i.test(trimmed)) {
    return false;
  }
  return true;
}

function normalizeSql(sql: string) {
  return stripCodeFence(sql)
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
    .replace(/;+$/g, "");
}

function stripCodeFence(text: string) {
  return text.replace(/^```(?:sql|json)?\s*/i, "").replace(/\s*```$/i, "");
}

function hasMultipleStatements(sql: string) {
  return /;[\s\S]*\S/.test(sql);
}
