import { randomUUID } from "crypto";
import { badRequest, created, serverError } from "@/lib/http";
import { upsertEntityAnnotation, upsertKnowledgeTerm } from "@/lib/memory-db";
import { bindTermSchema } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const parsed = bindTermSchema.safeParse(json);
    if (!parsed.success) {
      return badRequest("Invalid request payload", parsed.error.flatten());
    }

    const now = new Date().toISOString();
    await upsertKnowledgeTerm({
      id: randomUUID(),
      term: parsed.data.term,
      definition: parsed.data.definition,
      scope: parsed.data.scope,
      confidence: 0.95,
      source: "user",
      createdAt: now,
      updatedAt: now,
    });

    await upsertEntityAnnotation({
      datasourceId: parsed.data.scope,
      entityType: parsed.data.targetType,
      entityKey: parsed.data.targetKey,
      note: parsed.data.definition,
    });

    return created({ success: true });
  } catch (error) {
    return serverError(error);
  }
}
