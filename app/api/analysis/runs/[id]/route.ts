import { getRun } from "@/lib/memory-db";
import { notFound, ok, serverError } from "@/lib/http";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const run = await getRun(id);
    if (!run) return notFound("Run not found");
    return ok({ run });
  } catch (error) {
    return serverError(error);
  }
}
