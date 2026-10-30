"use client";

// Controles hechos a la medida de cada herramienta. Poco texto a la vista: cada opción dice qué
// cambia en una o dos palabras, la vista previa del centro lo muestra, y el resto va en el "?".

import { useState, type ReactNode } from "react";
import { reframeGeometry } from "@/lib/plan";

export type Settings = Record<string, string | number>;
type ClipInfo = { width: number; height: number; duration: number };
type PanelProps = { s: Settings; set: (k: string, v: string | number) => void; clip: ClipInfo | null; extra?: ReactNode };

/** Explicación a demanda: un "?" que muestra el texto al pasar el mouse o al enfocarlo con el teclado. */
export function Tip({ text, align = "left" }: { text: ReactNode; align?: "left" | "right" }) {
  return (
    <span className={`tip ${align}`} tabIndex={0} role="note" aria-label="More info">
      ?<span className="bubble" role="tooltip">{text}</span>
    </span>
  );
}

type Custom = { min: number; max: number; step: number; show: (v: number) => string; left?: string; right?: string };
type Option<T> = { value: T; label: ReactNode; hint?: string };

function Seg<T extends string | number>({ value, options, onChange, label, custom, tip }: {
  value: T; label: string; onChange: (v: T) => void; options: Option<T>[]; custom?: Custom; tip?: ReactNode;
}) {
  const match = options.find((o) => o.value === value);
  const [open, setOpen] = useState(false);
  // "Custom" queda activo si el valor no es una de las opciones (p. ej. al arrastrar en la vista previa).
  const isCustom = Boolean(custom) && (open || !match);
  return (
    <div className="field">
      <span className="label"><span>{label}{tip && <Tip text={tip} />}</span>{isCustom && custom && <output>{custom.show(Number(value))}</output>}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={String(o.value)} role="radio" title={o.hint} aria-checked={!isCustom && o.value === value} className={!isCustom && o.value === value ? "on" : ""}
            onClick={() => { setOpen(false); onChange(o.value); }}>{o.label}</button>
        ))}
        {custom && <button role="radio" title="Set your own value" aria-checked={isCustom} className={isCustom ? "on" : ""} onClick={() => setOpen(true)}>Custom</button>}
      </div>
      {isCustom && custom && (
        <>
          <input type="range" min={custom.min} max={custom.max} step={custom.step} value={Number(value)} aria-label={`${label}, custom`}
            onChange={(e) => onChange(Number(e.target.value) as T)} />
          {(custom.left || custom.right) && <span className="ends"><span>{custom.left}</span><span>{custom.right}</span></span>}
        </>
      )}
    </div>
  );
}

/** Lista de opciones para el "?": cada una con lo que hace. */
const explain = (items: [string, string][]) => <ul>{items.map(([k, v]) => <li key={k}><b>{k}</b> {v}</li>)}</ul>;

function Slider({ label, value, min, max, step, onChange, left, right, show, tip }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
  left: string; right: string; show: string; tip?: ReactNode;
}) {
  return (
    <div className="field">
      <span className="label"><span>{label}{tip && <Tip text={tip} />}</span><output>{show}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <span className="ends"><span>{left}</span><span>{right}</span></span>
    </div>
  );
}

function Variation({ s, set }: PanelProps) {
  return (
    <div className="variation">
      <span>Variation <b>#{s.seed}</b><Tip text="Same settings, a different take from the AI. Use it when a result is close but not quite right." /></span>
      <button className="ghost" onClick={() => set("seed", Math.floor(Math.random() * 1e6))}>↻ Try another</button>
    </div>
  );
}

const QUALITY: Option<string>[] = [
  { value: "fast", label: "Draft", hint: "Quickest. Good for testing" },
  { value: "normal", label: "Standard", hint: "Best balance" },
  { value: "high", label: "Best", hint: "Most detail, about twice as long" },
];
const QUALITY_TIP = explain([["Draft", "is quickest; good for testing."], ["Standard", "is the best balance."], ["Best", "adds detail to the AI parts and takes about twice as long."]]);

const RATIOS: { value: string; w: number; h: number; use: string }[] = [
  { value: "9:16", w: 9, h: 16, use: "Reels" },
  { value: "4:5", w: 4, h: 5, use: "Feed" },
  { value: "1:1", w: 1, h: 1, use: "Square" },
  { value: "16:9", w: 16, h: 9, use: "YouTube" },
  { value: "21:9", w: 21, h: 9, use: "Cinema" },
];

function Shape({ w, h }: { w: number; h: number }) {
  const k = 22 / Math.max(w, h);
  return <span className="shape" style={{ width: w * k, height: h * k }} aria-hidden />;
}

export function ReframePanel({ s, set, clip }: PanelProps) {
  const g = clip ? reframeGeometry(clip, s) : null;
  const source = clip ? clip.width / clip.height : 16 / 9;
  const [cw, ch] = String(s.aspect).split(":").map(Number);
  const preset = RATIOS.some((r) => r.value === s.aspect);
  const [customOpen, setCustomOpen] = useState(false);
  const isCustom = customOpen || !preset;
  const wider = cw / ch >= source;
  return (
    <>
      <div className="field">
        <span className="label"><span>New shape</span></span>
        <div className="ratios" role="radiogroup" aria-label="New shape">
          {RATIOS.map((r) => (
            <button key={r.value} role="radio" aria-checked={!isCustom && s.aspect === r.value} className={!isCustom && s.aspect === r.value ? "on" : ""}
              onClick={() => { setCustomOpen(false); set("aspect", r.value); }}>
              <Shape w={r.w} h={r.h} /><b>{r.value}</b><small>{r.use}</small>
            </button>
          ))}
          <button role="radio" aria-checked={isCustom} className={isCustom ? "on" : ""} onClick={() => setCustomOpen(true)}>
            <Shape w={cw || 1} h={ch || 1} /><b>{isCustom ? s.aspect : "W:H"}</b><small>Custom</small>
          </button>
        </div>
        {isCustom && (
          <div className="ratio-inputs">
            <input type="number" min={1} max={99} value={cw || ""} aria-label="Width part" onChange={(e) => set("aspect", `${Math.max(1, Number(e.target.value) || 1)}:${ch || 1}`)} />
            <span>:</span>
            <input type="number" min={1} max={99} value={ch || ""} aria-label="Height part" onChange={(e) => set("aspect", `${cw || 1}:${Math.max(1, Number(e.target.value) || 1)}`)} />
            <Tip text="Width : height. Anything from 1:3 (very tall) to 3:1 (very wide)." />
          </div>
        )}
      </div>
      {!wider && (
        <Slider label="Crop or extend" value={Number(s.keep)} min={0} max={1} step={0.05} onChange={(v) => set("keep", v)}
          left="Crop only" right="Keep everything"
          show={g ? (g.generatedShare < 0.01 ? "no AI" : `AI ${Math.round(g.generatedShare * 100)}%`) : ""}
          tip="Crop only cuts your video to the new shape, with no AI. Keep everything fits your whole frame in and the AI paints the rest. In between, a bit of both." />
      )}
      {(!g || g.canMoveX) && (
        <Seg label={g?.canMoveY ? "Framing ↔" : "Framing"} value={Number(s.position)} onChange={(v) => set("position", v)}
          options={[{ value: 0, label: "Left" }, { value: 0.5, label: "Center" }, { value: 1, label: "Right" }]}
          custom={{ min: 0, max: 1, step: 0.01, show: (v) => `${Math.round(v * 100)}%`, left: "Left", right: "Right" }}
          tip="Which part of your video stays in the frame, left to right. You can also drag the picture in the preview." />
      )}
      {g?.canMoveY && (
        <Seg label={g.canMoveX ? "Framing ↕" : "Framing"} value={Number(s.positionY)} onChange={(v) => set("positionY", v)}
          options={[{ value: 0, label: "Top" }, { value: 0.5, label: "Middle" }, { value: 1, label: "Bottom" }]}
          custom={{ min: 0, max: 1, step: 0.01, show: (v) => `${Math.round(v * 100)}%`, left: "Top", right: "Bottom" }}
          tip="Where your footage sits, top to bottom. The AI paints whatever space is left. You can also drag the picture in the preview." />
      )}
      <div className="field">
        <span className="label"><span>Describe the scene<Tip text="Optional. Helps the AI paint the new space, e.g. “a sunny kitchen with white tiles”." /></span><em>optional</em></span>
        <input type="text" value={String(s.prompt)} placeholder="a sunny kitchen with white tiles" onChange={(e) => set("prompt", e.target.value)} />
      </div>
      <Seg label="Quality" value={String(s.quality)} onChange={(v) => set("quality", v)} options={QUALITY} tip={QUALITY_TIP} />
      <Variation s={s} set={set} clip={clip} />
    </>
  );
}

const REMOVE_IDEAS = ["person in the background", "logo", "text on screen", "microphone"];

export function RemovePanel({ s, set, clip }: PanelProps) {
  return (
    <>
      <div className="field">
        <span className="label"><span>What should disappear?<Tip text="Click the object in the video. It's detected on the first frame of your selection and followed through the whole piece. Only that area is repainted; the rest of the shot stays as it is." /></span></span>
        {s.pointX !== undefined && s.pointX !== "" ? (
          <div className="picked"><i className="pin" aria-hidden /> Object selected<button className="ghost" onClick={() => { set("pointX", ""); set("pointY", ""); }}>Clear</button></div>
        ) : (
          <div className="picked empty"><i className="pin" aria-hidden /> Click it in the video</div>
        )}
      </div>
      <div className="field">
        <span className="label"><span>Describe it<Tip text={<>Optional. With a click, say what kind of thing it is (“person”, “car”) so the whole object is removed, not just the part you clicked. Without a click, it removes what you name. To remove someone and what they hold, clear the click and write both: “man, guitar”.</>} /></span><em>optional</em></span>
        <input type="text" value={String(s.what)} placeholder="person, car, cup…" onChange={(e) => set("what", e.target.value)} />
        <div className="ideas">{REMOVE_IDEAS.map((i) => <button key={i} onClick={() => set("what", `the ${i}`)}>{i}</button>)}</div>
      </div>
      <Seg label="Strength" value={Number(s.loraStrength)} onChange={(v) => set("loraStrength", v)} options={[
        { value: 0.9, label: "Gentle", hint: "Removes less, touches nothing else" },
        { value: 1.2, label: "Normal", hint: "Works for most objects" },
        { value: 1.6, label: "Strong", hint: "For stubborn objects; may remove nearby things" },
      ]} custom={{ min: 0.6, max: 2.2, step: 0.1, show: (v) => v.toFixed(1), left: "Gentler", right: "Stronger" }}
        tip={explain([["Gentle", "removes less and touches nothing else. Try it first for small things."], ["Normal", "works for most objects."], ["Strong", "is for stubborn objects, but may also remove things next to it."]])} />
      <Seg label="Quality" value={String(s.quality)} onChange={(v) => set("quality", v)} options={QUALITY} tip={QUALITY_TIP} />
      <Variation s={s} set={set} clip={clip} />
    </>
  );
}

export function SmoothCutPanel({ s, set, extra }: PanelProps) {
  return (
    <>
      {extra}
      <Slider label="Cut pauses longer than" value={Number(s.minSilence)} min={0.15} max={2} step={0.05} onChange={(v) => set("minSilence", v)}
        left="Tight" right="Relaxed" show={`${Number(s.minSilence).toFixed(1)} s`} tip="Shorter pauses are left alone, so the speech still breathes. The red marks on the timeline update as you move it." />
      <Seg label="Breath at each cut" value={Number(s.keepAir)} onChange={(v) => set("keepAir", v)} options={[
        { value: 0.05, label: "None" }, { value: 0.15, label: "Short" }, { value: 0.3, label: "Long" },
      ]} custom={{ min: 0, max: 0.6, step: 0.05, show: (v) => `${v.toFixed(2)} s`, left: "Tighter", right: "Calmer" }}
        tip="How much of each pause stays. None feels fast-paced; Long feels calm." />
      <Seg label="Room noise" value={Number(s.sensitivity)} onChange={(v) => set("sensitivity", v)} options={[
        { value: 0.25, label: "Quiet" }, { value: 0.35, label: "Normal" }, { value: 0.5, label: "Noisy" },
      ]} custom={{ min: 0.1, max: 0.7, step: 0.05, show: (v) => `${Math.round(v * 100)}%`, left: "Fewer cuts", right: "More cuts" }}
        tip="The silence level adapts to each clip's loudness. If background noise hides the pauses, choose Noisy. If soft words get cut, choose Quiet." />
      <Seg label="Cut style" value={s.bridges === "off" ? "off" : String(s.bridge)} onChange={(v) => { set("bridges", v === "off" ? "off" : "on"); if (v !== "off") set("bridge", v); }} options={[
        { value: "off", label: "Jump" }, { value: "9", label: "Quick blend" }, { value: "17", label: "Smooth blend" },
      ]} tip={explain([["Jump", "is a plain cut: instant, no AI."], ["Quick blend", "has the AI draw ⅓ s between the two sides of each cut."], ["Smooth blend", "draws ⅔ s, so the head moves naturally."]])} />
    </>
  );
}

export function upscaleSize(clip: ClipInfo | null, scale: number) {
  if (!clip) return null;
  const f = Math.max(1, Math.min(scale, 3840 / Math.max(clip.width, clip.height)));
  return { w: Math.round(clip.width * f / 2) * 2, h: Math.round(clip.height * f / 2) * 2, capped: f < scale };
}

export function UpscalePanel({ s, set, clip }: PanelProps) {
  const out = (n: number) => { const o = upscaleSize(clip, n); return o ? `${o.w}×${o.h}` : `×${n}`; };
  return (
    <>
      <Seg label="New size" value={Number(s.scale)} onChange={(v) => set("scale", v)} options={[2, 3, 4].map((n) => ({
        value: n, label: <><b>×{n}</b><small>{clip ? out(n) : ""}</small></>,
      }))} custom={{ min: 1.25, max: 4, step: 0.25, show: (v) => `×${v} · ${out(v)}` }} tip="Never goes above 4K (3840 px on the long side)." />
      <Seg label="Look" value={String(s.model)} onChange={(v) => set("model", v)} options={[
        { value: "3B fast", label: "Fast" }, { value: "7B quality", label: "Detailed" }, { value: "7B sharp", label: "Sharp" },
      ]} tip={explain([["Fast", "is good for most clips."], ["Detailed", "brings back texture: skin, fabric, leaves. About twice as slow."], ["Sharp", "gives crisper edges and text; can look harsh on faces."]])} />
    </>
  );
}

const BACKGROUNDS = [
  { value: "#00B140", label: "Green" }, { value: "#0047BB", label: "Blue" },
  { value: "#000000", label: "Black" }, { value: "#FFFFFF", label: "White" },
];
export const backgroundName = (hex: string) => BACKGROUNDS.find((b) => b.value === hex.toUpperCase())?.label.toLowerCase() ?? hex;

export function CutoutPanel({ s, set }: PanelProps) {
  const isPreset = BACKGROUNDS.some((b) => b.value === String(s.background).toUpperCase());
  return (
    <div className="field">
      <span className="label"><span>New background<Tip text="You get two videos: the subject on this color, and a black-and-white mask to use in any editor." /></span></span>
      <div className="swatches" role="radiogroup" aria-label="New background">
        {BACKGROUNDS.map((b) => (
          <button key={b.value} role="radio" aria-checked={String(s.background).toUpperCase() === b.value} className={String(s.background).toUpperCase() === b.value ? "on" : ""} onClick={() => set("background", b.value)}>
            <span style={{ background: b.value }} />{b.label}
          </button>
        ))}
        <label className={isPreset ? "" : "on"}>
          <input type="color" value={String(s.background)} onChange={(e) => set("background", e.target.value.toUpperCase())} />Custom
        </label>
      </div>
    </div>
  );
}
