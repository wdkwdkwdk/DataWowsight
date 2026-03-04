import { getDatasource, getEntityAnnotation, upsertEntityAnnotation } from "@/lib/memory-db";
import { badRequest, notFound, ok, serverError } from "@/lib/http";
import { patchDatasourceNoteSchema } from "@/lib/validation";

const GLOBAL_NOTE_KEY = "global_note";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const datasource = await getDatasource(id);
    if (!datasource) return notFound("Connection not found");

    const note = await getEntityAnnotation({
      datasourceId: id,
      entityType: "datasource",
      entityKey: GLOBAL_NOTE_KEY,
    });

    return ok({
      note: note?.note ?? "",
      updatedAt: note?.updatedAt ?? null,
    });
  } catch (error) {
    return serverError(error);
  }
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const datasource = await getDatasource(id);
    if (!datasource) return notFound("Connection not found");

    const parsed = patchDatasourceNoteSchema.safeParse(await req.json());
    if (!parsed.success) {
      return badRequest("Invalid request payload", parsed.error.flatten());
    }

    await upsertEntityAnnotation({
      datasourceId: id,
      entityType: "datasource",
      entityKey: GLOBAL_NOTE_KEY,
      note: parsed.data.note.trim(),
    });

    return ok({ success: true });
  } catch (error) {
    return serverError(error);
  }
}
