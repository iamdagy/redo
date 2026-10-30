// Smooth Cut: qué se corta en un video de una persona hablando.
// Reglas, no modelo: instantáneas, explicables y que no
// confunden "este video" con una muletilla. Funciona con palabras con tiempo (Whisper) o, si no
// hay transcripción, solo con los silencios que detecta ffmpeg.

export type Word = { text: string; start: number; end: number };
export type Range = { start: number; end: number; reason: "pause" | "filler" | "repeat" | "silence" };
export type Segment = { start: number; end: number };

const ALWAYS = new Set(["eh", "ehh", "ehhh", "em", "emm", "mm", "mmm", "ah", "ahh", "eeh", "um", "umm", "uh", "uhh", "erm", "hmm"]);
// Solo son muletillas seguidas de pausa o coma ("este video" y "like this" no lo son).
const CONDITIONAL = new Set(["este", "bueno", "pues", "entonces", "digamos", "like", "so", "well", "basically", "actually"]);
const PAIRS: [string, string][] = [["o", "sea"], ["you", "know"], ["i", "mean"], ["or", "something"]];
const PAUSE_AFTER = 0.32;
const RESIDUAL_GAP = 0.09; // aire que se deja en cada corte para que no se "coma" la palabra vecina

export const normalize = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zñ0-9']/g, "");

export function fillerRanges(words: Word[]): Range[] {
  const cuts: Range[] = [];
  for (let i = 0; i < words.length; ) {
    const w = words[i], next = words[i + 1];
    const key = normalize(w.text);
    const trailing = w.text.trim();
    const gapAfter = (next?.start ?? w.end + 1) - w.end;
    const paused = gapAfter >= PAUSE_AFTER || /[,…]$|\.\.\.$/.test(trailing);
    let span: [number, number] | null = null;
    if (ALWAYS.has(key)) span = [i, i];
    else if (CONDITIONAL.has(key) && paused) span = [i, i];
    else if (next) {
      for (const [a, b] of PAIRS) {
        if (key === a && normalize(next.text) === b) {
          const afterPair = (words[i + 2]?.start ?? next.end + 1) - next.end;
          if (/,$/.test(next.text.trim()) || afterPair >= PAUSE_AFTER) span = [i, i + 1];
        }
      }
    }
    if (span) {
      const first = words[span[0]], last = words[span[1]];
      const prevEnd = span[0] > 0 ? words[span[0] - 1].end : 0;
      const nextStart = words[span[1] + 1]?.start ?? last.end + 0.2;
      const start = Math.max(prevEnd + RESIDUAL_GAP, first.start - 0.04);
      const end = Math.max(last.end, nextStart - RESIDUAL_GAP);
      if (end - start >= 0.08) cuts.push({ start, end, reason: "filler" });
      i = span[1] + 1;
    } else i += 1;
  }
  return cuts;
}

/** La primera de dos palabras iguales seguidas ("la la mochila", "the the"): una retoma. */
export function repeatRanges(words: Word[]): Range[] {
  const cuts: Range[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i], b = words[i + 1];
    const k = normalize(a.text);
    if (k && k === normalize(b.text) && b.start - a.end < 0.6) cuts.push({ start: a.start, end: Math.max(a.end, b.start - RESIDUAL_GAP / 2), reason: "repeat" });
  }
  return cuts;
}

/** Pausas entre palabras más largas que `maxGap`, dejando `keepAir` de aire repartido a cada lado. */
export function pauseRanges(words: Word[], maxGap: number, keepAir: number): Range[] {
  const cuts: Range[] = [];
  if (words[0] && words[0].start > maxGap) cuts.push({ start: 0, end: words[0].start - keepAir / 2, reason: "pause" });
  for (let i = 0; i + 1 < words.length; i++) {
    const gap = words[i + 1].start - words[i].end;
    if (gap > maxGap) cuts.push({ start: words[i].end + keepAir / 2, end: words[i + 1].start - keepAir / 2, reason: "pause" });
  }
  return cuts;
}

/** Silencios de ffmpeg (silencedetect) convertidos en cortes, dejando aire a cada lado. */
export function silenceRanges(silences: Segment[], minSilence: number, keepAir: number): Range[] {
  return silences
    .filter((s) => s.end - s.start >= minSilence)
    .map((s) => ({ start: s.start + keepAir / 2, end: s.end - keepAir / 2, reason: "silence" as const }))
    .filter((r) => r.end - r.start > 0.05);
}

/** Une cortes que se tocan y devuelve los tramos que se conservan. */
export function keptSegments(cuts: Range[], duration: number, minKeep = 0.25): { kept: Segment[]; cuts: Range[] } {
  const sorted = [...cuts].map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(duration, c.end) }))
    .filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 0.02) { last.end = Math.max(last.end, c.end); if (last.reason !== c.reason) last.reason = "pause"; }
    else merged.push({ ...c });
  }
  const kept: Segment[] = [];
  let t = 0;
  for (const c of merged) { if (c.start - t >= minKeep) kept.push({ start: t, end: c.start }); t = c.end; }
  if (duration - t >= minKeep) kept.push({ start: t, end: duration });
  return { kept, cuts: merged };
}

/** Plan completo: con palabras usa muletillas, retomas y pausas; si no, solo silencios. */
export function planCuts(opts: { duration: number; words?: Word[]; silences?: Segment[]; minSilence: number; keepAir: number; keepAt?: number[] }) {
  const { duration, words, silences, minSilence, keepAir, keepAt = [] } = opts;
  // Los silencios salen siempre de ffmpeg: Whisper suele estirar la última palabra sobre la pausa.
  const cuts: Range[] = [
    ...silenceRanges(silences ?? [], minSilence, keepAir),
    ...(words?.length ? [...fillerRanges(words), ...repeatRanges(words), ...pauseRanges(words, minSilence, keepAir)] : []),
  ];
  // Las pausas que el usuario marcó para conservar no se cortan.
  const wanted = cuts.filter((c) => !keepAt.some((t) => t >= c.start - 0.05 && t <= c.end + 0.05));
  const { kept, cuts: merged } = keptSegments(wanted, duration);
  const removed = merged.reduce((s, c) => s + (c.end - c.start), 0);
  return { kept, cuts: merged, removedSeconds: removed, finalSeconds: kept.reduce((s, k) => s + (k.end - k.start), 0) };
}

/** Lee la salida de `ffmpeg -af silencedetect` (stderr). */
export function parseSilences(stderr: string, duration: number): Segment[] {
  const out: Segment[] = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    if (e && start !== null) { out.push({ start, end: Number(e[1]) }); start = null; }
  }
  if (start !== null) out.push({ start, end: duration });
  return out;
}
