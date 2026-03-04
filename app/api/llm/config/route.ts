import { ok } from "@/lib/http";
import { getLlmRuntimeConfig } from "@/lib/llm/provider";

export async function GET() {
  const config = getLlmRuntimeConfig();
  return ok(config);
}
