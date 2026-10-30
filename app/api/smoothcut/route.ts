import { startSmoothCut, smoothCutBusy } from "@/lib/smoothcut-jobs";
import { keyFor, serverHasKey, explainError } from "@/lib/comfy";
import { prepareClip } from "@/lib/prep";
import { MAX_UPLOAD_BYTES, parseJsonField, uploadTooBig } from "@/lib/safety";
import type { Meta } from "@/lib/plan";

export const runtime = "nodejs";

/** Smooth Cut es barato por segundo, pero ffmpeg y whisper usan CPU del servidor: tope propio. */
const MAX_SECONDS = 180;

export async function POST(req: Request) {
  try {
    if (uploadTooBig(req)) return Response.json({ error: "That video is too large (200 MB max)." }, { status: 413 });
    if (smoothCutBusy()) return Response.json({ error: "The server is busy with other Smooth Cuts. Try again in a minute." }, { status: 429 });
    const form = await req.formData();
    const video = form.get("video");
    if (!(video instanceof File)) return Response.json({ error: "Upload a video first." }, { status: 400 });
    if (video.size > MAX_UPLOAD_BYTES) return Response.json({ error: "That video is too large (200 MB max)." }, { status: 413 });
    const settings = parseJsonField(form.get("settings"));
    const key = keyFor(req);
    // Los cortes secos no usan Comfy; las mezclas sí, y necesitan una clave.
    if (settings.bridges !== "off" && !key && !serverHasKey()) return Response.json({ error: "Add your Comfy API key to run this.", code: "need_key" }, { status: 401 });
    // Solo el tramo elegido (las marcas "conservar esta pausa" ya llegan relativas a su inicio).
    const clip = await prepareClip(new Uint8Array(await video.arrayBuffer()), parseJsonField(form.get("meta")) as Partial<Meta>, MAX_SECONDS, 0);
    const id = await startSmoothCut(clip.bytes, settings as Record<string, string | number>, key);
    return Response.json({ id });
  } catch (e) {
    const { status, body } = explainError(e);
    return Response.json(body, { status });
  }
}
