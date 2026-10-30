"use client";

// Línea de tiempo propia: miniaturas del clip, la caja del tramo que se va a editar (se arrastra y se
// estira desde sus bordes) y el cabezal, siempre sincronizado con el video. En Smooth Cut muestra
// además la onda del audio y, en rojo, las pausas que se van a cortar.

import { useEffect, useRef, useState } from "react";

export type Span = { start: number; end: number; kept?: boolean };

export function useThumbs(url: string, duration: number, count = 14) {
  const [thumbs, setThumbs] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    setThumbs([]);
    const v = document.createElement("video");
    v.src = url; v.muted = true; v.preload = "auto"; v.playsInline = true;
    const c = document.createElement("canvas");
    const seek = (t: number) => new Promise<void>((r) => { v.onseeked = () => r(); v.currentTime = t; });
    (async () => {
      if (v.readyState < 1) await new Promise((r) => { v.onloadedmetadata = r; });
      c.height = 64; c.width = Math.max(16, Math.round(64 * v.videoWidth / v.videoHeight));
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const out: string[] = [];
      for (let i = 0; i < count && !cancelled; i++) {
        await seek(Math.min(duration - 0.05, ((i + 0.5) * duration) / count));
        ctx.drawImage(v, 0, 0, c.width, c.height);
        out.push(c.toDataURL("image/jpeg", 0.6));
        if (!cancelled) setThumbs([...out]);
      }
    })().catch(() => {});
    return () => { cancelled = true; v.removeAttribute("src"); v.load(); };
  }, [url, duration, count]);
  return thumbs;
}

/** Audio del clip en el navegador: picos para dibujar la onda y nivel (dB) cada 20 ms para hallar pausas. */
export type Audio = { peaks: number[]; db: number[]; hop: number } | null;

export function useAudio(file: File | null, enabled: boolean) {
  const [audio, setAudio] = useState<Audio | "none" | "loading">("loading");
  useEffect(() => {
    if (!file || !enabled) return;
    let cancelled = false;
    setAudio("loading");
    (async () => {
      const ctx = new AudioContext();
      try {
        const buf = await ctx.decodeAudioData(await file.arrayBuffer());
        const data = buf.getChannelData(0);
        const hop = 0.02, step = Math.round(buf.sampleRate * hop);
        const db: number[] = [];
        for (let i = 0; i < data.length; i += step) {
          let sum = 0;
          const end = Math.min(data.length, i + step);
          for (let j = i; j < end; j++) sum += data[j] * data[j];
          db.push(10 * Math.log10(sum / Math.max(1, end - i) + 1e-10));
        }
        const buckets = 400, per = Math.ceil(data.length / buckets), peaks: number[] = [];
        for (let b = 0; b < buckets; b++) {
          let m = 0;
          for (let j = b * per; j < Math.min(data.length, (b + 1) * per); j += 8) m = Math.max(m, Math.abs(data[j]));
          peaks.push(m);
        }
        const top = Math.max(...peaks, 1e-4);
        if (!cancelled) setAudio({ peaks: peaks.map((p) => p / top), db, hop });
      } catch {
        if (!cancelled) setAudio("none");
      } finally { ctx.close(); }
    })();
    return () => { cancelled = true; };
  }, [file, enabled]);
  return audio;
}

/** Las mismas reglas del servidor (ffmpeg silencedetect + aire), para previsualizar los cortes. */
/**
 * Nivel de silencio adaptado a cada clip: un punto entre el ruido de fondo (percentil 10) y la voz
 * (percentil 95), así funciona igual con grabaciones bajas o altas. `sensitivity` es Quiet 0.25 · Normal 0.35 · Noisy 0.5.
 */
export function silenceLevel(audio: Audio, sensitivity: number) {
  if (!audio || !audio.db.length) return -35;
  const sorted = [...audio.db].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.floor(q * (sorted.length - 1))];
  const floor = at(0.1), speech = at(0.95);
  return Math.round((floor + sensitivity * (speech - floor)) * 10) / 10;
}

export function findCuts(audio: Audio, duration: number, s: { threshold: number; minSilence: number; keepAir: number }): Span[] {
  if (!audio) return [];
  const cuts: Span[] = [];
  let runStart: number | null = null;
  const close = (t: number) => {
    if (runStart !== null && t - runStart >= s.minSilence) {
      const a = runStart + s.keepAir / 2, b = t - s.keepAir / 2;
      if (b - a > 0.05) cuts.push({ start: a, end: b });
    }
    runStart = null;
  };
  audio.db.forEach((d, i) => {
    const t = i * audio.hop;
    if (d < s.threshold) { if (runStart === null) runStart = t; } else close(t);
  });
  close(duration);
  return cuts;
}

type Drag = { mode: "move" | "left" | "right"; x0: number; start0: number; len0: number };

export function Timeline(props: {
  duration: number; current: number; thumbs: string[];
  start: number; length: number; minLength: number; maxLength: number; whole: boolean;
  cuts?: Span[]; peaks?: number[];
  onSelect: (start: number, length: number, seekTo: number) => void;
  onSeek: (t: number) => void;
  onToggleCut?: (c: Span) => void;
}) {
  const { duration, current, thumbs, start, length, whole, cuts, peaks } = props;
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const pct = (t: number) => `${(t / duration) * 100}%`;
  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const secPerPx = () => duration / track.current!.getBoundingClientRect().width;

  function down(e: React.PointerEvent, mode: Drag["mode"] | "track") {
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (whole || mode === "track") {
      const t = timeAt(e.clientX);
      if (whole) { props.onSeek(t); drag.current = null; return; }
      // Dentro de la caja se arrastra sin saltar (por ejemplo, encima de una marca roja de Smooth Cut).
      if (t >= start && t <= start + length) { drag.current = { mode: "move", x0: e.clientX, start0: start, len0: length }; return; }
      // Fuera de la caja: la caja empieza ahí.
      const s = Math.min(Math.max(0, t), Math.max(0, duration - length));
      props.onSelect(s, length, s);
      drag.current = { mode: "move", x0: e.clientX, start0: s, len0: length };
      return;
    }
    drag.current = { mode, x0: e.clientX, start0: start, len0: length };
  }
  function move(e: React.PointerEvent) {
    if (!drag.current) { if (whole && e.buttons) props.onSeek(timeAt(e.clientX)); return; }
    const d = drag.current, dt = (e.clientX - d.x0) * secPerPx();
    const { minLength, maxLength } = props;
    if (d.mode === "move") {
      const s = Math.min(Math.max(0, d.start0 + dt), Math.max(0, duration - d.len0));
      props.onSelect(s, d.len0, s);
    } else if (d.mode === "right") {
      const len = Math.min(maxLength, duration - d.start0, Math.max(minLength, d.len0 + dt));
      props.onSelect(d.start0, len, d.start0 + len - 0.05);
    } else {
      const end = d.start0 + d.len0;
      const s = Math.min(end - minLength, Math.max(0, end - maxLength, d.start0 + dt));
      props.onSelect(s, end - s, s);
    }
  }
  const up = () => { drag.current = null; };

  return (
    <div className="timeline">
      <div className="track" ref={track} onPointerDown={(e) => down(e, "track")} onPointerMove={move} onPointerUp={up}>
        <div className="thumbs">{thumbs.map((t, i) => <img key={i} src={t} alt="" width={114} height={64} draggable={false} />)}</div>
        {peaks && (
          <svg className="wave" viewBox={`0 0 ${peaks.length} 100`} preserveAspectRatio="none" aria-hidden>
            {peaks.map((p, i) => <rect key={i} x={i} y={50 - p * 46} width={0.7} height={Math.max(1, p * 92)} />)}
          </svg>
        )}
        {cuts?.map((c, i) => (
          <button key={i} className={`cut ${c.kept ? "kept" : ""}`} style={{ left: pct(c.start), width: pct(c.end - c.start) }}
            title={c.kept ? "Kept. Click to cut this pause" : "Will be cut. Click to keep this pause"}
            aria-label={`Pause at ${clock(c.start)}, ${c.kept ? "kept" : "will be cut"}`}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); props.onToggleCut?.(c); }} />
        ))}
        {!whole && (
          <>
            <div className="shade" style={{ left: 0, width: pct(start) }} />
            <div className="shade" style={{ left: pct(start + length), right: 0 }} />
            <div className="sel" style={{ left: pct(start), width: pct(length) }} onPointerDown={(e) => down(e, "move")} onPointerMove={move} onPointerUp={up}>
              <span className="handle l" onPointerDown={(e) => down(e, "left")} onPointerMove={move} onPointerUp={up} aria-label="Drag to change where the edit starts" />
              <span className="handle r" onPointerDown={(e) => down(e, "right")} onPointerMove={move} onPointerUp={up} aria-label="Drag to change how long the edit is" />
            </div>
          </>
        )}
        <div className="playhead" style={{ left: pct(current) }} />
      </div>
    </div>
  );
}

export const clock = (t: number) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

/** Un número en segundos que se escribe a mano: se aplica al salir del campo o con Enter, y sigue a la caja. */
function SecondsField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft.replace(",", ".").replace(/[^\d.]/g, ""));
    if (Number.isFinite(v) && draft.trim() !== "") onCommit(v);
    setDraft(null);
  };
  return (
    <label className="sec">
      <span>{label}</span>
      <span className="box">
        <input inputMode="decimal" value={draft ?? value.toFixed(1)} onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); setDraft(null); onCommit(value + (e.key === "ArrowUp" ? 0.1 : -0.1) * (e.shiftKey ? 10 : 1)); }
          }} />
        <i>s</i>
      </span>
    </label>
  );
}

/** Inicio, fin y duración del tramo: se editan aquí o moviendo la caja, y siempre coinciden. */
export function RangeFields({ start, length, duration, minLength, maxLength, onChange }: {
  start: number; length: number; duration: number; minLength: number; maxLength: number;
  onChange: (start: number, length: number, seekTo: number) => void;
}) {
  const clampLen = (l: number, s: number) => Math.min(maxLength, duration - s, Math.max(minLength, l));
  return (
    <div className="range-fields">
      <SecondsField label="Starts at" value={start} onCommit={(v) => {
        const s = Math.min(Math.max(0, v), Math.max(0, duration - minLength));
        onChange(s, clampLen(length, s), s);
      }} />
      <span className="arrow" aria-hidden>→</span>
      <SecondsField label="Ends at" value={start + length} onCommit={(v) => {
        const end = Math.min(duration, Math.max(minLength, v));
        const s = Math.min(start, end - minLength);
        const l = clampLen(end - s, s);
        onChange(end - l, l, end - 0.05);
      }} />
      <span className="arrow" aria-hidden>=</span>
      <SecondsField label="Length" value={length} onCommit={(v) => { const l = clampLen(v, start); onChange(start, l, start); }} />
    </div>
  );
}
