"use client";

// Editor de una sola pantalla: herramientas a la izquierda, video al centro y ajustes a la derecha.
// Un solo reproductor propio (sin controles nativos) con línea de tiempo: la caja marca el tramo
// que se edita y el cabezal siempre sigue al video. Cada herramienta dibuja su vista previa encima.

import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { reframeGeometry } from "@/lib/plan";
import { KeyDialog, loadKey, type KeyReason } from "./key";
import { Timeline, RangeFields, useThumbs, useAudio, findCuts, silenceLevel, clock, type Span } from "./timeline";
import { ReframePanel, RemovePanel, SmoothCutPanel, UpscalePanel, CutoutPanel, Tip, upscaleSize, backgroundName, type Settings } from "./panels";

type Tool = { id: string; name: string; short: string; tagline: string; model: string; defaults: Settings; secondsPer5s: number };
export type Config = { tools: Tool[]; limits: { defaultSeconds: number; maxSeconds: number; maxLongSide: number } };
type Output = { id: string; name: string; type: string; url: string };
type Result = { id: string; tool: string; status: string; outputs: Output[]; error?: string; startedAt: number; seconds?: number; estimate: number; label: string; stage?: string; src: { url: string; width: number; height: number; start: number } };
type Clip = { file: File; url: string; width: number; height: number; duration: number };

// Íconos de línea, mismo trazo para todas las herramientas.
const ICONS: Record<string, React.ReactNode> = {
  reframe: <><rect x="7" y="3" width="10" height="18" rx="1.5" /><path d="M3 9v6M21 9v6" /></>,
  remove: <><path d="M4 20h16" /><path d="M14.5 4.5l5 5L10 19H5v-5z" /></>,
  smoothcut: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8 7.5L20 18M8 16.5L20 6" /></>,
  upscale: <><rect x="3" y="11" width="10" height="10" rx="1" /><path d="M13 3h8v8M21 3l-8 8" /></>,
  cutout: <><circle cx="12" cy="9" r="3.5" /><path d="M5 21c0-4 3-6.5 7-6.5s7 2.5 7 6.5" /><rect x="2.5" y="2.5" width="19" height="19" rx="2" strokeDasharray="2 3" /></>,
};
const TOOL_NAMES: Record<string, string> = { reframe: "Reframe", remove: "Remove", smoothcut: "Smooth Cut", upscale: "Upscale", cutout: "Remove background" };
const PANELS = { reframe: ReframePanel, remove: RemovePanel, smoothcut: SmoothCutPanel, upscale: UpscalePanel, cutout: CutoutPanel } as const;

function readMeta(file: File): Promise<Clip> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata"; v.src = url; v.muted = true;
    v.onloadedmetadata = () => resolve({ file, url, width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    v.onerror = () => reject(new Error("This file is not a playable video."));
  });
}

const minutes = (s: number) => (s < 50 ? `${Math.max(10, Math.round(s / 10) * 10)} s` : `${Math.round(s / 60) || 1} min`);

export default function Editor({ config }: { config: Config }) {
  const [toolId, setToolId] = useState(config.tools[0].id);
  const tool = config.tools.find((t) => t.id === toolId)!;
  const [settings, setSettings] = useState<Record<string, Settings>>(() => Object.fromEntries(config.tools.map((t) => [t.id, { ...t.defaults }])));
  const [clip, setClip] = useState<Clip | null>(null);
  const [start, setStart] = useState(0);
  const [length, setLength] = useState(config.limits.defaultSeconds);
  const [results, setResults] = useState<Result[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(true);
  // El último trabajo lanzado: al terminar se muestra solo, salvo que el usuario haya abierto otro resultado.
  const lastLaunched = useRef<string | null>(null);
  const pickedOther = useRef(false);
  const openResult = (id: string | null) => { if (id && id !== lastLaunched.current) pickedOther.current = true; setSelected(id); };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const fileInput = useRef<HTMLInputElement>(null);
  // Clave de Comfy del visitante (vive en su navegador). serverKey dice si este servidor trae la suya.
  const keyRef = useRef("");
  const [hasKey, setHasKey] = useState(false);
  const [serverKey, setServerKey] = useState<boolean | null>(null);
  const [keyDialog, setKeyDialog] = useState<{ reason: KeyReason; thenRun: boolean } | null>(null);
  // Acceso de invitado: `?access=<código>` se guarda en el navegador y se quita de la barra de direcciones.
  const accessRef = useRef("");
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("access");
      if (code) { localStorage.setItem("oev.access", code); url.searchParams.delete("access"); window.history.replaceState(null, "", url.pathname + url.search + url.hash); }
      accessRef.current = localStorage.getItem("oev.access") ?? "";
    } catch { /* sin almacenamiento: no hay acceso de invitado */ }
    keyRef.current = loadKey(); setHasKey(Boolean(keyRef.current));
    fetch("/api/config", { headers: accessRef.current ? { "x-oev-access": accessRef.current } : {} })
      .then((r) => r.json()).then((c) => setServerKey(Boolean(c.serverKey))).catch(() => setServerKey(false));
  }, []);
  const auth = (): Record<string, string> => ({
    ...(keyRef.current ? { "x-comfy-key": keyRef.current } : {}),
    ...(accessRef.current ? { "x-oev-access": accessRef.current } : {}),
  });

  const s = settings[toolId];
  const set = (k: string, v: string | number) => setSettings((all) => ({ ...all, [toolId]: { ...all[toolId], [k]: v } }));
  // Smooth Cut usa la misma franja de tiempo que las demás herramientas; solo cambia el tope (es barato por segundo).
  const isCut = toolId === "smoothcut";
  const whole = false;
  const maxSeconds = isCut ? 180 : config.limits.maxSeconds;
  const span = clip ? Math.min(length, clip.duration - start) : 0;
  const seconds = span;

  const audio = useAudio(clip?.file ?? null, isCut);
  // Pausas que el usuario decidió conservar (clic en la marca roja). Se guardan como un instante dentro
  // de la pausa, así sobreviven a cambios de ajustes que muevan un poco sus bordes.
  const [keptAt, setKeptAt] = useState<number[]>([]);
  useEffect(() => setKeptAt([]), [clip]);
  // Pausas dentro de la franja elegida (las de afuera no se tocan).
  const allCuts = useMemo(() => (clip && isCut && typeof audio === "object" ? findCuts(audio, clip.duration, {
    threshold: silenceLevel(audio, Number(s.sensitivity ?? 0.35)), minSilence: Number(s.minSilence), keepAir: Number(s.keepAir),
  }).map((c) => ({ start: Math.max(c.start, start), end: Math.min(c.end, start + span) })).filter((c) => c.end - c.start > 0.05) : []),
  [clip, isCut, audio, s.sensitivity, s.minSilence, s.keepAir, start, span]);
  const shownCuts = useMemo(() => allCuts.map((c) => ({ ...c, kept: keptAt.some((t) => t >= c.start && t <= c.end) })), [allCuts, keptAt]);
  const cuts = useMemo(() => shownCuts.filter((c) => !c.kept), [shownCuts]);
  const toggleCut = (c: Span) => setKeptAt((ks) => c.kept ? ks.filter((t) => t < c.start || t > c.end) : [...ks, (c.start + c.end) / 2]);

  const selectedResult = results.find((r) => r.id === selected) ?? null;
  const resultVideo = selectedResult?.status === "completed"
    ? selectedResult.outputs.find((o) => (o.type.startsWith("video") || /\.(mp4|webm)$/i.test(o.name)) && !/matte/.test(o.name)) : undefined;

  const running = results.some((r) => !["completed", "failed", "cancelled", "error"].includes(r.status));
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [running]);

  function estimate(): number {
    if (isCut) {
      const bridges = s.bridges === "off" ? 0 : cuts.length;
      return 10 + Math.ceil(bridges / 3) * 18;
    }
    let k = tool.secondsPer5s * Math.max(0.35, seconds / 5); // los clips muy cortos no bajan del costo fijo de cada trabajo
    if ((toolId === "reframe" || toolId === "remove") && s.quality === "high") k *= 1.8;
    if ((toolId === "reframe" || toolId === "remove") && s.quality === "fast") k *= 0.7;
    if (toolId === "upscale" && String(s.model).startsWith("7B")) k *= 2;
    return k;
  }

  async function pick(file?: File | null) {
    if (!file) return;
    setError(null);
    try {
      const c = await readMeta(file);
      setClip(c); setStart(0); setLength(Math.min(config.limits.defaultSeconds, c.duration)); setSelected(null);
    } catch (e) { setError((e as Error).message); }
  }

  async function run() {
    if (!clip) { fileInput.current?.click(); return; }
    if (toolId === "remove" && !hasPoint && !String(s.what).trim()) { setError("Click what should disappear, or describe it."); return; }
    const needsComfy = !(isCut && s.bridges === "off");
    if (needsComfy && !keyRef.current && serverKey === false) { setKeyDialog({ reason: "need_key", thenRun: true }); return; }
    setBusy(true); setError(null);
    const form = new FormData();
    form.set("tool", tool.id);
    form.set("video", clip.file);
    form.set("meta", JSON.stringify({ width: clip.width, height: clip.height, duration: clip.duration, start, length: span }));
    form.set("settings", JSON.stringify(isCut ? { ...s, threshold: typeof audio === "object" ? silenceLevel(audio, Number(s.sensitivity ?? 0.35)) : -35, keepPausesAt: keptAt.filter((t) => t >= start && t <= start + span).map((t) => t - start) } : s));
    try {
      const res = await fetch(isCut ? "/api/smoothcut" : "/api/jobs", { method: "POST", body: form, headers: auth() });
      const body = await res.json();
      if (body.code) { setKeyDialog({ reason: body.code, thenRun: true }); return; }
      if (!res.ok) throw new Error(body.error ?? "The job could not start.");
      const id = isCut ? body.id : body.job.id;
      const r: Result = { id, tool: tool.id, status: isCut ? "running" : body.job.status, outputs: [], startedAt: Date.now(), estimate: estimate(), label: summary(tool.id, s, span, start),
        src: { url: clip.url, width: clip.width, height: clip.height, start } };
      setResults((rs) => [r, ...rs]); setSelected(r.id); setShowResults(true);
      lastLaunched.current = r.id; pickedOther.current = false;
      poll(r.id, isCut);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function poll(id: string, isCut: boolean) {
    let misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, misses ? Math.min(15000, 2500 * 2 ** misses) : 2500));
      // Si se cae la red o el servidor responde mal un momento, se sigue esperando: el trabajo sigue en Cloud.
      let res: Response, job: { [k: string]: unknown } & { status?: string; code?: KeyReason; stage?: string; outputs?: Output[]; error?: unknown };
      try {
        res = await fetch(isCut ? `/api/smoothcut/${id}` : `/api/jobs/${id}`, { headers: auth() });
        job = await res.json();
        if (res.status >= 500 && !job.code) throw new Error(String(job.error ?? res.status));
        misses = 0;
      } catch {
        misses++;
        setResults((rs) => rs.map((r) => r.id === id ? { ...r, stage: misses > 2 ? "Connection lost, still waiting for the result" : r.stage } : r));
        if (misses < 12) continue;
        res = new Response(null, { status: 599 }); job = { status: "failed", error: "Lost contact with the server. The job may still finish on Comfy Cloud." };
      }
      if (job.code) setKeyDialog({ reason: job.code, thenRun: false });
      if (job.status === "succeeded") job.status = "completed";
      const done = ["completed", "failed", "cancelled", "error"].includes(job.status ?? "") || !res.ok;
      setResults((rs) => rs.map((r) => r.id === id ? {
        ...r, status: res.ok ? job.status ?? "error" : "failed", outputs: job.outputs ?? [], stage: job.stage,
        error: job.error ? (typeof job.error === "string" ? job.error : JSON.stringify(job.error)) : undefined,
        seconds: done ? Math.round((Date.now() - r.startedAt) / 1000) : undefined,
      } : r));
      if (done) {
        if (job.status === "completed" && lastLaunched.current === id && !pickedOther.current) { setSelected(id); setShowResults(true); }
        return;
      }
    }
  }

  async function useResultAsInput(r: Result) {
    const out = r.outputs.find((o) => /\.(mp4|webm)$/i.test(o.name) && !/matte/.test(o.name));
    if (!out) return;
    const blob = await (await fetch(out.url)).blob();
    await pick(new File([blob], `${r.tool}-${r.id.slice(0, 6)}.mp4`, { type: "video/mp4" }));
  }

  const Panel = PANELS[toolId as keyof typeof PANELS];
  const hasPoint = s.pointX !== undefined && s.pointX !== "";
  // Por qué no se puede correr todavía, dicho en el mismo botón.
  const blocked = !clip ? null
    : toolId === "remove" && !hasPoint && !String(s.what).trim() ? "Click what to remove"
    : isCut && audio === "none" ? "This clip has no sound"
    : isCut && typeof audio === "object" && cuts.length === 0 ? "No pauses in this part"
    : null;
  const changed = Object.keys(tool.defaults).some((k) => k !== "seed" && String(tool.defaults[k]) !== String(s[k]));
  const cutSummary = isCut && clip ? (
    audio === "loading" ? <p className="note">Listening to the audio…</p>
      : audio === "none" ? <p className="note bad">This clip has no sound, so there are no pauses to cut.</p>
      : (() => {
        const removed = cuts.reduce((a, c) => a + c.end - c.start, 0);
        return (
          <div className="stat">
            <b>{cuts.length} {cuts.length === 1 ? "pause" : "pauses"} to cut <Tip text="Found in your audio and shown in red on the timeline. Click a red mark to keep that pause. Filler words (um, uh, eh, “o sea”, “you know”) are also cut when the server can transcribe the speech." /></b>
            <span>{span.toFixed(1)} s → {(span - removed).toFixed(1)} s{shownCuts.length > cuts.length ? ` · ${shownCuts.length - cuts.length} kept` : ""}</span>
          </div>
        );
      })()
  ) : null;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="mark" aria-hidden>
          <svg viewBox="0 0 24 24"><path d="M3 8V5a2 2 0 012-2h3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M8 21H5a2 2 0 01-2-2v-3" /><path d="M10 8.5v7l5.5-3.5z" fill="currentColor" stroke="none" /></svg>
        </div>
        <span className="wordmark">Redo</span>
        <span className="product">Open Edit Video</span>
        <span className="spacer" />
        <span className="event">Comfy Challenge</span>
      </header>
    <div className={`app ${results.length && showResults ? "with-results" : ""}`}>
      {keyDialog && (
        <KeyDialog reason={keyDialog.reason} hasKey={hasKey}
          onClose={() => setKeyDialog(null)}
          onSave={(k) => {
            keyRef.current = k; setHasKey(Boolean(k));
            const again = keyDialog.thenRun && Boolean(k);
            setKeyDialog(null);
            if (again) setTimeout(run, 0);
          }} />
      )}
      <aside className="rail" aria-label="Tools">
        {config.tools.map((t) => (
          <button key={t.id} className={`tool ${t.id === toolId ? "on" : ""}`} onClick={() => { setToolId(t.id); setSelected(null); }}>
            <svg className="icon" viewBox="0 0 24 24" aria-hidden>{ICONS[t.id]}</svg>
            <span>{t.name}</span>
          </button>
        ))}
        {results.length > 0 && (
          <button className={`resbtn ${showResults ? "on" : ""}`} onClick={() => setShowResults((v) => !v)} aria-pressed={showResults}
            title={showResults ? "Hide results" : "Show results"}>
            <svg viewBox="0 0 24 24" aria-hidden><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /></svg>
            <span>Results</span>
            <b className="count">{results.length}</b>
          </button>
        )}
        <button className={`keybtn ${hasKey ? "on" : ""}`} onClick={() => setKeyDialog({ reason: "manage", thenRun: false })}
          title={hasKey ? "Using your Comfy API key" : "Add your Comfy API key"}>
          <svg viewBox="0 0 24 24" aria-hidden><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3M14 9l2 2" /></svg>
          <span>{hasKey ? "Your key ✓" : "API key"}</span>
        </button>
        <div className="rail-foot">Open weights</div>
      </aside>

      {results.length > 0 && showResults && (
        <aside className="results" aria-label="Results">
          <h2>Results <span>{results.length}</span><button className="close" onClick={() => setShowResults(false)} aria-label="Hide results" title="Hide results">×</button></h2>
          {results.map((r) => {
            const out = r.outputs.find((o) => /\.(mp4|webm)$/i.test(o.name) && !/matte/.test(o.name));
            const failed = r.status === "failed" || r.status === "error";
            return (
              <button key={r.id} className={`rcard ${r.id === selected ? "on" : ""} ${failed ? "bad" : ""}`} onClick={() => openResult(r.id)}>
                <span className="thumb">
                  {out ? <video src={`${out.url}#t=0.5`} muted playsInline preload="metadata" />
                    : <span className={`ph ${failed ? "bad" : "busy"}`}>{failed ? "Failed" : statusText(r.status)}</span>}
                  <i className="tag">{config.tools.find((t) => t.id === r.tool)?.name}</i>
                </span>
                <span className="rmeta">
                  <span className="rlabel">{r.label}</span>
                  <em className={r.status}>{statusText(r.status)}{r.seconds ? ` · ${r.seconds} s` : ""}</em>
                </span>
              </button>
            );
          })}
        </aside>
      )}

      <main className="stage" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}>
        {!clip ? (
          <div className="empty">
            <div className="hero">
              <h2>Edit any clip with open models</h2>
              <p>Reframe, remove objects, cut the pauses, upscale or remove the background. Free models, your Comfy account, no install.</p>
            </div>
            <button className="drop" onClick={() => fileInput.current?.click()}>
              <svg viewBox="0 0 24 24" aria-hidden><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" /></svg>
              <strong>Drop a video</strong>
              <span>or click to choose one · MP4, MOV or WebM</span>
            </button>
            <ol className="steps" aria-label="How it works">
              <li><b>1</b>Add a video</li>
              <li><b>2</b>Pick a tool and a moment</li>
              <li><b>3</b>Preview, adjust, run</li>
            </ol>
            <button className="ghost" onClick={async () => {
              const blob = await (await fetch("/samples/cafe-talk.mp4")).blob();
              pick(new File([blob], "cafe-talk.mp4", { type: "video/mp4" }));
            }}>No video at hand? Try a sample</button>
          </div>
        ) : resultVideo && selectedResult ? (
          <ResultView result={selectedResult} url={resultVideo.url} onBack={() => setSelected(null)}
            onKeepEditing={() => useResultAsInput(selectedResult)} downloadName={(o) => downloadName(selectedResult, o)} />
        ) : (
          <Player key={clip.url} clip={clip} toolId={toolId} s={s} set={set} whole={whole} start={start} length={span}
            maxLength={Math.min(maxSeconds, clip.duration)} cuts={isCut ? cuts : []} shownCuts={isCut ? shownCuts : []} onToggleCut={toggleCut}
            peaks={isCut && typeof audio === "object" && audio ? audio.peaks : undefined}
            onSelect={(a, b) => { setStart(a); setLength(b); }}
            job={selectedResult && selectedResult.status !== "completed" ? selectedResult : null} now={now}
            onReplace={() => fileInput.current?.click()} />
        )}
        <input ref={fileInput} type="file" accept="video/*" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />

      </main>

      <aside className="panel" aria-label={`${tool.name} settings`}>
        <header className="tool-head">
          <h1>{tool.name}<Tip text={<>{tool.tagline}<br /><br />Runs on {tool.model}, open weights, on Comfy Cloud.</>} /></h1>
          <p>{tool.short}</p>
        </header>
        <div className="controls">
          <Panel s={s} set={set} clip={clip} extra={cutSummary} />
        </div>
        <div className="runbox">
          {error && <p className="error" role="alert">{error}</p>}
          <button className="go" disabled={busy || Boolean(blocked)} onClick={run}>
            {!clip ? "Add a video first" : blocked ?? (busy ? "Starting…" : `${tool.name} ${span.toFixed(1)} s`)}
          </button>
          {clip && !blocked && <small>≈ {minutes(estimate())}</small>}
          {changed && <button className="ghost reset" onClick={() => setSettings((all) => ({ ...all, [toolId]: { ...tool.defaults } }))}>Reset</button>}
        </div>
      </aside>
    </div>
    </div>
  );
}

/** Nombre de descarga que dice qué es: "reframe-9x16-0m05s.mp4", "smooth-cut.mp4", "cutout-mask.mp4". */
function downloadName(r: Result, o: Output) {
  const tag = r.label.split(" · ")[0].replace(/[“”"]/g, "").replace(/[^a-z0-9×:.#]+/gi, "-").replace(/[:×]/g, "x").toLowerCase().slice(0, 40);
  return `${r.tool}${tag && r.tool !== "smoothcut" ? `-${tag}` : ""}${/matte/.test(o.name) ? "-mask" : ""}.mp4`.replace(/-+/g, "-");
}

function statusText(s: string) {
  return ({ pending: "Queued", queued: "Queued", running: "Working", in_progress: "Working", completed: "Done", succeeded: "Done", failed: "Failed", cancelled: "Cancelled" } as Record<string, string>)[s] ?? s;
}

function summary(tool: string, s: Settings, secs: number, start: number) {
  const at = `${clock(start)} · ${secs.toFixed(1)} s`;
  if (tool === "reframe") return `${s.aspect} · ${at}`;
  if (tool === "remove") return `${String(s.what).trim() ? `“${String(s.what).trim()}”` : s.pointX !== "" && s.pointX !== undefined ? "clicked object" : "object"} · ${at}`;
  if (tool === "upscale") return `×${s.scale} · ${at}`;
  if (tool === "cutout") return `${s.background} · ${at}`;
  if (tool === "smoothcut") return `pauses > ${Number(s.minSilence).toFixed(1)} s · ${s.bridges === "off" ? "jump cuts" : "blended"}`;
  return at;
}

/* ---------- Reproductor con vista previa por herramienta ---------- */

function Player(props: {
  clip: Clip; toolId: string; s: Settings; set: (k: string, v: string | number) => void; whole: boolean;
  start: number; length: number; maxLength: number; cuts: Span[]; shownCuts: Span[]; onToggleCut: (c: Span) => void; peaks?: number[];
  onSelect: (start: number, length: number) => void; onReplace: () => void;
  job: Result | null; now: number;
}) {
  const { clip, toolId, s, whole, start, length, cuts } = props;
  const isCut = toolId === "smoothcut";
  const video = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [skipCuts, setSkipCuts] = useState(true);
  const thumbs = useThumbs(clip.url, clip.duration);
  const lo = whole ? 0 : start, hi = whole ? clip.duration : start + length;

  // El cabezal sigue al video en cada cuadro; la reproducción se queda dentro del tramo elegido.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        if (!v.paused) {
          if (v.currentTime >= hi - 0.02 || v.currentTime < lo - 0.1) v.currentTime = lo;
          if (isCut && skipCuts) { const c = cuts.find((c) => v.currentTime >= c.start && v.currentTime < c.end - 0.02); if (c) v.currentTime = c.end; }
        }
        setT(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lo, hi, isCut, skipCuts, cuts]);

  const seek = (time: number) => { if (video.current) video.current.currentTime = time; };
  const toggle = () => { const v = video.current; if (!v) return; if (v.paused) { if (v.currentTime < lo || v.currentTime >= hi - 0.05) v.currentTime = lo; v.play(); } else v.pause(); };
  useEffect(() => {
    // Atajos de editor: espacio reproduce, ← → mueven un cuadro (con Shift, 1 s), I y O marcan el inicio y el fin del tramo.
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return;
      const v = video.current;
      if (!v) return;
      if (e.code === "Space") { e.preventDefault(); toggle(); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); v.pause();
        v.currentTime = Math.min(clip.duration, Math.max(0, v.currentTime + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : 1 / 24)));
      } else if (!whole && (e.key === "i" || e.key === "I")) {
        const end = start + length, s0 = Math.min(v.currentTime, end - 1);
        props.onSelect(Math.max(0, s0), Math.min(props.maxLength, end - Math.max(0, s0)));
      } else if (!whole && (e.key === "o" || e.key === "O")) {
        const l = Math.min(props.maxLength, Math.max(1, v.currentTime - start));
        props.onSelect(start, l);
      }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  });

  const media = (
    <video ref={video} src={clip.url} muted={muted} playsInline preload="auto" onClick={toggle}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onLoadedMetadata={(e) => { e.currentTarget.currentTime = lo; }} />
  );

  return (
    <div className="viewer">
      <div className="clipbar">
        <svg className="film" viewBox="0 0 24 24" aria-hidden><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></svg>
        <span className="name" title={clip.file.name}>{clip.file.name}</span>
        <span className="meta">{clip.width}×{clip.height} · {clock(clip.duration)}</span>
        <span className="spacer" />
        <button className="btn" onClick={props.onReplace}>
          <svg viewBox="0 0 24 24" aria-hidden><path d="M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></svg>
          Change video
        </button>
      </div>
      <Preview clip={clip} toolId={toolId} s={s} set={props.set} media={media} onPick={() => { const v = video.current; if (v) { v.pause(); v.currentTime = lo; } }} />
      {props.job && <Progress job={props.job} now={props.now} />}
      <div className="transport">
        <button className="play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>{playing ? "❚❚" : "▶"}</button>
        <span className="time">{clock(t)} <i>/ {clock(clip.duration)}</i></span>
        <button className="ghost" onClick={() => setMuted((m) => !m)}>{muted ? "Sound off" : "Sound on"}</button>
        {isCut && <label className="check"><input type="checkbox" checked={skipCuts} onChange={(e) => setSkipCuts(e.target.checked)} /> Preview without the pauses</label>}
        <span className="spacer" />
      </div>
      <Timeline duration={clip.duration} current={t} thumbs={thumbs} start={start} length={length} whole={whole}
        minLength={Math.min(1, clip.duration)} maxLength={props.maxLength} cuts={isCut ? props.shownCuts : undefined} onToggleCut={props.onToggleCut} peaks={isCut ? props.peaks : undefined}
        onSelect={(a, b, at) => { props.onSelect(a, b); seek(at); }} onSeek={seek} />
      {whole ? (
        <p className="selection"><span className="key cut" /> pauses to cut · the whole clip is used</p>
      ) : (
        <div className="selection-row">
          <RangeFields start={start} length={length} duration={clip.duration} minLength={Math.min(1, clip.duration)} maxLength={props.maxLength}
            onChange={(a, b, at) => { props.onSelect(a, b); seek(at); }} />
          <Tip align="left" text={`Drag the green box to pick the moment, or pull its edges. You can also type the times. From 1 to ${Math.floor(props.maxLength)} s.`} />
          {length > 10 && <span className="chip warn">Longer = slower and more credits</span>}
        </div>
      )}
    </div>
  );
}

function Progress({ job, now }: { job: Result; now: number }) {
  const elapsed = (now - job.startedAt) / 1000;
  const failed = job.status === "failed" || job.status === "error";
  const p = failed ? 100 : Math.min(95, (elapsed / Math.max(10, job.estimate)) * 100);
  return (
    <div className={`progress ${failed ? "bad" : ""}`} role="status">
      <div className="bar"><span style={{ width: `${p}%` }} /></div>
      <span>{failed ? `Failed: ${job.error ?? "unknown error"}` : `${job.stage || statusText(job.status)} · ${Math.round(elapsed)} s of about ${minutes(job.estimate)}`}</span>
    </div>
  );
}

function Preview({ clip, toolId, s, set, media, onPick }: { clip: Clip; toolId: string; s: Settings; set: (k: string, v: string | number) => void; media: React.ReactNode; onPick?: () => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; y0: number; p0: number; q0: number } | null>(null);

  if (toolId === "reframe") {
    const g = reframeGeometry(clip, s);
    const W = g.work.w, H = g.work.h;
    const win = { left: (g.winX / W) * 100, top: (g.winY / H) * 100, width: (g.winW / W) * 100, height: (g.winH / H) * 100 };
    const vid = { width: (clip.width / g.cropW) * 100, height: (clip.height / g.cropH) * 100, left: -(g.cropX / g.cropW) * 100, top: -(g.cropY / g.cropH) * 100 };
    const down = (e: RPointerEvent) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x0: e.clientX, y0: e.clientY, p0: Number(s.position), q0: Number(s.positionY ?? 0.5) }; };
    const move = (e: RPointerEvent) => {
      if (!drag.current || !frame.current) return;
      const r = frame.current.getBoundingClientRect();
      const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
      // Arrastrar mueve el encuadre en las direcciones que tienen sentido para esta forma.
      if (g.canMoveX) set("position", clamp(drag.current.p0 + (e.clientX - drag.current.x0) / r.width));
      if (g.canMoveY) set("positionY", clamp(drag.current.q0 + (e.clientY - drag.current.y0) / r.height));
    };
    const sides = g.winW < W - 1, tops = g.winH < H - 1;
    return (
      <div className="preview">
        <div className="frame reframe" ref={frame} style={{ ["--ar" as string]: W / H }}>
          {sides && <><span className="gen-label" style={{ left: 0, width: `${win.left}%` }}>AI</span><span className="gen-label" style={{ left: `${win.left + win.width}%`, right: 0 }}>AI</span></>}
          {tops && <><span className="gen-label" style={{ top: 0, height: `${win.top}%`, left: 0, right: 0 }}>AI paints this</span><span className="gen-label" style={{ top: `${win.top + win.height}%`, bottom: 0, left: 0, right: 0 }}>AI paints this</span></>}
          <div className="window" style={{ left: `${win.left}%`, top: `${win.top}%`, width: `${win.width}%`, height: `${win.height}%` }}
            onPointerDown={down} onPointerMove={move} onPointerUp={() => (drag.current = null)} aria-label="Drag to frame">
            <span className="drag-hint" aria-hidden>{g.canMoveX && g.canMoveY ? "✥" : g.canMoveY ? "⇅" : "⇆"} drag</span>
            <div className="crop" style={{ left: `${vid.left}%`, top: `${vid.top}%`, width: `${vid.width}%`, height: `${vid.height}%` }}>{media}</div>
          </div>
        </div>
        {g.generatedShare > 0.55 && (
          <p className="heads-up">The AI paints more than half the frame. Results improve if you describe the scene or keep more of the original.</p>
        )}
        <div className="legend">
          <span><i className="k orig" /> Your footage</span>
          <span><i className="k gen" /> AI · {Math.round(g.generatedShare * 100)}%</span>
          <span>{g.outW}×{g.outH}</span>
        </div>
      </div>
    );
  }

  const picked = s.pointX !== undefined && s.pointX !== "";
  const badge = toolId === "upscale" ? (() => { const o = upscaleSize(clip, Number(s.scale)); return o ? `${clip.width}×${clip.height} → ${o.w}×${o.h}` : ""; })()
    : toolId === "remove" ? (picked ? "Selected · the dot must sit on the object, not beside it · click again to change" : "Click right on what should disappear")
    : toolId === "cutout" ? "New background: " + backgroundName(String(s.background)) : "";
  return (
    <div className="preview">
      <div className="frame" style={{ ["--ar" as string]: clip.width / clip.height, ...(toolId === "cutout" ? { boxShadow: `0 0 0 6px ${s.background}` } : {}) }}>
        {media}
        {toolId === "remove" && (
          // Capa de clic: marca el objeto en el primer cuadro de la franja (el que recibe SAM 3).
          <div className="picker" role="button" aria-label="Click the object to remove" onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onPick?.();
            set("pointX", Math.round(((e.clientX - r.left) / r.width) * 1000) / 1000);
            set("pointY", Math.round(((e.clientY - r.top) / r.height) * 1000) / 1000);
          }}>
            {picked && <span className="marker" style={{ left: `${Number(s.pointX) * 100}%`, top: `${Number(s.pointY) * 100}%` }} />}
          </div>
        )}
        {badge && <span className="badge">{toolId === "cutout" && <i style={{ background: String(s.background) }} />}{badge}</span>}
      </div>
    </div>
  );
}

/* ---------- Resultado: antes y después con un solo control ---------- */

function ResultView({ result, url, onBack, onKeepEditing, downloadName }: {
  result: Result; url: string; onBack: () => void; onKeepEditing: () => void; downloadName: (o: Output) => string;
}) {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const [wipe, setWipe] = useState(50);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { src } = result;
  const start = src.start;
  const sameShape = result.tool !== "reframe" && result.tool !== "smoothcut";
  const sync = result.tool !== "smoothcut";

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const va = a.current, vb = b.current;
      if (vb) {
        setT(vb.currentTime);
        if (va && sync && Math.abs(va.currentTime - start - vb.currentTime) > 0.1) va.currentTime = start + vb.currentTime;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [start, sync]);

  const toggle = () => {
    const va = a.current, vb = b.current;
    if (!vb) return;
    if (vb.paused) { vb.play(); if (va && sync) va.play(); } else { vb.pause(); va?.pause(); }
  };
  const seek = (x: number) => { if (b.current) b.current.currentTime = x; };

  return (
    <div className="viewer">
      <div className="clipbar result-bar">
        <button className="btn" onClick={onBack}>← Back to editing</button>
        <span className="name" title={result.label}>{TOOL_NAMES[result.tool] ?? result.tool}</span>
        <span className="meta">{result.seconds ? `${result.seconds} s` : ""}</span>
        <span className="spacer" />
        {result.outputs.map((o) => (
          <a key={o.id} className={`btn ${/matte/.test(o.name) ? "" : "primary"}`} href={o.url} download={downloadName(o)}>
            <svg viewBox="0 0 24 24" aria-hidden><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            {/matte/.test(o.name) ? "Mask" : "Download"}
          </a>
        ))}
        <button className="btn" onClick={onKeepEditing} title="Use this result as the new video">Keep editing this</button>
      </div>
      {sameShape ? (
        <div className="preview">
          <div className="frame stack" style={{ ["--ar" as string]: src.width / src.height }}>
            <video ref={b} src={url} loop playsInline onClick={toggle} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedMetadata={(e) => setDur(e.currentTarget.duration)} />
            <video ref={a} src={src.url} muted playsInline className="before" style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }}
              onLoadedMetadata={(e) => { e.currentTarget.currentTime = start; }} />
            <div className="seam" style={{ left: `${wipe}%` }}><span>Before</span><span>After</span></div>
            <input className="wiper" type="range" min={0} max={100} value={wipe} onChange={(e) => setWipe(Number(e.target.value))} aria-label="Before and after" />
          </div>
        </div>
      ) : (
        <div className="side">
          <figure><video ref={a} src={src.url} muted playsInline onLoadedMetadata={(e) => { e.currentTarget.currentTime = start; }} /><figcaption>Before</figcaption></figure>
          <figure><video ref={b} src={url} loop playsInline onClick={toggle} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedMetadata={(e) => setDur(e.currentTarget.duration)} /><figcaption>After</figcaption></figure>
        </div>
      )}
      <div className="transport">
        <button className="play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>{playing ? "❚❚" : "▶"}</button>
        <span className="time">{clock(t)} <i>/ {clock(dur)}</i></span>
        <input className="scrub" type="range" min={0} max={dur || 1} step={0.01} value={t} onChange={(e) => seek(Number(e.target.value))} aria-label="Position" />
      </div>
      {sameShape && <p className="selection">Drag the line on the video to compare before and after.</p>}
    </div>
  );
}
