// Calcula, para cada herramienta, los valores que van a los nodos `in_*` / `p_*` del workflow.
// El grafo solo genera; toda la geometría (múltiplos de 32, ventana, márgenes) vive aquí,
// así se puede probar sin gastar créditos (`node --test`).

export type Settings = Record<string, string | number | boolean>;
export type Meta = { width: number; height: number; duration: number; start?: number; length?: number; fps?: number };
export type Input = { node: string; field: string; value: string | number | boolean };

const QUALITY_LONG_SIDE: Record<string, number> = { fast: 768, normal: 960, high: 1280 };

const RATIOS: Record<string, number> = {
  "9:16": 9 / 16, "4:5": 4 / 5, "1:1": 1, "4:3": 4 / 3, "16:9": 16 / 9, "21:9": 21 / 9,
};

/** "9:16", o cualquier "ancho:alto" propio, limitado entre 1:3 y 3:1. */
export function parseRatio(aspect: string) {
  if (RATIOS[aspect]) return RATIOS[aspect];
  const [w, h] = aspect.split(":").map(Number);
  return w > 0 && h > 0 ? Math.min(3, Math.max(1 / 3, w / h)) : 9 / 16;
}

export const mult32 = (n: number) => Math.max(32, Math.round(n / 32) * 32);
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const evenPos = (n: number) => Math.max(0, Math.round(n / 2) * 2);
const num = (s: Settings, k: string, d: number) => (s[k] === undefined || s[k] === "" ? d : Number(s[k]));
const str = (s: Settings, k: string, d: string) => (s[k] === undefined ? d : String(s[k]));

/** Tamaño de trabajo de LTX para una proporción: lado largo según calidad, ambos lados múltiplos de 32. */
export function workSize(ratio: number, quality: string) {
  const long = QUALITY_LONG_SIDE[quality] ?? 960;
  return ratio >= 1
    ? { w: mult32(long), h: mult32(long / ratio) }
    : { w: mult32(long * ratio), h: mult32(long) };
}

function trim(meta: Meta, maxSeconds: number): Input[] {
  return [
    { node: "in_trim", field: "start_time", value: meta.start ?? 0 },
    // El usuario elige cuánto procesar (5 s por defecto); el servidor nunca pasa de maxSeconds.
    { node: "in_trim", field: "duration", value: Math.min(maxSeconds, meta.length ?? 5, Math.max(0.5, meta.duration - (meta.start ?? 0))) },
  ];
}

/**
 * Reencuadre. `keep` interpola (en escala logarítmica) la proporción de la ventana entre la del destino
 * (0 = recorte puro, no se genera nada) y la de la fuente (1 = se conserva todo el cuadro).
 */
export function reframeGeometry(meta: Meta, s: Settings) {
  const target = parseRatio(str(s, "aspect", "9:16"));
  const source = meta.width / meta.height;
  const keep = Math.min(1, Math.max(0, num(s, "keep", 0.5)));
  const position = Math.min(1, Math.max(0, num(s, "position", 0.5)));
  const positionY = Math.min(1, Math.max(0, num(s, "positionY", 0.5)));

  // Ventana del original (px de la fuente).
  // Más ancho que la fuente: se conserva el cuadro completo y se generan los lados.
  let winRatio = target >= source ? source : Math.exp((1 - keep) * Math.log(target) + keep * Math.log(source));
  let cropW: number, cropH: number;
  if (winRatio <= source) { cropH = meta.height; cropW = Math.min(meta.width, cropH * winRatio); }
  else { cropW = meta.width; cropH = Math.min(meta.height, cropW / winRatio); }
  cropW = even(cropW); cropH = even(cropH);
  winRatio = cropW / cropH;
  const cropX = evenPos((meta.width - cropW) * position);
  const cropY = evenPos((meta.height - cropH) * positionY);

  // Lienzo destino que contiene la ventana: la ventana toca dos bordes opuestos.
  const canvasRatio = target;
  const work = workSize(canvasRatio, str(s, "quality", "normal"));
  let winW: number, winH: number;
  if (winRatio >= canvasRatio) { winW = work.w; winH = Math.round(work.w / winRatio); }
  else { winH = work.h; winW = Math.round(work.h * winRatio); }
  winW = Math.min(work.w, winW); winH = Math.min(work.h, winH);
  const winX = Math.round((work.w - winW) * position);
  const winY = Math.round((work.h - winH) * positionY);

  // Salida a resolución nativa de la ventana (tope de 1920 en el lado largo).
  // Nunca por debajo del tamaño de trabajo: con fuentes pequeñas, el original se escala para el re-pegado.
  let scale = Math.max(1, cropW / winW);
  const maxLong = 1920;
  if (Math.max(work.w, work.h) * scale > maxLong) scale = maxLong / Math.max(work.w, work.h);
  const outW = even(work.w * scale), outH = even(work.h * scale);
  const pasteW = even(winW * scale), pasteH = even(winH * scale);
  const pasteX = evenPos(winX * scale), pasteY = evenPos(winY * scale);
  const generatedShare = 1 - (winW * winH) / (work.w * work.h);
  // Hacia dónde tiene sentido mover el encuadre (la interfaz solo muestra esos controles).
  const canMoveX = cropW < meta.width - 1 || winW < work.w - 1;
  const canMoveY = cropH < meta.height - 1 || winH < work.h - 1;
  return { canMoveX, canMoveY, cropW, cropH, cropX, cropY, work, winW, winH, winX, winY, outW, outH, pasteW, pasteH, pasteX, pasteY, scale, generatedShare };
}

function engineInputs(s: Settings, defaults: { lora: number; guide: number }): Input[] {
  const seed = num(s, "seed", 42);
  return [
    { node: "p_lora", field: "strength_model", value: num(s, "loraStrength", defaults.lora) },
    { node: "p_guide", field: "strength", value: num(s, "guideStrength", defaults.guide) },
    { node: "p_sampler", field: "steps", value: num(s, "steps", 8) },
    { node: "p_sampler", field: "seed", value: seed < 0 ? Math.floor(Math.random() * 2 ** 31) : seed },
  ];
}

export function planReframe(meta: Meta, s: Settings, maxSeconds = 5): { inputs: Input[]; geometry: ReturnType<typeof reframeGeometry> } {
  const g = reframeGeometry(meta, s);
  const prompt = str(s, "prompt", "").trim();
  const inputs: Input[] = [
    ...trim(meta, maxSeconds),
    { node: "in_crop", field: "width", value: g.cropW }, { node: "in_crop", field: "height", value: g.cropH },
    { node: "in_crop", field: "x", value: g.cropX }, { node: "in_crop", field: "y", value: g.cropY },
    { node: "in_win", field: "resize_type.width", value: g.winW }, { node: "in_win", field: "resize_type.height", value: g.winH },
    { node: "in_canvas", field: "width", value: g.work.w }, { node: "in_canvas", field: "height", value: g.work.h },
    { node: "in_place", field: "x", value: g.winX }, { node: "in_place", field: "y", value: g.winY },
    { node: "in_work", field: "width", value: g.work.w }, { node: "in_work", field: "height", value: g.work.h },
    { node: "in_out", field: "resize_type.width", value: g.outW }, { node: "in_out", field: "resize_type.height", value: g.outH },
    { node: "in_mask", field: "width", value: g.pasteW }, { node: "in_mask", field: "height", value: g.pasteH },
    { node: "in_crop_out", field: "resize_type.width", value: g.pasteW }, { node: "in_crop_out", field: "resize_type.height", value: g.pasteH },
    { node: "in_paste", field: "x", value: g.pasteX }, { node: "in_paste", field: "y", value: g.pasteY },
    // Solo se suaviza donde el original toca zona generada; contra el borde del cuadro no hay nada que mezclar.
    ...(() => {
      const f = num(s, "feather", 24);
      const touches = { left: g.pasteX > 0, top: g.pasteY > 0, right: g.pasteX + g.pasteW < g.outW, bottom: g.pasteY + g.pasteH < g.outH };
      return (["left", "top", "right", "bottom"] as const).map((side) => ({ node: "p_feather", field: side, value: touches[side] ? f : 0 }));
    })(),
    ...engineInputs(s, { lora: 1, guide: 1 }),
  ];
  if (prompt) inputs.push({ node: "p_prompt", field: "text", value: `${prompt} The scene continues naturally beyond the original frame.` });
  return { inputs, geometry: g };
}

/**
 * Quitar. Con `pointX`/`pointY` (fracciones 0–1 del cuadro al inicio del tramo) SAM3 segmenta lo que se tocó;
 * sin punto, segmenta lo que dice `what` (texto corto en inglés, p. ej. "man", "plant").
 * SAM3 recibe los cuadros a tamaño de trabajo, así que el punto va en píxeles de ese tamaño.
 * La IC-LoRA de in/outpainting rellena solo la máscara y el original se re-pega fuera de ella.
 */
export function removeGeometry(meta: Meta, s: Settings) {
  const ratio = meta.width / meta.height;
  const work = workSize(ratio, str(s, "quality", "normal"));
  const scale = Math.min(1920 / Math.max(meta.width, meta.height), 1);
  const out = { w: even(meta.width * scale), h: even(meta.height * scale) };
  const hasPoint = s.pointX !== undefined && s.pointX !== "" && s.pointY !== undefined && s.pointY !== ""
    && Number.isFinite(Number(s.pointX)) && Number.isFinite(Number(s.pointY));
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const point = hasPoint
    ? { x: Math.min(work.w - 1, Math.round(clamp(Number(s.pointX)) * work.w)), y: Math.min(work.h - 1, Math.round(clamp(Number(s.pointY)) * work.h)) }
    : null;
  // Dilatación de la máscara: ~3 % del lado corto de trabajo (16 px en 544), para tapar bordes y sombras cercanas.
  const grow = Math.max(8, Math.round(Math.min(work.w, work.h) * num(s, "maskGrow", 0.03)));
  // Borde suave del re-pegado, en px de salida (ImageBlur admite radio hasta 31).
  const feather = Math.min(31, Math.max(3, Math.round(Math.min(out.w, out.h) / 72)));
  return { work, out, point, grow, feather };
}

const GENERIC_OBJECTS = "person, animal, plant, vehicle, furniture, food, cup, bottle, bag, sign";

/** "Remove the man in the back." → "man in the back" (SAM3 entiende frases nominales cortas, máx. 32 tokens). */
export function cleanWhat(text: string) {
  return text.trim().replace(/^(please\s+)?(remove|erase|delete|get rid of)\s+/i, "").replace(/^(the|a|an)\s+/i, "").replace(/[.!]+$/, "").trim();
}

export function planRemove(meta: Meta, s: Settings, maxSeconds = 5): { inputs: Input[]; geometry: ReturnType<typeof removeGeometry> } {
  const g = removeGeometry(meta, s);
  const what = cleanWhat(str(s, "what", ""));
  // Texto para SAM3. Con clic y sin texto, una lista de categorías comunes: sirve para pasar de la parte tocada
  // (la camisa, una hoja) al objeto entero que la contiene. Sin clic, el texto es lo que se busca (1 objeto).
  const samText = what || (g.point ? GENERIC_OBJECTS : "person");
  const fill = str(s, "fill", "").trim();
  return {
    geometry: g,
    inputs: [
      ...trim(meta, maxSeconds),
      { node: "in_guide", field: "resize_type.width", value: g.work.w }, { node: "in_guide", field: "resize_type.height", value: g.work.h },
      { node: "in_green", field: "width", value: g.work.w }, { node: "in_green", field: "height", value: g.work.h },
      { node: "in_work", field: "width", value: g.work.w }, { node: "in_work", field: "height", value: g.work.h },
      // Con clic: solo el punto en el primer paso (threshold 1.0 apaga el texto ahí). Sin clic: el texto de `what`.
      { node: "in_point", field: "value", value: g.point ? JSON.stringify([g.point]) : "[]" },
      { node: "p_detect", field: "threshold", value: g.point ? 1 : num(s, "detectThreshold", 0.4) },
      // Con clic basta una pasada de refinado; sin clic, dos.
      { node: "p_detect", field: "refine_iterations", value: g.point ? 1 : 2 },
      { node: "p_sam_text", field: "text", value: samText },
      // Paso "objeto entero": solo con clic. Sin clic, 1.0 lo apaga (así "man, guitar" se queda como la unión de ambos).
      { node: "p_whole", field: "detection_threshold", value: g.point ? 0.4 : 1 },
      { node: "p_grow", field: "expand", value: g.grow },
      { node: "p_feather", field: "blur_radius", value: g.feather },
      { node: "p_feather", field: "sigma", value: Math.min(10, Math.max(1, g.feather / 2.5)) },
      { node: "in_out", field: "resize_type.width", value: g.out.w }, { node: "in_out", field: "resize_type.height", value: g.out.h },
      { node: "in_orig_out", field: "resize_type.width", value: g.out.w }, { node: "in_orig_out", field: "resize_type.height", value: g.out.h },
      { node: "in_mask_out", field: "resize_type.width", value: g.out.w }, { node: "in_mask_out", field: "resize_type.height", value: g.out.h },
      // La IC-LoRA de inpainting no es de edición: el prompt describe lo que va en el hueco (vacío = lo que rodea).
      { node: "p_prompt", field: "text", value: fill },
      ...engineInputs(s, { lora: 1, guide: 1 }),
      { node: "p_lora2", field: "strength_model", value: num(s, "cleanStrength", 1) },
    ],
  };
}

const SEEDVR: Record<string, string> = {
  "3B fast": "seedvr2_3b_int8_convrot.safetensors",
  "7B quality": "seedvr2_7b_int8_convrot.safetensors",
  "7B sharp": "seedvr2_7b_sharp_int8_convrot.safetensors",
};

export function planUpscale(meta: Meta, s: Settings, maxSeconds = 5): { inputs: Input[] } {
  const want = num(s, "scale", 2);
  // Tope de memoria: SeedVR2 tiene en RAM varias copias de todos los cuadros. Por encima de ~700 M píxeles·cuadro
  // se baja el factor para que el trabajo no se quede sin memoria.
  const frames = (meta.fps ?? 30) * Math.min(meta.length ?? 5, meta.duration - (meta.start ?? 0));
  const budget = Math.sqrt(700e6 / Math.max(1, frames * meta.width * meta.height));
  const factor = Math.max(1, Math.min(want, 3840 / Math.max(meta.width, meta.height), budget));
  const seed = num(s, "seed", 42);
  return {
    inputs: [
      ...trim(meta, maxSeconds),
      { node: "in_scale", field: "resize_type.multiplier", value: Number(factor.toFixed(3)) },
      { node: "dit", field: "unet_name", value: SEEDVR[str(s, "model", "3B fast")] ?? SEEDVR["3B fast"] },
      { node: "p_color", field: "color_correction_method", value: str(s, "color", "lab") },
      { node: "p_sampler", field: "seed", value: seed < 0 ? Math.floor(Math.random() * 2 ** 31) : seed },
    ],
  };
}

export function hexToInt(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? parseInt(m[1], 16) : 0x00b140;
}

export function planCutout(meta: Meta, s: Settings, maxSeconds = 5): { inputs: Input[] } {
  return { inputs: [...trim(meta, maxSeconds), { node: "in_bg", field: "color", value: hexToInt(str(s, "background", "#00B140")) }] };
}

/** Un puente de Smooth Cut entre dos cuadros ya extraídos. */
export function planBridge(frame: { width: number; height: number; fps: number }, s: Settings): { inputs: Input[] } {
  const ratio = frame.width / frame.height;
  // "high": los puentes van entre tomas reales a resolución completa, así que se generan con más detalle.
  const work = workSize(ratio, "high");
  const len = Number(str(s, "bridge", "17"));
  const strength = num(s, "keyStrength", 1);
  const seed = num(s, "seed", 42);
  return {
    inputs: [
      { node: "in_size_a", field: "resize_type.width", value: work.w }, { node: "in_size_a", field: "resize_type.height", value: work.h },
      { node: "in_size_b", field: "resize_type.width", value: work.w }, { node: "in_size_b", field: "resize_type.height", value: work.h },
      { node: "in_work", field: "width", value: work.w }, { node: "in_work", field: "height", value: work.h },
      { node: "in_len", field: "value", value: [9, 17, 25].includes(len) ? len : 17 },
      { node: "in_fps", field: "value", value: frame.fps },
      { node: "in_out", field: "resize_type.width", value: even(frame.width) },
      { node: "in_out", field: "resize_type.height", value: even(frame.height) },
      { node: "p_key0", field: "strength", value: strength },
      { node: "p_key1", field: "strength", value: strength },
      { node: "p_prompt", field: "text", value: str(s, "prompt", "Static camera. The same person keeps the same pose with a subtle, natural head movement. Mouth closed.") },
      { node: "p_sampler", field: "seed", value: seed < 0 ? Math.floor(Math.random() * 2 ** 31) : seed },
    ],
  };
}
