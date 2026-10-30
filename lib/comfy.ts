import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { Comfy, type Job } from "@comfyorg/sdk";
import type { Input } from "./plan";
import { UserError } from "./safety.ts";

export type JobOutput = { id: string; name: string; type: string; url: string };
export type PublicJob = { id: string; status: string; outputs: JobOutput[]; error: unknown };

let cached: Comfy | null = null;
// Clave de cada trabajo enviado con la clave del visitante: solo en memoria, para consultar su estado y bajar
// su resultado. Nunca se escribe en disco ni en registros.
const jobKeys = new Map<string, string>();

/** Error con un código que la interfaz entiende (pedir clave, clave inválida, sin créditos). */
export class KeyError extends Error {
  code: "need_key" | "invalid_key" | "no_credits";
  constructor(code: KeyError["code"], message: string) { super(message); this.code = code; }
}

/** ¿Este servidor tiene clave propia para el demo? Con OEV_REQUIRE_USER_KEY=1 se ignora y cada visitante usa la suya. */
export const serverHasKey = () => process.env.OEV_REQUIRE_USER_KEY !== "1" && Boolean(apiKeyFromEnv());

/** Convierte los errores de Comfy Cloud en mensajes que la interfaz puede resolver pidiendo otra clave. */
export function explainError(e: unknown): { status: number; body: { error: string; code?: string } } {
  if (e instanceof KeyError) return { status: e.code === "no_credits" ? 402 : 401, body: { error: e.message, code: e.code } };
  if (e instanceof UserError) return { status: 400, body: { error: e.message } };
  const msg = e instanceof Error ? e.message : String(e);
  if (/subscription or credits|insufficient|credit/i.test(msg)) return { status: 402, body: { error: "This Comfy account has no credits left.", code: "no_credits" } };
  if (/401|403|unauthori[sz]ed|forbidden|invalid api key|api key/i.test(msg)) return { status: 401, body: { error: "Comfy didn't accept this API key.", code: "invalid_key" } };
  // El detalle (rutas, salida de ffmpeg) queda en el registro del servidor; al navegador va un mensaje general.
  console.error("[open-edit-video]", msg);
  return { status: 500, body: { error: "Something went wrong while processing the video. Please try again." } };
}

/** Lee la clave sin mostrarla: COMFY_API_KEY, o COMFYUI_CLOUD_API_KEY de un .env externo (COMFY_ENV_FILE). */
function apiKeyFromEnv() {
  if (process.env.COMFY_API_KEY?.trim()) return process.env.COMFY_API_KEY.trim();
  const file = process.env.COMFY_ENV_FILE ? resolve(process.env.COMFY_ENV_FILE) : "";
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(COMFY_API_KEY|COMFYUI_CLOUD_API_KEY|COMFYUI_API_KEY)\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

/** Cliente de Comfy: con la clave del visitante si la mandó; si no, con la del servidor (si la hay). */
export function comfy(userKey?: string | null) {
  const key = userKey?.trim();
  if (key) return new Comfy({ apiKey: key, clientInfo: "open-edit-video" });
  if (cached) return cached;
  if (!serverHasKey()) throw new KeyError("need_key", "Add your Comfy API key to run this.");
  cached = new Comfy({ apiKey: apiKeyFromEnv(), clientInfo: "open-edit-video" });
  return cached;
}

/** La clave del visitante que viene en la cabecera, o la que se usó para enviar ese trabajo. */
export const keyFor = (req: Request, jobId?: string) => req.headers.get("x-comfy-key")?.trim() || (jobId ? jobKeys.get(jobId) : undefined) || null;

export function publicJob(job: Job): PublicJob {
  return {
    id: job.id,
    status: job.status,
    outputs: job.outputs.map((o) => ({ id: o.id, name: o.name, type: o.type, url: `/api/jobs/${job.id}/outputs/${o.id}` })),
    error: job.error,
  };
}

export type Upload = { node: string; field: string; bytes: Uint8Array; filename: string; contentType: string };

/** Carga `workflows/<name>.api.json`, sube los archivos, aplica los valores del plan y envía el trabajo. */
export async function submit(name: string, uploads: Upload[], inputs: Input[], userKey?: string | null) {
  const c = comfy(userKey);
  const workflow = await c.workflows.fromFile(join(process.cwd(), "workflows", `${name}.api.json`));
  for (const u of uploads) {
    workflow.setInput(u.node, u.field, c.assets.fromBytes(u.bytes, { filename: u.filename, contentType: u.contentType }));
  }
  for (const i of inputs) workflow.setInput(i.node, i.field, i.value);
  const job = await c.submit(workflow);
  if (userKey?.trim()) {
    jobKeys.set(job.id, userKey.trim());
    setTimeout(() => jobKeys.delete(job.id), 6 * 3600_000).unref?.();
  }
  return job;
}

export async function getJob(id: string, userKey?: string | null) {
  return publicJob(await comfy(userKey).jobs.get(id));
}

export async function outputUrl(jobId: string, outputId: string, userKey?: string | null) {
  const job = await comfy(userKey).jobs.get(jobId);
  const out = job.outputs.find((o) => o.id === outputId);
  if (!out) throw new Error("Output not found on this job.");
  return (await out.getDownloadUrl()).url;
}

/**
 * Saldo de la cuenta de la clave. Comfy no lo documenta: es el mismo endpoint que usa el panel de créditos
 * de ComfyUI, y acepta la clave en X-API-Key. Puede cambiar, así que la interfaz lo trata como opcional.
 * Los campos *_cents vienen en centavos de dólar.
 */
export async function balance(userKey?: string | null) {
  const key = userKey?.trim() || (serverHasKey() ? apiKeyFromEnv() : "");
  if (!key) throw new KeyError("need_key", "Add your Comfy API key to see your balance.");
  const r = await fetch("https://api.comfy.org/customers/balance", { headers: { "X-API-Key": key } });
  if (r.status === 401 || r.status === 403) throw new KeyError("invalid_key", "Comfy didn't accept this API key.");
  if (!r.ok) throw new Error(`Balance unavailable (${r.status})`);
  const j = await r.json() as Record<string, number>;
  const usd = (cents?: number) => (typeof cents === "number" ? Math.round(cents) / 100 : null);
  return { available: usd(j.effective_balance_cents ?? j.amount_cents), cloud: usd(j.cloud_credit_balance_cents), pending: usd(j.pending_charges_cents) };
}
