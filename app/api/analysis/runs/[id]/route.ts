import { getRun } from "@/lib/memory-db";
import { tryResumeRun } from "@/lib/analysis/orchestrator";
import { notFound, ok, serverError } from "@/lib/http";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { searchParams } = new URL(req.url);
    const wantsResume = searchParams.get("resume") === "1";
    const resumeResult = wantsResume ? await tryResumeRun(id) : undefined;
    const run = await getRun(id);
    if (!run) return notFound("Run not found");
    return ok({ run, resume: resumeResult });
  } catch (error) {
    return serverError(error);
  }
}
