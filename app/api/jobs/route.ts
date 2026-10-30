import { submit, publicJob, keyForNewJob, explainError } from "@/lib/comfy";
import { planReframe, planRemove, planUpscale, planCutout, type Meta, type Settings } from "@/lib/plan";
import tools from "@/presets/tools.json";
import { prepareClip } from "@/lib/prep";
import { MAX_UPLOAD_BYTES, parseJsonField, uploadTooBig } from "@/lib/safety";

export const runtime = "nodejs";

const PLANS = { reframe: planReframe, remove: planRemove, upscale: planUpscale, cutout: planCutout } as const;

export async function POST(req: Request) {
  try {
    if (uploadTooBig(req)) return Response.json({ error: "That video is too large (200 MB max)." }, { status: 413 });
    const form = await req.formData();
    const tool = String(form.get("tool"));
    const video = form.get("video");
    if (!(video instanceof File)) return Response.json({ error: "Upload a video first." }, { status: 400 });
    if (video.size > MAX_UPLOAD_BYTES) return Response.json({ error: "That video is too large (200 MB max)." }, { status: 413 });
    if (!Object.hasOwn(PLANS, tool)) return Response.json({ error: "Unknown tool." }, { status: 400 });
    const settings = parseJsonField(form.get("settings")) as Settings;
    // El tope de segundos lo pone el servidor, no el navegador.
    const prepared = await prepareClip(new Uint8Array(await video.arrayBuffer()), parseJsonField(form.get("meta")) as Partial<Meta>, tools.limits.maxSeconds);
    const meta = { ...prepared.meta, fps: prepared.fps };
    const plan = PLANS[tool as keyof typeof PLANS](meta, settings, tools.limits.maxSeconds);
    const job = await submit(tool, [{
      node: "in_video", field: "file", bytes: prepared.bytes,
      filename: "input.mp4", contentType: "video/mp4",
    }], plan.inputs, keyForNewJob(req));
    return Response.json({ job: publicJob(job), geometry: "geometry" in plan ? plan.geometry : null });
  } catch (e) {
    const { status, body } = explainError(e);
    return Response.json(body, { status });
  }
}
