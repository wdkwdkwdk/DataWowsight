import { badRequest, ok, serverError } from "@/lib/http";
import { deleteLlmSetting, upsertLlmSetting } from "@/lib/memory-db";
import { llmSettingsPatchSchema } from "@/lib/validation";

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await req.json();

    if (body?.reset === true) {
      await deleteLlmSetting("datasource", id);
      return ok({ reset: true });
    }

    const parsed = llmSettingsPatchSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid request payload", parsed.error.flatten());

    const saved = await upsertLlmSetting("datasource", id, parsed.data);
    return ok({ setting: { ...saved, apiKey: maskSecret(saved.apiKey) } });
  } catch (error) {
    return serverError(error);
  }
}

function maskSecret(value?: string) {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
