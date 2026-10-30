import { getJob, keyFor, explainError } from "@/lib/comfy";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return Response.json(await getJob(id, keyFor(req, id)));
  } catch (e) {
    const { status, body } = explainError(e);
    return Response.json(body, { status });
  }
}
