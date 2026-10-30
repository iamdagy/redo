// Prepara el tramo antes de mandarlo a Comfy Cloud: corta solo lo que se va a editar y baja a 30 fps los
// videos de celular a 50/60 fps (LTX acepta hasta 1000 cuadros de audio; a 60 fps eso son 16 s). Así también
// se sube mucho menos. Antes de tocar el archivo, revisa que sea un video de verdad.

import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Meta } from "./plan.ts";
import { assertVideoFile, clampNum, runTool, UserError } from "./safety.ts";

const MAX_FPS = 30;

/**
 * `maxSeconds` es el tope del servidor: aunque alguien llame la API directamente y pida más, no se procesa más.
 * Los valores de `meta` vienen del navegador, así que se tratan como no confiables.
 */
export async function prepareClip(bytes: Uint8Array, rawMeta: Partial<Meta>, maxSeconds: number, pad = 0.25) {
  const dir = await mkdtemp(join(tmpdir(), "oev-prep-"));
  try {
    const src = join(dir, "src"), out = join(dir, "clip.mp4");
    await writeFile(src, bytes);
    const { duration } = await assertVideoFile(src);
    if (duration <= 0) throw new UserError("This video has no length we can read.");
    const start = clampNum(rawMeta.start, 0, Math.max(0, duration - 0.5), 0);
    const length = clampNum(rawMeta.length, 0.5, Math.min(maxSeconds, duration - start), Math.min(5, duration - start));
    const { stdout } = await runTool("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,width,height", "-of", "json", src], 30_000);
    const stream = JSON.parse(stdout).streams?.[0] ?? {};
    const [a, b] = String(stream.r_frame_rate ?? "30/1").split("/").map(Number);
    const fps = b ? a / b : a || 30;
    // Un poco más de lo pedido: el workflow vuelve a cortar a la duración exacta.
    await runTool("ffmpeg", ["-v", "error", "-y", "-ss", start.toFixed(3), "-i", src, "-t", (length + pad).toFixed(3),
      ...(fps > MAX_FPS + 0.5 ? ["-r", String(MAX_FPS)] : []),
      "-c:v", "libx264", "-crf", "12", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]);
    const meta: Meta = {
      width: Number(stream.width) || clampNum(rawMeta.width, 16, 8192, 1280),
      height: Number(stream.height) || clampNum(rawMeta.height, 16, 8192, 720),
      start: 0, length, duration: length + pad,
    };
    return { bytes: new Uint8Array(await readFile(out)), meta, fps: Math.min(fps, MAX_FPS) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
