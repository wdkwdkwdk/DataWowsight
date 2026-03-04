import { applyClarifications } from "@/lib/analysis/orchestrator";
import { badRequest, ok, serverError } from "@/lib/http";
import { clarifySchema } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const parsed = clarifySchema.safeParse(json);
    if (!parsed.success) {
      return badRequest("Invalid request payload", parsed.error.flatten());
    }

    const result = await applyClarifications(parsed.data);
    return ok(result);
  } catch (error) {
    return serverError(error);
  }
}
