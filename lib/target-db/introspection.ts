import { ANALYSIS_DEFAULTS } from "../config";
import type { SchemaColumn, SchemaEntity, SchemaRelation } from "../types";
import { withTargetDb } from "./client";

interface TableRow {
  table_schema?: string | null;
  table_name?: string | null;
  table_type?: string;
}

export async function introspectDatasource(
  datasourceId: string,
  uri: string,
  options?: { maxTables?: number },
): Promise<SchemaEntity[]> {
  const maxTables = options?.maxTables ?? ANALYSIS_DEFAULTS.maxIntrospectTables;
  return withTargetDb(uri, async (client) => {
    if (client.kind === "postgres") {
      const allTables = await client.query<TableRow>(`
        select table_schema, table_name, table_type
        from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema')
          and table_type in ('BASE TABLE', 'VIEW')
        order by table_schema, table_name
      `);
      const tables = allTables.slice(0, maxTables);
      const relations = await loadPgRelations(client);
      const entities: SchemaEntity[] = [];
      for (const t of tables) {
        const rawTableName = normalizeIdentifier(t.table_name);
        if (!rawTableName) continue;
        const schemaName = normalizeIdentifier(t.table_schema) ?? "public";
        const scopedTableName = scopePgTableName(schemaName, rawTableName);
        if (!scopedTableName) continue;
        const columns = await loadPgColumns(client, schemaName, rawTableName);
        entities.push({
          datasourceId,
          tableName: scopedTableName,
          tableType: t.table_type === "VIEW" ? "view" : "table",
          columns,
          relations: relations.filter((r) => r.tableName === scopedTableName),
          sampleRows: [],
        });
      }
      return entities;
    }

    if (client.kind === "mysql") {
      const currentDbRows = await client.query<{ db_name: string | null }>(`select database() as db_name`);
      const currentDb = normalizeIdentifier(currentDbRows[0]?.db_name);
      let allTables: Array<Record<string, unknown>> = [];
      try {
        allTables = await client.query<Record<string, unknown>>(`
          select table_name as table_name, table_type as table_type
          from information_schema.tables
          where table_schema = database() and table_type in ('BASE TABLE', 'VIEW')
          order by table_name
        `);
      } catch {
        allTables = [];
      }
      if (!allTables.length && currentDb) {
        allTables = await listMysqlTablesFallback(client, currentDb);
      }

      const tables = allTables.slice(0, maxTables);
      const relations = await loadMysqlRelations(client);
      const entities: SchemaEntity[] = [];
      for (const t of tables) {
        const tableName = normalizeIdentifier(
          String(readRowValue(t, ["table_name", "TABLE_NAME", `Tables_in_${currentDb ?? ""}`]) ?? ""),
        );
        if (!tableName) continue;
        const tableType = String(readRowValue(t, ["table_type", "TABLE_TYPE", "Table_type"]) ?? "BASE TABLE");
        const columns = await loadMysqlColumns(client, tableName);
        entities.push({
          datasourceId,
          tableName,
          tableType: tableType === "VIEW" ? "view" : "table",
          columns,
          relations: relations.filter((r) => r.tableName === tableName),
          sampleRows: [],
        });
      }
      return entities;
    }

    const tables = await client.query<{ name: string; type: string }>(`
      select name, type from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%'
      order by name
    `);

    const entities: SchemaEntity[] = [];
    for (const table of tables.slice(0, maxTables)) {
      const tableName = normalizeIdentifier(table.name);
      if (!tableName) continue;
      const columnsMeta = await client.query<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>(`PRAGMA table_info("${escapeSqliteIdentifier(tableName)}")`);
      const fkMeta = await client.query<{
        from: string;
        table: string;
        to: string;
      }>(`PRAGMA foreign_key_list("${escapeSqliteIdentifier(tableName)}")`);
      const columns: SchemaColumn[] = columnsMeta.map((c) => ({
        name: c.name,
        dataType: c.type,
        nullable: c.notnull === 0,
        isPrimaryKey: c.pk > 0,
      }));
      const relations: SchemaRelation[] = fkMeta.map((f) => ({
        tableName,
        columnName: f.from,
        refTableName: f.table,
        refColumnName: f.to,
      }));
      entities.push({
        datasourceId,
        tableName,
        tableType: table.type === "view" ? "view" : "table",
        columns,
        relations,
        sampleRows: [],
      });
    }

    return entities;
  });
}

function escapeSqliteIdentifier(input: string) {
  return input.replace(/"/g, "\"\"");
}

function escapeSqlLiteral(input: string) {
  return input.replace(/'/g, "''");
}

function scopePgTableName(schemaName: string, tableName: string) {
  const safeSchema = normalizeIdentifier(schemaName);
  const safeTable = normalizeIdentifier(tableName);
  if (!safeTable) return "";
  if (!safeSchema || safeSchema === "public") return safeTable;
  if (safeTable.includes(".")) return safeTable;
  if (safeSchema === "public") return safeTable;
  return `${safeSchema}.${safeTable}`;
}

function normalizeIdentifier(input: string | null | undefined) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed;
}

async function loadPgColumns(
  client: { query: <T = unknown>(sql: string) => Promise<T[]> },
  tableSchema: string,
  tableName: string,
) {
  const schemaLiteral = escapeSqlLiteral(tableSchema);
  const tableLiteral = escapeSqlLiteral(tableName);
  const rows = await client.query<{
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
    is_pk: boolean;
  }>(`
    select
      c.column_name,
      c.data_type,
      c.is_nullable,
      exists (
        select 1
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
        where tc.constraint_type = 'PRIMARY KEY'
          and tc.table_schema = c.table_schema
          and tc.table_name = c.table_name
          and kcu.column_name = c.column_name
      ) as is_pk
    from information_schema.columns c
    where c.table_schema = '${schemaLiteral}' and c.table_name = '${tableLiteral}'
    order by c.ordinal_position
  `);
  return rows.map((row) => ({
    name: row.column_name,
    dataType: row.data_type,
    nullable: row.is_nullable === "YES",
    isPrimaryKey: row.is_pk,
  }));
}

async function loadPgRelations(client: { query: <T = unknown>(sql: string) => Promise<T[]> }) {
  const rows = await client.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    foreign_table_schema: string;
    foreign_table_name: string;
    foreign_column_name: string;
  }>(`
    select
      tc.table_schema,
      tc.table_name,
      kcu.column_name,
      ccu.table_schema as foreign_table_schema,
      ccu.table_name as foreign_table_name,
      ccu.column_name as foreign_column_name
    from information_schema.table_constraints as tc
    join information_schema.key_column_usage as kcu
      on tc.constraint_name = kcu.constraint_name
    join information_schema.constraint_column_usage as ccu
      on ccu.constraint_name = tc.constraint_name
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema not in ('pg_catalog', 'information_schema')
  `);
  return rows.map((row) => ({
    tableName: scopePgTableName(row.table_schema, row.table_name),
    columnName: row.column_name,
    refTableName: scopePgTableName(row.foreign_table_schema, row.foreign_table_name),
    refColumnName: row.foreign_column_name,
  }));
}

async function loadMysqlColumns(client: { query: <T = unknown>(sql: string) => Promise<T[]> }, tableName: string) {
  try {
    const rows = await client.query<Record<string, unknown>>(`
      select column_name, data_type, is_nullable, column_key
      from information_schema.columns
      where table_schema = database() and table_name = '${tableName}'
      order by ordinal_position
    `);

    if (rows.length > 0) {
      return rows.map((row) => ({
        name: String(readRowValue(row, ["column_name", "COLUMN_NAME"]) ?? ""),
        dataType: String(readRowValue(row, ["data_type", "DATA_TYPE"]) ?? ""),
        nullable: String(readRowValue(row, ["is_nullable", "IS_NULLABLE"]) ?? "YES") === "YES",
        isPrimaryKey: String(readRowValue(row, ["column_key", "COLUMN_KEY"]) ?? "") === "PRI",
      })).filter((c) => c.name.length > 0);
    }
  } catch {
    // fallback below
  }

  const fallback = await client.query<Array<Record<string, unknown>>[number]>(
    `show columns from \`${escapeMysqlIdentifier(tableName)}\``,
  );
  return fallback.map((row) => ({
    name: String(row.Field ?? ""),
    dataType: String(row.Type ?? ""),
    nullable: String(row.Null ?? "YES") === "YES",
    isPrimaryKey: String(row.Key ?? "") === "PRI",
  })).filter((c) => c.name.length > 0);
}

async function loadMysqlRelations(client: { query: <T = unknown>(sql: string) => Promise<T[]> }) {
  try {
    const rows = await client.query<Record<string, unknown>>(`
      select table_name, column_name, referenced_table_name, referenced_column_name
      from information_schema.key_column_usage
      where table_schema = database() and referenced_table_name is not null
    `);

    return rows.map((row) => ({
      tableName: String(readRowValue(row, ["table_name", "TABLE_NAME"]) ?? ""),
      columnName: String(readRowValue(row, ["column_name", "COLUMN_NAME"]) ?? ""),
      refTableName: String(readRowValue(row, ["referenced_table_name", "REFERENCED_TABLE_NAME"]) ?? ""),
      refColumnName: String(readRowValue(row, ["referenced_column_name", "REFERENCED_COLUMN_NAME"]) ?? ""),
    })).filter((r) => r.tableName && r.columnName && r.refTableName && r.refColumnName);
  } catch {
    return [];
  }
}

async function listMysqlTablesFallback(
  client: { query: <T = unknown>(sql: string) => Promise<T[]> },
  dbName: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await client.query<Record<string, unknown>>(
    `show full tables from \`${escapeMysqlIdentifier(dbName)}\``,
  );
  return rows
    .map((row) => {
      const entries = Object.entries(row);
      const tableNameEntry = entries.find(([k]) => k.toLowerCase().startsWith("tables_in_")) ?? entries[0];
      const typeEntry = entries.find(([k]) => k.toLowerCase() === "table_type");
      const tableName = normalizeIdentifier(typeof tableNameEntry?.[1] === "string" ? tableNameEntry[1] : null);
      const tableType = typeof typeEntry?.[1] === "string" ? typeEntry[1] : "BASE TABLE";
      if (!tableName) return null;
      return {
        table_name: tableName,
        table_type: tableType,
      };
    })
    .filter((x): x is { table_name: string; table_type: string } => x !== null);
}

function escapeMysqlIdentifier(input: string) {
  return input.replace(/`/g, "``");
}

function readRowValue(row: Record<string, unknown>, candidates: string[]) {
  for (const key of candidates) {
    if (key in row) return row[key];
    const found = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
    if (found) return row[found];
  }
  return undefined;
}
