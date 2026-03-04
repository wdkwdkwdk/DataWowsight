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
});

export const patchDatasourceNoteSchema = z.object({
  note: z.string().max(12000),
});
