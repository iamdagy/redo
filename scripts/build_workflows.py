#!/usr/bin/env python3
"""Genera los workflows de Open Edit Video (formato API de ComfyUI) a partir de un solo motor.

Todos usan solo nodos nativos de ComfyUI disponibles en Comfy Cloud. Las herramientas de LTX
comparten el mismo motor (`ltx_engine`): solo cambian la IC-LoRA, la guía y el prompt.

Los nodos que la app cambia llevan un ID corto y fijo (`in_*`, `p_*`) y su `_meta.title`
empieza por `IN:`. La app calcula los números (tamaños múltiplos de 32, ventana, márgenes);
el grafo solo genera.

Uso: python3 scripts/build_workflows.py   (escribe workflows/*.api.json)
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "workflows"

LTX_CKPT = "ltx-2.3-22b-distilled-fp8.safetensors"
GEMMA = "gemma_3_12B_it_fp4_mixed.safetensors"
NEG = ("blurry, out of focus, low contrast, washed out colors, noise, flicker, warping, distorted faces, "
       "extra limbs, text, watermark, borders, black bars")


class G:
    """Constructor mínimo de un grafo API."""

    def __init__(self):
        self.nodes = {}

    def add(self, nid, cls, title=None, **inputs):
        node = {"class_type": cls, "inputs": inputs}
        if title:
            node["_meta"] = {"title": title}
        self.nodes[nid] = node
        return nid

    def save(self, name):
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"{name}.api.json").write_text(json.dumps(self.nodes, indent=2, ensure_ascii=False) + "\n")
        print(f"workflows/{name}.api.json  {len(self.nodes)} nodos")


def L(nid, slot=0):
    return [nid, slot]


def video_source(g):
    """Video subido → tramo → cuadros, audio y fps. Recorta los cuadros a 8n+1 (lo que pide LTX)."""
    g.add("in_video", "LoadVideo", "IN:video", file="input.mp4")
    g.add("in_trim", "Video Slice", "IN:trim (start, duration)", video=L("in_video"), start_time=0.0, duration=5.0, strict_duration=False)
    g.add("parts", "GetVideoComponents", video=L("in_trim"))
    g.add("size", "GetImageSize", image=L("parts", 0))
    g.add("n_frames", "ComfyMathExpression", expression="max(9, int((a - 1) / 8) * 8 + 1)", **{"values.a": L("size", 2)})
    g.add("frames", "ImageFromBatch", image=L("parts", 0), batch_index=0, length=L("n_frames", 1))
    return L("frames"), L("parts", 1), L("parts", 2), L("n_frames", 1)


def ltx_engine(g, guide, n_frames, fps, work_w, work_h, lora=None, lora_strength=1.0, guide_strength=1.0,
               prompt="", steps=8, seed=42, extra_guides=None):
    """Motor común de LTX 2.3: guía con IC-LoRA (o guías de cuadro para primer/último cuadro).

    `guide` = cuadros que van como guía en el cuadro 0 (None si no hay guía de video).
    `extra_guides` = [(imagen, frame_idx, strength)] para Smooth Cut y Extender.
    Devuelve los cuadros decodificados.
    """
    g.add("ckpt", "CheckpointLoaderSimple", ckpt_name=LTX_CKPT)
    g.add("audio_vae", "LTXVAudioVAELoader", ckpt_name=LTX_CKPT)
    g.add("text_enc", "LTXAVTextEncoderLoader", text_encoder=GEMMA, ckpt_name=LTX_CKPT, device="default")
    model = L("ckpt", 0)
    if lora:
        g.add("p_lora", "LoraLoaderModelOnly", "IN:lora (preset)", model=model, lora_name=lora, strength_model=lora_strength)
        g.add("iclora", "GetICLoRAParameters", iclora_model=L("p_lora"))
        model = L("p_lora")
    g.add("p_prompt", "CLIPTextEncode", "IN:prompt", text=prompt, clip=L("text_enc"))
    g.add("p_negative", "CLIPTextEncode", "IN:negative", text=NEG, clip=L("text_enc"))
    g.add("cond", "LTXVConditioning", positive=L("p_prompt"), negative=L("p_negative"), frame_rate=fps)
    g.add("in_work", "EmptyLTXVLatentVideo", "IN:work size", width=work_w, height=work_h, length=n_frames, batch_size=1)
    pos, neg, lat = L("cond", 0), L("cond", 1), L("in_work")
    if guide is not None:
        extra = {"iclora_parameters": L("iclora")} if lora else {}
        g.add("p_guide", "LTXVAddGuide", "IN:guide strength (preset)", positive=pos, negative=neg, vae=L("ckpt", 2),
              latent=lat, image=guide, frame_idx=0, strength=guide_strength, **extra)
        pos, neg, lat = L("p_guide", 0), L("p_guide", 1), L("p_guide", 2)
    for i, (img, idx, strength) in enumerate(extra_guides or []):
        nid = f"p_key{i}"
        g.add(nid, "LTXVAddGuide", f"IN:keyframe {i} (preset)", positive=pos, negative=neg, vae=L("ckpt", 2),
              latent=lat, image=img, frame_idx=idx, strength=strength)
        pos, neg, lat = L(nid, 0), L(nid, 1), L(nid, 2)
    g.add("audio_lat", "LTXVEmptyLatentAudio", frames_number=n_frames, frame_rate=fps, batch_size=1, audio_vae=L("audio_vae"))
    g.add("av", "LTXVConcatAVLatent", video_latent=lat, audio_latent=L("audio_lat"))
    g.add("p_sampler", "KSampler", "IN:sampler (seed, steps)", model=model, seed=seed, steps=steps, cfg=1.0,
          sampler_name="euler_ancestral", scheduler="linear_quadratic", positive=pos, negative=neg,
          latent_image=L("av"), denoise=1.0)
    g.add("split", "LTXVSeparateAVLatent", av_latent=L("p_sampler"))
    g.add("crop_guides", "LTXVCropGuides", positive=pos, negative=neg, latent=L("split", 0))
    g.add("decode", "VAEDecodeTiled", samples=L("crop_guides", 2), vae=L("ckpt", 2),
          tile_size=768, overlap=64, temporal_size=4096, temporal_overlap=64)
    return L("decode")


def resize(g, nid, image, w, h, title=None, method="lanczos", crop="disabled"):
    g.add(nid, "ResizeImageMaskNode", title, input=image, resize_type="scale dimensions",
          **{"resize_type.width": w, "resize_type.height": h, "resize_type.crop": crop}, scale_method=method)
    return L(nid)


def save(g, images, fps, audio=None, prefix="open-edit-video/out", nid="out_video", title="OUT:video"):
    extra = {"audio": audio} if audio else {}
    g.add(nid + "_mux", "CreateVideo", images=images, fps=fps, **extra)
    # CRF 16: calidad alta para no perder detalle al guardar.
    g.add(nid, "SaveVideo", title, video=L(nid + "_mux"), filename_prefix=prefix, format="mp4",
          **{"format.codec": "h264", "format.codec.encoding": "re-encode", "format.codec.encoding.crf": 16})


# ── Reencuadrar ─────────────────────────────────────────────────────────────
def reframe():
    """Ventana del original → lienzo negro → outpaint LTX → re-pegado del original a resolución completa."""
    g = G()
    frames, audio, fps, n = video_source(g)
    # Ventana del original (en píxeles de la fuente) y su versión a tamaño de trabajo.
    g.add("in_crop", "ImageCrop", "IN:crop window (source px)", image=frames, width=1080, height=1080, x=420, y=0)
    win = resize(g, "in_win", L("in_crop"), 544, 544, "IN:window at work size")
    # Lienzo negro (la LoRA de outpaint se entrenó con relleno negro) con la ventana encima.
    g.add("in_canvas", "EmptyImage", "IN:work canvas", width=544, height=960, batch_size=n, color=0)
    g.add("in_place", "ImageCompositeMasked", "IN:window position (work)", destination=L("in_canvas"), source=win, x=0, y=208, resize_source=False)
    gen = ltx_engine(g, L("in_place"), n, fps, 544, 960, lora="ltx-2.3-22b-ic-lora-outpaint.safetensors",
                     lora_strength=1.0, guide_strength=1.0,
                     prompt="The same scene continues naturally beyond the original frame: same lighting, same camera, same style.")
    # Re-pegado: el generado sube al tamaño final y encima va el original a su resolución nativa, con borde suave.
    up = resize(g, "in_out", gen, 1080, 1920, "IN:output size")
    g.add("in_mask", "SolidMask", "IN:window mask (source px)", value=1.0, width=1080, height=1080)
    g.add("p_feather", "FeatherMask", "IN:seam feather (preset)", mask=L("in_mask"), left=24, top=24, right=24, bottom=24)
    orig = resize(g, "in_crop_out", L("in_crop"), 1080, 1080, "IN:original at output size")
    g.add("in_paste", "ImageCompositeMasked", "IN:paste-back position (output px)", destination=up, source=orig,
          x=0, y=420, resize_source=False, mask=L("p_feather"))
    save(g, L("in_paste"), fps, audio, prefix="open-edit-video/reframe")
    g.save("reframe")


# ── Quitar: clic (o texto) → SAM3 → relleno LTX solo en la máscara → re-pegado ─────────
SAM3_CKPT = "sam3.1_multiplex_fp16.safetensors"
INPAINT_LORA = "ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors"
CLEAN_PLATE_LORA = "ltx-2.3-22b-ic-lora-clean-plate-1.0.safetensors"
GREEN = 0x66FF00  # color con que se entrenó la IC-LoRA de in/outpainting (LTXVInpaintPreprocess de Lightricks)


def remove(name="remove", lora=INPAINT_LORA, green=True, lora2=CLEAN_PLATE_LORA):
    """Quitar un objeto marcado con un clic en el primer cuadro del tramo (o descrito con texto).

    1. SAM3_Detect en el primer cuadro (a tamaño de trabajo) con el punto `in_point` (JSON en px de ese cuadro).
       Con punto, `p_detect.threshold` = 1.0 apaga la detección por texto. Sin punto (`in_point` = "[]"),
       el texto `p_sam_text` detecta el objeto.
    2. Paso "objeto entero" (`p_whole`): el clic suele dar solo una parte; el detector de texto la cambia por el
       objeto que la contiene. 3. SAM3_VideoTrack sigue esa máscara en todos los cuadros → dilatada (`p_grow`).
    4. Guía: los cuadros con la zona enmascarada en verde #66FF00 → LTX con las IC-LoRA in/outpainting + clean-plate.
    5. Re-pegado: el original (a tamaño de salida) fuera de la máscara y lo generado dentro, con borde suave.
       Si SAM3 no encuentra nada, la máscara queda vacía y la salida es igual al original.
    """
    g = G()
    frames, audio, fps, n = video_source(g)
    work = resize(g, "in_guide", frames, 960, 544, "IN:work size frames")
    # Máscara del objeto, a tamaño de trabajo.
    g.add("sam", "CheckpointLoaderSimple", ckpt_name=SAM3_CKPT)
    g.add("first", "ImageFromBatch", image=work, batch_index=0, length=1)
    g.add("in_point", "PrimitiveString", "IN:click point JSON (work px)", value='[{"x": 480, "y": 272}]')
    g.add("p_sam_text", "CLIPTextEncode", "IN:object text (SAM3)", text="person", clip=L("sam", 1))
    g.add("p_detect", "SAM3_Detect", "IN:detect (threshold 1.0 = point only)", model=L("sam", 0), image=L("first"),
          conditioning=L("p_sam_text"), positive_coords=L("in_point"), threshold=1.0, refine_iterations=1,
          individual_masks=False)
    # Un clic suele dar solo una parte (la camisa, una hoja). Paso 1: el tracker corre sobre [primer cuadro, primer
    # cuadro] con la máscara del clic y el texto; en el 2.º cuadro el detector de texto la reemplaza por la máscara
    # del objeto entero que la contiene (score ≥ 0.8 y solapamiento ≥ 0.5). Se toma solo el objeto 0 (el del clic).
    g.add("first2", "ImageBatch", image1=L("first"), image2=L("first"))
    g.add("p_whole", "SAM3_VideoTrack", "IN:whole-object pass (text)", images=L("first2"), model=L("sam", 0),
          initial_mask=L("p_detect", 0), conditioning=L("p_sam_text"), detection_threshold=0.4, max_objects=0, detect_interval=1)
    g.add("whole_all", "SAM3_TrackToMask", track_data=L("p_whole"), object_indices="0")
    g.add("whole_img", "MaskToImage", mask=L("whole_all"))
    g.add("whole_last", "ImageFromBatch", image=L("whole_img"), batch_index=1, length=1)
    g.add("whole_mask_soft", "ImageToMask", image=L("whole_last"), channel="red")
    g.add("whole_mask", "ThresholdMask", mask=L("whole_mask_soft"), value=0.5)
    # Paso 2: seguir ese objeto entero en todos los cuadros (sin texto: con max_objects 1 no detecta nada nuevo).
    g.add("track", "SAM3_VideoTrack", images=work, model=L("sam", 0), initial_mask=L("whole_mask"),
          detection_threshold=0.5, max_objects=1, detect_interval=1)
    g.add("track_mask", "SAM3_TrackToMask", track_data=L("track"), object_indices="0")
    g.add("bin_mask", "ThresholdMask", mask=L("track_mask"), value=0.5)
    g.add("p_grow", "GrowMask", "IN:mask dilation (work px)", mask=L("bin_mask"), expand=16, tapered_corners=True)
    # Guía: zona enmascarada en verde, como la entrenó Lightricks.
    g.add("in_green", "EmptyImage", "IN:green fill (work size)", width=960, height=544, batch_size=n, color=GREEN)
    g.add("guide", "ImageCompositeMasked", destination=work, source=L("in_green"), x=0, y=0, resize_source=False,
          mask=L("p_grow"))
    gen = ltx_engine(g, L("guide") if green else work, n, fps, 960, 544, lora=lora, lora_strength=1.0, guide_strength=1.0,
                     prompt="")
    if lora2:
        # Clean-plate (quita personas del cuadro entero) apilada sobre in/outpainting (rellena lo verde). Solas, la de
        # inpainting volvía a dibujar a la persona o la planta en el hueco y la clean-plate no quitaba objetos.
        g.add("p_lora2", "LoraLoaderModelOnly", "IN:clean-plate lora strength", model=L("p_lora"), lora_name=lora2, strength_model=1.0)
        g.nodes["p_sampler"]["inputs"]["model"] = L("p_lora2")
    # Re-pegado a tamaño de salida: solo cambia lo que está dentro de la máscara.
    up = resize(g, "in_out", gen, 1920, 1080, "IN:output size")
    orig = resize(g, "in_orig_out", frames, 1920, 1080, "IN:original at output size")
    g.add("p_grow_out", "GrowMask", "IN:paste mask extra dilation (work px)", mask=L("p_grow"), expand=4, tapered_corners=True)
    g.add("mask_img", "MaskToImage", mask=L("p_grow_out"))
    mask_out = resize(g, "in_mask_out", L("mask_img"), 1920, 1080, "IN:mask at output size", method="bilinear")
    g.add("p_feather", "ImageBlur", "IN:paste feather (output px)", image=mask_out, blur_radius=15, sigma=6.0)
    g.add("soft_mask", "ImageToMask", image=L("p_feather"), channel="red")
    g.add("paste", "ImageCompositeMasked", destination=orig, source=up, x=0, y=0, resize_source=False, mask=L("soft_mask"))
    save(g, L("paste"), fps, audio, prefix="open-edit-video/remove")
    g.save(name)


# ── Smooth Cut: puente entre dos cuadros ───────────────────────────────────
def bridge():
    """Cuadro A (antes del corte) → cuadro B (después) en 9, 17 o 25 cuadros."""
    g = G()
    g.add("in_frame_a", "LoadImage", "IN:frame A", image="frame_a.png")
    g.add("in_frame_b", "LoadImage", "IN:frame B", image="frame_b.png")
    a = resize(g, "in_size_a", L("in_frame_a"), 960, 544, "IN:work size A", crop="center")
    b = resize(g, "in_size_b", L("in_frame_b"), 960, 544, "IN:work size B", crop="center")
    g.add("prep_a", "LTXVPreprocess", image=a, img_compression=25)
    g.add("prep_b", "LTXVPreprocess", image=b, img_compression=25)
    g.add("in_len", "PrimitiveInt", "IN:bridge frames (8n+1)", value=17)
    g.add("in_fps", "PrimitiveFloat", "IN:fps", value=25.0)
    gen = ltx_engine(g, None, L("in_len"), L("in_fps"), 960, 544,
                     prompt="Static camera. The same person keeps the same pose with a subtle, natural head movement. Mouth closed.",
                     extra_guides=[(L("prep_a"), 0, 1.0), (L("prep_b"), -1, 1.0)])
    out = resize(g, "in_out", gen, 1920, 1080, "IN:output size")
    save(g, out, L("in_fps"), None, prefix="open-edit-video/bridge")
    g.save("bridge")


# ── Upscale ─────────────────────────────────────────────────────────────────
def upscale():
    """SeedVR2 3B int8 con los nodos nativos de SeedVR2, por tramos para no agotar memoria."""
    g = G()
    g.add("in_video", "LoadVideo", "IN:video", file="input.mp4")
    g.add("in_trim", "Video Slice", "IN:trim (start, duration)", video=L("in_video"), start_time=0.0, duration=5.0, strict_duration=False)
    g.add("parts", "GetVideoComponents", video=L("in_trim"))
    g.add("in_scale", "ResizeImageMaskNode", "IN:scale (x2, x3, x4)", input=L("parts", 0), resize_type="scale by multiplier",
          **{"resize_type.multiplier": 2.0}, scale_method="lanczos")
    g.add("dit", "UNETLoader", unet_name="seedvr2_3b_int8_convrot.safetensors", weight_dtype="default")
    g.add("vae", "VAELoader", vae_name="seedvr2_ema_vae_fp16.safetensors")
    g.add("pre", "SeedVR2Preprocess", resized_images=L("in_scale"))
    g.add("enc", "VAEEncodeTiled", pixels=L("pre"), vae=L("vae"), tile_size=512, overlap=128, temporal_size=64, temporal_overlap=8)
    # Camino directo de SeedVR2, sin dividir en tramos temporales.
    g.add("cond", "SeedVR2Conditioning", model=L("dit"), vae_conditioning=L("enc"))
    g.add("p_sampler", "KSampler", "IN:sampler (seed)", model=L("dit"), seed=42, steps=1, cfg=1.0, sampler_name="euler",
          scheduler="simple", positive=L("cond", 0), negative=L("cond", 1), latent_image=L("enc"), denoise=1.0)
    g.add("dec", "VAEDecodeTiled", samples=L("p_sampler"), vae=L("vae"), tile_size=512, overlap=128, temporal_size=64, temporal_overlap=8)
    g.add("p_color", "SeedVR2PostProcessing", "IN:color correction (preset)", images=L("dec"), original_resized_images=L("in_scale"),
          color_correction_method="lab")
    save(g, L("p_color"), L("parts", 2), L("parts", 1), prefix="open-edit-video/upscale")
    g.save("upscale")


# ── Quitar fondo ────────────────────────────────────────────────────────────
def cutout():
    """BiRefNet cuadro por cuadro: sujeto sobre un color plano + la máscara como video aparte."""
    g = G()
    g.add("in_video", "LoadVideo", "IN:video", file="input.mp4")
    g.add("in_trim", "Video Slice", "IN:trim (start, duration)", video=L("in_video"), start_time=0.0, duration=5.0, strict_duration=False)
    g.add("parts", "GetVideoComponents", video=L("in_trim"))
    g.add("size", "GetImageSize", image=L("parts", 0))
    g.add("bg_model", "LoadBackgroundRemovalModel", bg_removal_name="birefnet.safetensors")
    g.add("matte", "RemoveBackground", bg_removal_model=L("bg_model"), image=L("parts", 0))
    g.add("in_bg", "EmptyImage", "IN:background color (preset)", width=L("size", 0), height=L("size", 1), batch_size=L("size", 2), color=0x00B140)
    g.add("comp", "ImageCompositeMasked", destination=L("in_bg"), source=L("parts", 0), x=0, y=0, resize_source=False, mask=L("matte"))
    save(g, L("comp"), L("parts", 2), L("parts", 1), prefix="open-edit-video/cutout")
    g.add("matte_img", "MaskToImage", mask=L("matte"))
    save(g, L("matte_img"), L("parts", 2), None, prefix="open-edit-video/cutout-matte", nid="out_matte", title="OUT:matte")
    g.save("cutout")


if __name__ == "__main__":
    for build in (reframe, remove, bridge, upscale, cutout):
        build()
