import { badRequest, ok, serverError } from "@/lib/http";
import { getLlmRuntimeConfig } from "@/lib/llm/provider";
import { resolveEffectiveLlmSettings } from "@/lib/memory-db";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const datasourceId = url.searchParams.get("datasourceId")?.trim();
    const conversationId = url.searchParams.get("conversationId")?.trim();
    if (!datasourceId) return badRequest("datasourceId is required");

    const resolved = await resolveEffectiveLlmSettings({ datasourceId, conversationId });
    const runtimeConfig = getLlmRuntimeConfig();
    return ok({
      effective: maskRuntime(resolved.effective),
      datasource: maskSetting(resolved.datasource),
      conversation: maskSetting(resolved.conversation),
      defaults: runtimeConfig.defaults,
      supportedLanguages: runtimeConfig.supportedLanguages,
      providerModes: runtimeConfig.providerModes,
      env: {
        openrouterApiKeyConfigured: Boolean(process.env.OPENROUTER_API_KEY),
      },
    });
  } catch (error) {
    return serverError(error);
  }
}

function maskSecret(value?: string) {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function maskSetting<T extends { apiKey: string } | null>(setting: T): T {
  if (!setting) return setting;
  const maskedApiKey = (setting as { apiKeySource?: string }).apiKeySource === "env"
    ? "(from env)"
    : maskSecret(setting.apiKey);
  return {
    ...setting,
    apiKey: maskedApiKey,
  } as T;
}

function maskRuntime<T extends { apiKey?: string }>(runtime: T): T {
  return {
    ...runtime,
    apiKey: maskSecret(runtime.apiKey),
  };
}
