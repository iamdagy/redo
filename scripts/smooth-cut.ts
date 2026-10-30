// Smooth Cut desde la terminal: npm run smooth-cut -- clip.mp4 '{"minSilence":0.6}'
import { copyFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { smoothCut } from "../lib/smoothcut-run.ts";

const [file, settings = "{}"] = process.argv.slice(2);
const t0 = Date.now();
smoothCut(file, JSON.parse(settings), (p) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${p.stage}${p.done !== undefined ? ` ${p.done}/${p.total}` : ""}${p.detail ? ` — ${p.detail}` : ""}`))
  .then((r) => {
    mkdirSync("outputs", { recursive: true });
    const dest = `outputs/smoothcut-${basename(file, ".mp4")}.mp4`;
    copyFileSync(r.output, dest);
    console.log("saved", dest, "| work dir", r.dir);
  })
  .catch((e) => { console.error(e?.message ?? e); process.exit(1); });
