import { deleteConversationCascade, getConversation } from "@/lib/memory-db";
import { notFound, ok, serverError } from "@/lib/http";

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const conversation = await getConversation(id);
    if (!conversation) return notFound("Conversation not found");

    await deleteConversationCascade(id);
    return ok({ success: true });
  } catch (error) {
    return serverError(error);
  }
}
