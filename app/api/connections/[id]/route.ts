import { deleteDatasourceCascade, getDatasource, renameDatasource } from "@/lib/memory-db";
import { badRequest, notFound, ok, serverError } from "@/lib/http";
import { patchConnectionSchema } from "@/lib/validation";

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const datasource = await getDatasource(id);
    if (!datasource) return notFound("Connection not found");

    await deleteDatasourceCascade(id);
    return ok({ success: true });
  } catch (error) {
    return serverError(error);
  }
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const datasource = await getDatasource(id);
    if (!datasource) return notFound("Connection not found");

    const parsed = patchConnectionSchema.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid request payload", parsed.error.flatten());

    await renameDatasource(id, parsed.data.name.trim());
    return ok({ success: true });
  } catch (error) {
    return serverError(error);
  }
}
