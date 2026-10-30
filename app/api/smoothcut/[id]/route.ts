import { getSmoothCut } from "@/lib/smoothcut-jobs";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = getSmoothCut((await params).id);
  if (!job) return Response.json({ error: "Unknown job" }, { status: 404 });
  const last = job.progress[job.progress.length - 1];
  return Response.json({
    id: job.id, status: job.status, error: job.error, code: job.code, summary: job.summary,
    stage: last ? `${last.stage}${last.done !== undefined ? ` ${last.done}/${last.total}` : ""}${last.detail ? ` — ${last.detail}` : ""}` : "",
    outputs: job.status === "completed" ? [{ id: "video", name: "smooth-cut.mp4", type: "video/mp4", url: `/api/smoothcut/${job.id}/video` }] : [],
  });
}
