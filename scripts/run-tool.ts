// Prueba una herramienta desde la terminal, sin la interfaz:
//   npm run run-tool -- reframe clip.mp4 '{"aspect":"9:16"}'
//   npm run run-tool -- bridge frameA.png frameB.png '{"bridge":"17"}' 1920 1080 25
// Lee COMFY_API_KEY de .env.local, envía el trabajo, espera y baja la salida a outputs/.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { submit, outputUrl, publicJob } from "../lib/comfy.ts";
import { planReframe, planRemove, planUpscale, planCutout, planBridge, type Meta, type Settings } from "../lib/plan.ts";

function loadEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function probe(file: string): Meta & { fps: number } {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(out);
  const [a, b] = String(j.streams[0].r_frame_rate).split("/").map(Number);
  return { width: j.streams[0].width, height: j.streams[0].height, duration: Number(j.format.duration), fps: b ? a / b : a };
}

async function main() {
  loadEnv();
  const [tool, ...args] = process.argv.slice(2);
  const t0 = Date.now();
  let job;
  if (tool === "bridge") {
    const [a, b, settings = "{}", w = "1920", h = "1080", fps = "25"] = args;
    const plan = planBridge({ width: Number(w), height: Number(h), fps: Number(fps) }, JSON.parse(settings) as Settings);
    job = await submit("bridge", [
      { node: "in_frame_a", field: "image", bytes: readFileSync(a), filename: basename(a), contentType: "image/png" },
      { node: "in_frame_b", field: "image", bytes: readFileSync(b), filename: basename(b), contentType: "image/png" },
    ], plan.inputs);
  } else {
    const [file, settings = "{}"] = args;
    const s = JSON.parse(settings) as Settings;
    // `start`/`length` en segundos; Remove recibe además `pointX`/`pointY` (fracciones del cuadro en `start`).
    const meta = { ...probe(file), start: Number(s.start ?? 0), length: Number(s.length ?? 5) };
    const plan = tool === "reframe" ? planReframe(meta, s, 30) : tool === "remove" ? planRemove(meta, s, 30)
      : tool === "upscale" ? planUpscale(meta, s, 30) : tool === "cutout" ? planCutout(meta, s, 30) : null;
    if (!plan) throw new Error(`unknown tool ${tool}`);
    if ("geometry" in plan) console.log("geometry", JSON.stringify(plan.geometry));
    if (process.env.PLAN_ONLY) { console.log(JSON.stringify(plan.inputs)); return; }
    job = await submit(process.env.OEV_WORKFLOW || tool, [{ node: "in_video", field: "file", bytes: readFileSync(file), filename: basename(file), contentType: "video/mp4" }], plan.inputs);
  }
  console.log(`submitted ${job.id}`);
  await job.result();
  const pub = publicJob(job);
  console.log(`status ${pub.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (pub.error) console.log("error", JSON.stringify(pub.error).slice(0, 2000));
  mkdirSync("outputs", { recursive: true });
  for (const o of pub.outputs) {
    const url = await outputUrl(job.id, o.id);
    const dest = join("outputs", `${tool}-${job.id.slice(0, 8)}-${basename(o.name)}`);
    writeFileSync(dest, Buffer.from(await (await fetch(url)).arrayBuffer()));
    console.log("saved", dest);
  }
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
