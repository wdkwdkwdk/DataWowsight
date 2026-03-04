import { getDatasource } from "@/lib/memory-db";
import { runSchemaIntelligence } from "@/lib/analysis/schema-intelligence";
import { notFound, ok, serverError } from "@/lib/http";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const datasource = await getDatasource(id);
    if (!datasource) return notFound("Connection not found");

    const url = new URL(req.url);
    const full = url.searchParams.get("full") === "1";
    const entities = await runSchemaIntelligence(datasource.id, datasource.uri, {
      maxTables: full ? Number.MAX_SAFE_INTEGER : undefined,
    });

    return ok({
      success: true,
      tables: entities.length,
      entities,
    });
  } catch (error) {
    return serverError(error);
  }
}
