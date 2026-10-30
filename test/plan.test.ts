import { test } from "node:test";
import assert from "node:assert/strict";
import { reframeGeometry, planReframe, workSize, planRemove, cleanWhat } from "../lib/plan.ts";
import { readFileSync } from "node:fs";

test("16:9 → 9:16 con keep 0.5 usa una ventana 1:1 de toda la altura", () => {
  const g = reframeGeometry({ width: 1920, height: 1080, duration: 5 }, { aspect: "9:16", keep: 0.5 });
  assert.equal(g.cropH, 1080); assert.equal(g.cropW, 1080);
  assert.equal(g.work.w % 32, 0); assert.equal(g.work.h % 32, 0);
  assert.ok(g.generatedShare > 0.4 && g.generatedShare < 0.5, String(g.generatedShare));
  assert.ok(g.pasteW <= g.outW && g.pasteH <= g.outH);
});
test("keep 0 es un recorte puro", () => {
  const g = reframeGeometry({ width: 1920, height: 1080, duration: 5 }, { aspect: "9:16", keep: 0 });
  assert.ok(g.generatedShare < 0.02, String(g.generatedShare));
});
test("16:9 → 21:9 conserva todo el cuadro y genera los lados", () => {
  const g = reframeGeometry({ width: 1920, height: 1080, duration: 5 }, { aspect: "21:9", keep: 0.5 });
  assert.equal(g.cropW, 1920); assert.equal(g.cropH, 1080);
});
test("tamaño de trabajo en múltiplos de 32", () => {
  for (const q of ["fast", "normal", "high"]) for (const r of [9 / 16, 1, 16 / 9, 21 / 9]) {
    const w = workSize(r, q); assert.equal(w.w % 32, 0); assert.equal(w.h % 32, 0);
  }
});
test("el plan llena todos los nodos de geometría", () => {
  const { inputs } = planReframe({ width: 1280, height: 720, duration: 8 }, { aspect: "9:16" });
  const nodes = new Set(inputs.map((i) => i.node));
  for (const n of ["in_trim", "in_crop", "in_win", "in_canvas", "in_place", "in_work", "in_out", "in_mask", "in_paste", "p_feather", "p_sampler"]) assert.ok(nodes.has(n), n);
  assert.equal(inputs.find((i) => i.node === "in_trim" && i.field === "duration")!.value, 5);
});

test("reframe: vertical framing moves the footage up and down when there is room", () => {
  const meta = { width: 480, height: 592, duration: 5 };
  const top = reframeGeometry(meta, { aspect: "9:16", keep: 0.5, positionY: 0 });
  const bottom = reframeGeometry(meta, { aspect: "9:16", keep: 0.5, positionY: 1 });
  assert.equal(top.canMoveY, true);
  assert.equal(top.winY, 0);
  assert.equal(bottom.winY + bottom.winH, bottom.work.h);
  // Un recorte 16:9 → 9:16 sin conservar nada solo se mueve a los lados.
  const crop = reframeGeometry({ width: 1920, height: 1080, duration: 5 }, { aspect: "9:16", keep: 0 });
  assert.equal(crop.canMoveY, false);
  assert.equal(crop.canMoveX, true);
});

const val = (inputs: { node: string; field: string; value: unknown }[], node: string, field: string) =>
  inputs.find((i) => i.node === node && i.field === field)?.value;

test("remove: the click (fractions of the first frame) becomes pixels of the work-size frame SAM3 sees", () => {
  const { inputs, geometry } = planRemove({ width: 1920, height: 1080, duration: 10, start: 2, length: 3 }, { pointX: 0.25, pointY: 0.5, what: "" });
  assert.deepEqual(geometry.work, { w: 960, h: 544 });
  assert.deepEqual(JSON.parse(String(val(inputs, "in_point", "value"))), [{ x: 240, y: 272 }]);
  // Click only: SAM3_Detect uses just the point; the whole-object pass uses a generic category list.
  assert.equal(val(inputs, "p_detect", "threshold"), 1);
  assert.match(String(val(inputs, "p_sam_text", "text")), /person, animal, plant/);
  assert.equal(val(inputs, "p_whole", "detection_threshold"), 0.4);
  assert.equal(val(inputs, "in_trim", "start_time"), 2);
  assert.equal(val(inputs, "in_out", "resize_type.width"), 1920);
  assert.equal(val(inputs, "in_mask_out", "resize_type.height"), 1080);
});

test("remove: clicks at the edges stay inside the frame; a text label narrows the whole-object pass", () => {
  const { inputs } = planRemove({ width: 640, height: 360, duration: 5 }, { pointX: 1, pointY: 0, what: "Remove the plant." });
  assert.deepEqual(JSON.parse(String(val(inputs, "in_point", "value"))), [{ x: 959, y: 0 }]);
  assert.equal(val(inputs, "p_sam_text", "text"), "plant");
  assert.equal(val(inputs, "in_out", "resize_type.width"), 640);
});

test("remove: without a click it falls back to SAM3 text detection", () => {
  const { inputs, geometry } = planRemove({ width: 1280, height: 720, duration: 5 }, { pointX: "", pointY: "", what: "man, guitar" });
  assert.equal(geometry.point, null);
  assert.equal(val(inputs, "in_point", "value"), "[]");
  assert.ok(Number(val(inputs, "p_detect", "threshold")) < 1);
  assert.equal(val(inputs, "p_sam_text", "text"), "man, guitar");
  assert.equal(val(inputs, "p_whole", "detection_threshold"), 1);
  assert.equal(cleanWhat("please remove the man in the back."), "man in the back");
});

test("remove: every node the plan sets exists in the workflow", () => {
  const wf = JSON.parse(readFileSync(new URL("../workflows/remove.api.json", import.meta.url), "utf8"));
  const { inputs } = planRemove({ width: 1920, height: 1080, duration: 5 }, { pointX: 0.5, pointY: 0.5, loraStrength: 1.2, seed: 7 });
  for (const i of inputs) {
    assert.ok(wf[i.node], `missing node ${i.node}`);
    assert.ok(i.field in wf[i.node].inputs, `${i.node} has no input ${i.field}`);
  }
  assert.equal(val(inputs, "p_lora", "strength_model"), 1.2);
});
