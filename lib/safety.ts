// Defensas del servidor. La app recibe videos de cualquiera y los pasa a ffmpeg: todo lo que llega se
// valida aquí, no solo en la interfaz.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Tope de subida. Cloudflare (plan gratis) ya corta en 100 MB; esto protege también en local. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Corre un programa externo sin shell (los argumentos nunca se interpretan) y con tiempo máximo,
 * para que un archivo hecho para trabar a ffmpeg o whisper no deje el proceso colgado.
 */
export function runTool(cmd: string, args: string[], timeoutMs = 5 * 60_000) {
  return exec(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 << 20, windowsHide: true });
}

// Solo contenedores de video reales. Así ffmpeg nunca abre listas de reproducción (HLS, concat, etc.),
// que pueden apuntar a archivos locales del servidor y copiarlos dentro del video de salida.
const ALLOWED_FORMATS = new Set(["mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm"]);

/** Revisa con ffprobe que el archivo sea un video de verdad (contenedor permitido y una pista de video). */
export async function assertVideoFile(file: string) {
  let info: { format?: { format_name?: string; duration?: string }; streams?: { codec_type?: string }[] };
  try {
    const { stdout } = await runTool("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type", "-of", "json", file], 30_000);
    info = JSON.parse(stdout);
  } catch {
    throw new UserError("This file is not a video we can read.");
  }
  const formats = String(info.format?.format_name ?? "").split(",");
  if (!formats.some((f) => ALLOWED_FORMATS.has(f))) throw new UserError("Please upload an MP4, MOV or WebM video.");
  if (!info.streams?.some((s) => s.codec_type === "video")) throw new UserError("This file has no video track.");
  return { duration: Number(info.format?.duration) || 0 };
}

/** Error con un mensaje pensado para el usuario (se muestra tal cual). */
export class UserError extends Error {}

/** Número dentro de un rango; cualquier otra cosa vuelve al valor por defecto. */
export function clampNum(value: unknown, min: number, max: number, fallback: number) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Lee el JSON de un campo del formulario sin romper la ruta si viene mal formado. */
export function parseJsonField(value: FormDataEntryValue | null): Record<string, unknown> {
  try {
    const v = JSON.parse(String(value ?? "{}"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    throw new UserError("The request was malformed.");
  }
}

/** Corta la subida demasiado grande antes de leerla entera en memoria. */
export function uploadTooBig(req: Request) {
  const len = Number(req.headers.get("content-length") ?? 0);
  return len > MAX_UPLOAD_BYTES + 1024 * 1024;
}
