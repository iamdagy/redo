import { readFile } from "node:fs/promises";
import { getSmoothCut } from "@/lib/smoothcut-jobs";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = getSmoothCut((await params).id);
  if (!job?.output) return Response.json({ error: "Not ready" }, { status: 404 });
  return new Response(new Uint8Array(await readFile(job.output)), { headers: { "content-type": "video/mp4" } });
}
