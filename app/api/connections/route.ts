import { randomUUID } from "crypto";
import { created, serverError, badRequest, ok } from "@/lib/http";
import { createDatasource, listDatasources } from "@/lib/memory-db";
import { createTargetDbClient } from "@/lib/target-db/client";
import { createConnectionSchema } from "@/lib/validation";
import type { DbKind } from "@/lib/types";

function inferKind(uri: string): DbKind {
  if (uri.startsWith("postgres://") || uri.startsWith("postgresql://")) return "postgres";
  if (uri.startsWith("mysql://")) return "mysql";
  if (uri.startsWith("sqlite://") || uri.endsWith(".db") || uri.endsWith(".sqlite")) return "sqlite";
  throw new Error("Unsupported URI protocol");
}

export async function GET() {
  try {
    const connections = await listDatasources();
    return ok({ connections });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const parsed = createConnectionSchema.safeParse(json);
    if (!parsed.success) {
      return badRequest("Invalid request payload", parsed.error.flatten());
    }

    const { name, uri } = parsed.data;
    const kind = inferKind(uri);

    const testClient = await createTargetDbClient(uri);
    await testClient.query("select 1 as ok");
    let readOnlyVerified = true;
    let warning: string | undefined;
    try {
      await testClient.testReadOnly();
    } catch {
      readOnlyVerified = false;
      warning = "当前连接未通过只读校验。系统仍只执行只读 SQL，不会进行写操作。";
    }
    await testClient.close();

    const datasource = {
      id: randomUUID(),
      name,
      uri,
      kind,
      createdAt: new Date().toISOString(),
    };

    await createDatasource(datasource);

    return created({ datasource, readOnlyVerified, warning });
  } catch (error) {
    return serverError(error);
  }
}
