import { z } from "zod";

export const createConnectionSchema = z.object({
  name: z.string().min(1),
  uri: z.string().min(1),
});

export const patchConnectionSchema = z.object({
  name: z.string().min(1).max(120),
});

export const queryAnalysisSchema = z.object({
  connectionId: z.string().min(1),
  question: z.string().min(1),
  sessionId: z.string().optional(),
  conversationId: z.string().optional(),
  llmModel: z.string().min(1).max(120).optional(),
  language: z.enum(["en", "zh"]).optional(),
});

export const clarifySchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  answers: z.array(
    z.object({
      questionId: z.string().min(1),
      answer: z.string().min(1),
    }),
  ),
});

export const upsertTermSchema = z.object({
  term: z.string().min(1),
  definition: z.string().min(1),
  scope: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.9),
});

export const patchTermSchema = z.object({
  id: z.string().min(1),
  definition: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const bindTermSchema = z.object({
  term: z.string().min(1),
  definition: z.string().min(1),
  scope: z.string().min(1),
  targetType: z.enum(["table", "field", "metric", "term", "datasource"]),
  targetKey: z.string().min(1),
});

export const createConversationSchema = z.object({
  datasourceId: z.string().min(1),
  title: z.string().min(1).max(120).optional(),
});

export const postConversationMessageSchema = z.object({
  question: z.string().min(1),
  connectionId: z.string().min(1),
  llmModel: z.string().min(1).max(120).optional(),
  language: z.enum(["en", "zh"]).optional(),
});

export const patchDatasourceNoteSchema = z.object({
  note: z.string().max(12000),
});

export const languageSchema = z.enum(["en", "zh"]);
export const providerModeSchema = z.enum(["openrouter_simple", "openai_compatible_custom"]);

const kvObjectSchema = z.record(z.string(), z.string());

export const llmSettingsPatchSchema = z.object({
  language: languageSchema.default("en"),
  providerMode: providerModeSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).max(200).optional(),
  providerLabel: z.string().min(1).max(120).optional(),
  extraHeaders: kvObjectSchema.optional(),
  extraQueryParams: kvObjectSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32000).optional(),
}).superRefine((value, ctx) => {
  if (value.providerMode === "openai_compatible_custom") {
    if (!value.baseUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baseUrl"], message: "baseUrl is required for openai_compatible_custom" });
    }
    if (!value.model) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["model"], message: "model is required for openai_compatible_custom" });
    }
  }
});
