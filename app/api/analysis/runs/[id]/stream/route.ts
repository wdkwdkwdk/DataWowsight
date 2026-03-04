import { getRun, listRunEvents } from "@/lib/memory-db";

function toSseEvent(eventName: string, data: unknown) {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id: runId } = await context.params;
  const run = await getRun(runId);
  if (!run) {
    return new Response(JSON.stringify({ error: "Run not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSendAt = Date.now();
  let polling = false;
  const KEEPALIVE_MS = 5_000;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastEventId = 0;

      const safeEnqueue = (eventName: string, data: unknown) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(toSseEvent(eventName, data)));
          lastSendAt = Date.now();
          return true;
        } catch {
          closed = true;
          return false;
        }
      };

      const safeClose = () => {
        if (closed) return;
        closed = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        try {
          controller.close();
        } catch {
          // stream already closed
        }
      };

      safeEnqueue("connected", { runId });

      timer = setInterval(async () => {
        if (closed || polling) return;
        polling = true;

        try {
          if (Date.now() - lastSendAt >= KEEPALIVE_MS) {
            if (!safeEnqueue("ping", { ts: new Date().toISOString() })) {
              safeClose();
              return;
            }
          }

          const events = await listRunEvents(runId, lastEventId > 0 ? lastEventId : undefined);
          for (const ev of events) {
            lastEventId = ev.id;
            if (!safeEnqueue(ev.eventType, ev)) {
              safeClose();
              return;
            }
          }

          const latestRun = await getRun(runId);
          if (latestRun?.status === "completed" || latestRun?.status === "failed") {
            safeEnqueue("done", { status: latestRun.status });
            safeClose();
          }
        } catch (error) {
          safeEnqueue("failed", {
            error: error instanceof Error ? error.message : "stream_error",
          });
          safeClose();
        } finally {
          polling = false;
        }
      }, 800);
    },
    cancel() {
      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
