import mysql from "mysql2/promise";
import { Client as PgClient } from "pg";
import sqlite3 from "sqlite3";
import type { DbKind } from "../types";

type QueryResult = { rows: Record<string, unknown>[] };

export interface TargetDbClient {
  kind: DbKind;
  testReadOnly(): Promise<void>;
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  close(): Promise<void>;
}

class PostgresTargetClient implements TargetDbClient {
  kind: DbKind = "postgres";
  constructor(private client: PgClient) {}

  async testReadOnly() {
    const res = await this.client.query("show transaction_read_only");
    const mode = res.rows[0]?.transaction_read_only ?? "off";
    if (mode !== "on") {
      throw new Error("PostgreSQL connection is not read-only (transaction_read_only is off)");
    }
    await this.client.query("select 1");
  }

  async query<T>(sqlText: string): Promise<T[]> {
    const res = await this.client.query(sqlText);
    return res.rows as T[];
  }

  async close() {
    await this.client.end();
  }
}

class MysqlTargetClient implements TargetDbClient {
  kind: DbKind = "mysql";
  constructor(private client: mysql.Connection) {}

  async testReadOnly() {
    const [rows] = await this.client.query("SELECT @@session.transaction_read_only as ro");
    const ro = Array.isArray(rows) ? Number((rows[0] as { ro: number }).ro) : 0;
    if (ro !== 1) {
      throw new Error("MySQL connection is not read-only (transaction_read_only is not 1)");
    }
  }

  async query<T>(sqlText: string): Promise<T[]> {
    const [rows] = await this.client.query(sqlText);
    return rows as T[];
  }

  async close() {
    await this.client.end();
  }
}

class SqliteTargetClient implements TargetDbClient {
  kind: DbKind = "sqlite";

  constructor(private db: sqlite3.Database) {}

  async testReadOnly() {
    await this.query("select 1");
  }

  async query<T>(sqlText: string): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      this.db.all(sqlText, [], (err, rows) => {
        if (err) return reject(err);
        resolve((rows ?? []) as T[]);
      });
    });
  }

  async close() {
    await new Promise<void>((resolve, reject) => {
      this.db.close((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}

function parseKind(uri: string): DbKind {
  if (uri.startsWith("postgres://") || uri.startsWith("postgresql://")) return "postgres";
  if (uri.startsWith("mysql://")) return "mysql";
  if (uri.startsWith("sqlite://") || uri.endsWith(".db") || uri.endsWith(".sqlite")) return "sqlite";
  throw new Error("Unsupported datasource URI. Supported: postgres://, mysql://, sqlite://");
}

function parseSqlitePath(uri: string) {
  if (uri.startsWith("sqlite://")) {
    return uri.replace(/^sqlite:\/\//, "");
  }
  return uri;
}

export async function createTargetDbClient(uri: string): Promise<TargetDbClient> {
  const kind = parseKind(uri);

  if (kind === "postgres") {
    const client = new PgClient({ connectionString: uri });
    await client.connect();
    return new PostgresTargetClient(client);
  }

  if (kind === "mysql") {
    const client = await mysql.createConnection(uri);
    return new MysqlTargetClient(client);
  }

  const filePath = parseSqlitePath(uri);
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const mode = sqlite3.OPEN_READONLY;
    const instance = new sqlite3.Database(filePath, mode, (err) => {
      if (err) return reject(err);
      resolve(instance);
    });
  });

  return new SqliteTargetClient(db);
}

export async function withTargetDb<T>(uri: string, fn: (client: TargetDbClient) => Promise<T>) {
  const client = await createTargetDbClient(uri);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function runQueryWithTimeout(uri: string, sqlText: string): Promise<QueryResult> {
  return withTargetDb(uri, async (client) => {
    const rows = await client.query(sqlText);
    return { rows };
  });
}
