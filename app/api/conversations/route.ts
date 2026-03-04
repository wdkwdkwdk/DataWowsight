import { randomUUID } from "crypto";
import { badRequest, created, ok, serverError } from "@/lib/http";
import { createConversation, listConversations } from "@/lib/memory-db";
import { createConversationSchema } from "@/lib/validation";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const datasourceId = url.searchParams.get("datasourceId");
    if (!datasourceId) return badRequest("datasourceId is required");

    const conversations = await listConversations(datasourceId);
    return ok({ conversations });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const parsed = createConversationSchema.safeParse(json);
    if (!parsed.success) return badRequest("Invalid request payload", parsed.error.flatten());

    const id = randomUUID();
    const title = parsed.data.title ?? "New Chat";
    await createConversation({ id, datasourceId: parsed.data.datasourceId, title });

    return created({ conversation: { id, datasourceId: parsed.data.datasourceId, title } });
  } catch (error) {
    return serverError(error);
  }
}
