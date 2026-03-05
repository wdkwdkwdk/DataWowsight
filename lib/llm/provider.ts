import { ANALYSIS_DEFAULTS } from "../config";
import type { LlmProviderMode, ResolvedLlmRuntime, UiLanguage } from "../types";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallLlmOptions {
  modelOverride?: string;
  runtime?: ResolvedLlmRuntime;
}

export interface LlmRuntimeConfig {
  provider: string;
  defaultModel: string;
  selectableModels: string[];
  supportedLanguages: UiLanguage[];
  defaultLanguage: UiLanguage;
  providerModes: LlmProviderMode[];
  defaults: {
    openrouterSimple: {
      baseUrl: string;
      model: string;
      appUrl: string;
      appName: string;
    };
    openaiCompatible: {
      baseUrl: string;
      model: string;
    };
  };
}

export function getLlmRuntimeConfig(): LlmRuntimeConfig {
  const provider = process.env.LLM_PROVIDER ?? "mock";
  const defaultModel = resolveDefaultModel(provider);
  const selectableModels =
    provider === "openrouter"
      ? uniqueNonEmpty([defaultModel, "minimax/minimax-m2.5", "moonshotai/kimi-k2.5"])
      : [defaultModel];
  return {
    provider,
    defaultModel,
    selectableModels,
    supportedLanguages: ["en", "zh"],
    defaultLanguage: normalizeLanguage(process.env.APP_DEFAULT_LANGUAGE),
    providerModes: ["openrouter_simple", "openai_compatible_custom"],
    defaults: {
      openrouterSimple: {
        baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        model: process.env.OPENROUTER_MODEL ?? "google/gemini-3-flash-preview",
        appUrl: process.env.OPENROUTER_APP_URL ?? "http://localhost:3000",
        appName: process.env.OPENROUTER_APP_NAME ?? "DataWowsight",
      },
      openaiCompatible: {
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      },
    },
  };
}

export async function callLlm(messages: LlmMessage[], options?: CallLlmOptions): Promise<string> {
  const runtime = options?.runtime;
  if (runtime) {
    return callByResolvedRuntime(messages, runtime, options?.modelOverride);
  }

  const provider = process.env.LLM_PROVIDER ?? "mock";
  const modelOverride = options?.modelOverride?.trim();
  if (provider === "openrouter") {
    return callOpenRouter(messages, modelOverride);
  }

  if (provider === "openai") {
    return callOpenAI(messages, modelOverride);
  }

  if (provider === "anthropic") {
    return callAnthropic(messages, modelOverride);
  }

  if (provider === "gemini") {
    return callGemini(messages, modelOverride);
  }

  return mockReply(messages);
}

async function callByResolvedRuntime(messages: LlmMessage[], runtime: ResolvedLlmRuntime, modelOverride?: string) {
  if (runtime.providerMode === "openrouter_simple") {
    const apiKey = runtime.apiKey?.trim();
    if (!apiKey) return mockReply(messages);
    const defaults = getLlmRuntimeConfig().defaults.openrouterSimple;
    const model = modelOverride?.trim() || runtime.model || defaults.model;
    const baseUrl = runtime.baseUrl || defaults.baseUrl;
    const appUrl = process.env.OPENROUTER_APP_URL ?? defaults.appUrl;
    const appName = process.env.OPENROUTER_APP_NAME ?? defaults.appName;
    logLlmRequest("openrouter", model, messages);
    return callOpenAiCompatible({
      apiKey,
      model,
      messages,
      baseUrl,
      extraHeaders: {
        "HTTP-Referer": appUrl,
        "X-Title": appName,
      },
      temperature: runtime.temperature,
      maxTokens: runtime.maxTokens,
      extraQueryParams: runtime.extraQueryParams,
    });
  }

  const apiKey = runtime.apiKey?.trim();
  const baseUrl = runtime.baseUrl?.trim();
  const model = (modelOverride?.trim() || runtime.model || "").trim();
  if (!apiKey || !baseUrl || !model) return mockReply(messages);

  logLlmRequest(runtime.providerLabel || "openai-compatible", model, messages);
  return callOpenAiCompatible({
    apiKey,
    model,
    messages,
    baseUrl,
    extraHeaders: runtime.extraHeaders,
    temperature: runtime.temperature,
    maxTokens: runtime.maxTokens,
    extraQueryParams: runtime.extraQueryParams,
  });
}

async function callOpenAI(messages: LlmMessage[], modelOverride?: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return mockReply(messages);

  const model = modelOverride || process.env.OPENAI_MODEL || "gpt-4.1-mini";
  logLlmRequest("openai", model, messages);
  return callOpenAiCompatible({
    apiKey,
    model,
    messages,
    baseUrl: "https://api.openai.com/v1",
  });
}

async function callOpenRouter(messages: LlmMessage[], modelOverride?: string) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return mockReply(messages);

  const model = modelOverride || process.env.OPENROUTER_MODEL || "google/gemini-3-flash-preview";
  logLlmRequest("openrouter", model, messages);
  const baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const appUrl = process.env.OPENROUTER_APP_URL ?? "http://localhost:3000";
  const appName = process.env.OPENROUTER_APP_NAME ?? "DataWowsight";

  return callOpenAiCompatible({
    apiKey,
    model,
    messages,
    baseUrl,
    extraHeaders: {
      "HTTP-Referer": appUrl,
      "X-Title": appName,
    },
  });
}

async function callOpenAiCompatible(input: {
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  extraQueryParams?: Record<string, string>;
}) {
  const url = buildOpenAiCompatibleUrl(input.baseUrl, input.extraQueryParams);
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      ...(input.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: input.model,
      temperature: input.temperature ?? 0.1,
      ...(typeof input.maxTokens === "number" ? { max_tokens: input.maxTokens } : {}),
      messages: input.messages,
    }),
  });

  if (!res || !res.ok) {
    logLlmFailure(
      "openai-compatible",
      input.model,
      res?.status,
      res ? await safeReadText(res.clone()) : "request_timeout_or_network_error",
    );
    return mockReply(input.messages);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    logLlmResponse("openai-compatible", input.model, res.status, content);
    return content;
  }
  const fallback = mockReply(input.messages);
  logLlmResponse("openai-compatible", input.model, res.status, fallback, true);
  return fallback;
}

async function callAnthropic(messages: LlmMessage[], modelOverride?: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return mockReply(messages);

  const model = modelOverride || process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";
  logLlmRequest("anthropic", model, messages);
  const input = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      temperature: 0.1,
      messages: [{ role: "user", content: input }],
    }),
  });

  if (!res || !res.ok) {
    logLlmFailure("anthropic", model, res?.status, res ? await safeReadText(res.clone()) : "request_timeout_or_network_error");
    return mockReply(messages);
  }
  const data = await res.json();
  const content = data.content?.[0]?.text;
  if (typeof content === "string" && content.trim()) {
    logLlmResponse("anthropic", model, res.status, content);
    return content;
  }
  const fallback = mockReply(messages);
  logLlmResponse("anthropic", model, res.status, fallback, true);
  return fallback;
}

async function callGemini(messages: LlmMessage[], modelOverride?: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return mockReply(messages);

  const model = modelOverride || process.env.GEMINI_MODEL || "gemini-1.5-flash";
  logLlmRequest("gemini", model, messages);
  const prompt = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
    },
  );

  if (!res || !res.ok) {
    logLlmFailure("gemini", model, res?.status, res ? await safeReadText(res.clone()) : "request_timeout_or_network_error");
    return mockReply(messages);
  }
  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof content === "string" && content.trim()) {
    logLlmResponse("gemini", model, res.status, content);
    return content;
  }
  const fallback = mockReply(messages);
  logLlmResponse("gemini", model, res.status, fallback, true);
  return fallback;
}

function mockReply(messages: LlmMessage[]) {
  const last = messages[messages.length - 1]?.content ?? "";
  if (/describe table/i.test(last)) {
    return "This table stores business events and should be linked by key IDs and timestamps.";
  }
  return "Use aggregate SELECT queries with grouping and trend checks, then summarize evidence and caveats.";
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeoutMs = ANALYSIS_DEFAULTS.llmTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function trimForLog(text: string, maxLen = 500) {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}... [truncated ${text.length - maxLen} chars]`;
}

function logLlmRequest(provider: string, model: string, messages: LlmMessage[]) {
  const serialized = messages
    .map((m, idx) => `[${idx}] ${m.role}: ${trimForLog(m.content, 280)}`)
    .join("\n");
  console.log(`\n[LLM REQUEST] provider=${provider} model=${model}\n${serialized}\n`);
}

function logLlmResponse(provider: string, model: string, status: number | undefined, output: string, isFallback = false) {
  console.log(
    `\n[LLM RESPONSE] provider=${provider} model=${model} status=${status ?? "n/a"} fallback=${isFallback}\n${trimForLog(output)}\n`,
  );
}

function logLlmFailure(provider: string, model: string, status: number | undefined, detail: string) {
  console.error(
    `\n[LLM ERROR] provider=${provider} model=${model} status=${status ?? "n/a"}\n${trimForLog(detail)}\n`,
  );
}

async function safeReadText(res: Response) {
  try {
    return await res.text();
  } catch {
    return "failed_to_read_error_body";
  }
}

function resolveDefaultModel(provider: string) {
  if (provider === "openrouter") return process.env.OPENROUTER_MODEL ?? "google/gemini-3-flash-preview";
  if (provider === "openai") return process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  if (provider === "anthropic") return process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest";
  if (provider === "gemini") return process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
  return "mock";
}

function uniqueNonEmpty(items: string[]) {
  const out: string[] = [];
  for (const item of items) {
    const value = item.trim();
    if (!value) continue;
    if (out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function buildOpenAiCompatibleUrl(baseUrl: string, extraQueryParams?: Record<string, string>) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const url = new URL(`${normalizedBase}/chat/completions`);
  for (const [k, v] of Object.entries(extraQueryParams ?? {})) {
    const key = k.trim();
    if (!key) continue;
    url.searchParams.set(key, String(v));
  }
  return url.toString();
}

function normalizeLanguage(value: string | undefined): UiLanguage {
  return value?.toLowerCase() === "zh" ? "zh" : "en";
}
