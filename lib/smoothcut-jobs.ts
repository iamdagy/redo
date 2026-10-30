// Trabajos de Smooth Cut en memoria (un servidor, sin base de datos): suficiente para el demo y uso local.
import { writeFile, mkdtemp, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { smoothCut, type Progress } from "./smoothcut-run.ts";
import { explainError } from "./comfy.ts";
import type { Settings } from "./plan.ts";

type State = { id: string; status: "running" | "completed" | "failed"; progress: Progress[]; output?: string; error?: string; code?: string; summary?: unknown };
const g = globalThis as unknown as { __smoothcut?: Map<string, State> };
const jobs = (g.__smoothcut ??= new Map());

/** En un servidor que corre de forma permanente, borra las carpetas de trabajo de más de 6 horas. */
async function cleanOld() {
  const base = tmpdir(), limit = Date.now() - 6 * 3600_000;
  for (const name of await readdir(base).catch(() => [] as string[])) {
    if (!/^(smoothcut|oev-in)-/.test(name)) continue;
    const dir = join(base, name);
    const info = await stat(dir).catch(() => null);
    if (info && info.mtimeMs < limit) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function startSmoothCut(bytes: Uint8Array, settings: Settings, key?: string | null) {
  cleanOld();
  const id = randomUUID();
  const dir = await mkdtemp(join(tmpdir(), "oev-in-"));
  const input = join(dir, "input.mp4");
  await writeFile(input, bytes);
  const state: State = { id, status: "running", progress: [{ stage: "Starting" }] };
  jobs.set(id, state);
  smoothCut(input, settings, (p) => state.progress.push(p), key)
    .then((r) => { state.status = "completed"; state.output = r.output; state.summary = { cuts: r.plan.cuts.length, removed: r.plan.removedSeconds, transcribed: Boolean(r.words) }; })
    .catch((e) => { const { body } = explainError(e); state.status = "failed"; state.error = body.error; state.code = body.code; });
  return id;
}

export const getSmoothCut = (id: string) => jobs.get(id) ?? null;

/** Cuántos Smooth Cut pueden correr a la vez en este servidor (ffmpeg y whisper usan CPU). */
const MAX_RUNNING = Number(process.env.OEV_MAX_SMOOTHCUTS ?? 2);
export const smoothCutBusy = () => [...jobs.values()].filter((j) => j.status === "running").length >= MAX_RUNNING;
