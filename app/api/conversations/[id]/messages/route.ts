import { getConversation, listMessages } from "@/lib/memory-db";
import { runAnalysisQuery } from "@/lib/analysis/orchestrator";
import { badRequest, notFound, ok, serverError } from "@/lib/http";
import { postConversationMessageSchema } from "@/lib/validation";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const conversation = await getConversation(id);
    if (!conversation) return notFound("Conversation not found");

    const messages = await listMessages(id);
    return ok({ conversation, messages });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const conversation = await getConversation(id);
    if (!conversation) return notFound("Conversation not found");

    const json = await req.json();
    const parsed = postConversationMessageSchema.safeParse(json);
    if (!parsed.success) return badRequest("Invalid request payload", parsed.error.flatten());

    const result = await runAnalysisQuery({
      connectionId: parsed.data.connectionId,
      conversationId: id,
      question: parsed.data.question,
      sessionId: id,
      llmModel: parsed.data.llmModel,
    });

    return ok(result);
  } catch (error) {
    return serverError(error);
  }
}
