import { getDatasource } from "@/lib/memory-db";
import { createTargetDbClient } from "@/lib/target-db/client";
import { notFound, ok, serverError } from "@/lib/http";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const datasource = await getDatasource(id);
    if (!datasource) return notFound("Connection not found");

    const client = await createTargetDbClient(datasource.uri);
    await client.query("select 1 as ok");
    let readOnlyVerified = true;
    let warning: string | undefined;
    try {
      await client.testReadOnly();
    } catch {
      readOnlyVerified = false;
      warning = "未通过只读校验，但系统只会执行 SELECT 查询。";
    }
    await client.close();

    return ok({
      success: true,
      readOnlyVerified,
      message: readOnlyVerified ? "Read-only check passed" : "Connectivity check passed with warning",
      warning,
    });
  } catch (error) {
    return serverError(error);
  }
}
