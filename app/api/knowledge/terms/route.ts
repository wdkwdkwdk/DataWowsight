import { randomUUID } from "crypto";
import { badRequest, created, ok, serverError } from "@/lib/http";
import { listKnowledgeTerms, patchKnowledgeTerm, upsertKnowledgeTerm } from "@/lib/memory-db";
import { patchTermSchema, upsertTermSchema } from "@/lib/validation";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const keyword = url.searchParams.get("keyword") ?? undefined;
    const terms = await listKnowledgeTerms(keyword);
    return ok({ terms });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const parsed = upsertTermSchema.safeParse(json);
    if (!parsed.success) {
      return badRequest("Invalid request payload", parsed.error.flatten());
    }

    const now = new Date().toISOString();
    const input = {
      id: randomUUID(),
      ...parsed.data,
      source: "user" as const,
      createdAt: now,
      updatedAt: now,
    };

    await upsertKnowledgeTerm(input);
    return created({ term: input });
  } catch (error) {
    return serverError(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const json = await req.json();
    const parsed = patchTermSchema.safeParse(json);
    if (!parsed.success) {
      return badRequest("Invalid request payload", parsed.error.flatten());
    }

    await patchKnowledgeTerm(parsed.data.id, parsed.data.definition, parsed.data.confidence);
    return ok({ success: true });
  } catch (error) {
    return serverError(error);
  }
}
