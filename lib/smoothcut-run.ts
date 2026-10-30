// Corre Smooth Cut de punta a punta en el servidor:
// silencios (ffmpeg) + palabras (whisper.cpp, si está instalado) → plan de cortes → un puente LTX
// por corte en Comfy Cloud (varios a la vez) → ensamble con ffmpeg, con fundidos cortos de audio.

import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { submit, publicJob, outputUrl, explainError } from "./comfy.ts";
import { planBridge, type Settings } from "./plan.ts";
import { planCuts, parseSilences, type Word, type Segment } from "./smoothcut.ts";
import { assertVideoFile, clampNum, runTool } from "./safety.ts";

export type Progress = { stage: string; detail?: string; done?: number; total?: number };

async function probe(file: string) {
  const { stdout } = await runTool("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,r_frame_rate:format=duration", "-of", "json", file], 30_000);
  const j = JSON.parse(stdout);
  const [a, b] = String(j.streams[0].r_frame_rate).split("/").map(Number);
  return { width: j.streams[0].width as number, height: j.streams[0].height as number, duration: Number(j.format.duration), fps: b ? a / b : a };
}

async function silences(file: string, thresholdDb: number, minSilence: number, duration: number): Promise<Segment[]> {
  const { stderr } = await runTool("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", `silencedetect=noise=${thresholdDb.toFixed(1)}dB:d=${Math.max(0.1, minSilence / 2).toFixed(2)}`, "-f", "null", "-"]);
  return parseSilences(stderr, duration);
}

/** Palabras con tiempo usando whisper.cpp (opcional). El prompt con muletillas evita que Whisper las borre. */
async function words(file: string, dir: string): Promise<Word[] | null> {
  const model = process.env.WHISPER_MODEL ?? join(homedir(), ".cache/whisper-cpp/ggml-large-v3-turbo.bin");
  try { await runTool("which", ["whisper-cli"], 5_000); } catch { return null; }
  if (!existsSync(/*turbopackIgnore: true*/ model)) return null;
  const wav = join(dir, "audio.wav");
  await runTool("ffmpeg", ["-v", "error", "-y", "-i", file, "-ac", "1", "-ar", "16000", wav]);
  await runTool("whisper-cli", ["-m", model, "-l", "auto", "-ml", "1", "-sow", "-oj", "-of", join(dir, "t"), "-np",
    "--prompt", "Um, uh, eh, este, o sea, like, you know. So, um, I mean...", "-f", wav], 10 * 60_000);
  const j = JSON.parse(await readFile(join(dir, "t.json"), "utf8"));
  return (j.transcription as { text: string; offsets: { from: number; to: number } }[])
    .map((s) => ({ text: s.text.trim(), start: s.offsets.from / 1000, end: s.offsets.to / 1000 }))
    .filter((w) => w.text && !/^\[.*\]$/.test(w.text));
}

async function frameAt(file: string, t: number, out: string) {
  await runTool("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", out], 60_000);
  return out;
}

async function bridge(a: string, b: string, meta: { width: number; height: number; fps: number }, s: Settings, out: string, key?: string | null) {
  const plan = planBridge(meta, s);
  const job = await submit("bridge", [
    { node: "in_frame_a", field: "image", bytes: new Uint8Array(await readFile(a)), filename: "a.png", contentType: "image/png" },
    { node: "in_frame_b", field: "image", bytes: new Uint8Array(await readFile(b)), filename: "b.png", contentType: "image/png" },
  ], plan.inputs, key);
  await job.result();
  const pub = publicJob(job);
  const o = pub.outputs.find((x) => /\.mp4$/i.test(x.name));
  if (!o) throw new Error(`bridge job ${job.id} returned no video (${pub.status})`);
  await writeFile(out, Buffer.from(await (await fetch(await outputUrl(job.id, o.id, key))).arrayBuffer()));
  return out;
}

async function pool<T>(items: T[], size: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

export async function smoothCut(input: string, s: Settings, onProgress: (p: Progress) => void = () => {}, key?: string | null) {
  const dir = await mkdtemp(join(tmpdir(), "smoothcut-"));
  await assertVideoFile(input);
  const meta = await probe(input);
  // Los ajustes vienen del navegador: se acotan aquí para que nadie pida valores que disparen trabajos enormes.
  const minSilence = clampNum(s.minSilence, 0.15, 2, 0.6), keepAir = clampNum(s.keepAir, 0, 0.6, 0.15);
  s = { ...s, bridge: [9, 17].includes(Number(s.bridge)) ? String(s.bridge) : "17", bridges: s.bridges === "off" ? "off" : "on" };
  onProgress({ stage: "Listening for silences" });
  const sil = await silences(input, clampNum(s.threshold, -90, -5, -35), minSilence, meta.duration);
  onProgress({ stage: "Transcribing words" });
  const w = await words(input, dir).catch(() => null);
  const keepAt = Array.isArray(s.keepPausesAt) ? (s.keepPausesAt as unknown[]).slice(0, 500).map(Number).filter(Number.isFinite) : [];
  const plan = planCuts({ duration: meta.duration, words: w ?? undefined, silences: sil, minSilence, keepAir, keepAt });
  const joins = plan.kept.length - 1;
  onProgress({ stage: "Planned", detail: `${plan.cuts.length} cuts, ${plan.removedSeconds.toFixed(1)} s removed${w ? "" : " (silences only: whisper.cpp not found)"}`, total: joins });

  const fps = meta.fps;
  const bridges: (string | null)[] = new Array(Math.max(0, joins)).fill(null);
  const useBridges = String(s.bridges ?? "on") !== "off";
  if (useBridges && joins > 0) {
    let done = 0;
    await pool([...Array(joins).keys()], 3, async (i) => {
      const a = await frameAt(input, Math.max(0, plan.kept[i].end - 1 / fps), join(dir, `a${i}.png`));
      const b = await frameAt(input, plan.kept[i + 1].start, join(dir, `b${i}.png`));
      try { bridges[i] = await bridge(a, b, { width: meta.width, height: meta.height, fps }, s, join(dir, `bridge${i}.mp4`), key); }
      catch (e) {
        // Sin clave o sin créditos no tiene sentido seguir: se avisa en vez de entregar solo cortes secos.
        if (explainError(e).body.code) throw e;
        onProgress({ stage: "Bridge failed, using a straight cut", detail: (e as Error).message });
      }
      onProgress({ stage: "Generating bridges", done: ++done, total: joins });
    });
  }

  onProgress({ stage: "Assembling" });
  // Un solo filtro: tramos conservados (con fundido de audio de 20 ms) + puentes sin su primer y último cuadro
  // (son iguales a A y B) con silencio del mismo largo.
  const args = ["-v", "error", "-y", "-i", input];
  const parts: string[] = [];
  const filters: string[] = [];
  const W = meta.width - (meta.width % 2), H = meta.height - (meta.height % 2);
  let n = 0;
  plan.kept.forEach((k, i) => {
    filters.push(`[0:v]trim=${k.start.toFixed(3)}:${k.end.toFixed(3)},setpts=PTS-STARTPTS,scale=${W}:${H},fps=${fps.toFixed(3)},format=yuv420p[v${n}]`);
    const d = k.end - k.start;
    filters.push(`[0:a]atrim=${k.start.toFixed(3)}:${k.end.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, d - 0.02).toFixed(3)}:d=0.02[a${n}]`);
    parts.push(`[v${n}][a${n}]`); n++;
    const br = bridges[i];
    if (br) {
      const idx = args.filter((x) => x === "-i").length;
      args.push("-i", br);
      filters.push(`[${idx}:v]trim=start_frame=1,setpts=PTS-STARTPTS,scale=${W}:${H},fps=${fps.toFixed(3)},format=yuv420p,trim=end_frame=${Number(s.bridge ?? 17) - 2}[v${n}]`);
      const bd = (Number(s.bridge ?? 17) - 2) / fps;
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${bd.toFixed(3)}[a${n}]`);
      parts.push(`[v${n}][a${n}]`); n++;
    }
  });
  filters.push(`${parts.join("")}concat=n=${n}:v=1:a=1[v][a]`);
  const out = join(dir, "smooth-cut.mp4");
  await runTool("ffmpeg", [...args, "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", out], 10 * 60_000);
  await writeFile(join(dir, "plan.json"), JSON.stringify({ meta, plan, words: w, bridges: bridges.map(Boolean) }, null, 2));
  onProgress({ stage: "Done", detail: `${meta.duration.toFixed(1)} s → ${(plan.finalSeconds + bridges.filter(Boolean).length * (Number(s.bridge ?? 17) - 2) / fps).toFixed(1)} s` });
  return { output: out, dir, plan, words: w, files: await readdir(dir) };
}
