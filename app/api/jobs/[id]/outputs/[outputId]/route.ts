import { outputUrl, keyFor } from "@/lib/comfy";

export const runtime = "nodejs";

// Sirve la salida a través del mismo origen, para que el comparador y la descarga funcionen sin CORS.
export async function GET(req: Request, { params }: { params: Promise<{ id: string; outputId: string }> }) {
  try {
    const { id, outputId } = await params;
    const upstream = await fetch(await outputUrl(id, outputId, keyFor(req, id)));
    return new Response(upstream.body, {
      headers: { "content-type": upstream.headers.get("content-type") ?? "video/mp4", "cache-control": "private, max-age=3600" },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
