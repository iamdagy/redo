# Redo — Open Edit Video

**Fix a shot without reshooting it.** Redo is an open-source video editor built on the Comfy Developer Platform. Drop in a clip, pick the moment, pick a tool, preview what will change, and run it on Comfy Cloud with your own Comfy account.

- **Open weights only.** LTX-2.3, SAM 3.1, SeedVR2 and BiRefNet. No partner APIs, no closed models.
- **Stock ComfyUI.** Every workflow uses only native ComfyUI nodes that ship with Comfy Cloud. No custom node packs to install, so anyone can open, read and rerun them.
- **Your footage stays yours.** Wherever possible the tools change only what you asked for and paste the original pixels back everywhere else.

**Try it:** [redoapp.dev](https://redoapp.dev) · **Code:** [github.com/iamdagy/redo](https://github.com/iamdagy/redo) · Built for the Comfy Challenge.

## The tools

| Tool | What you do | What it does | Models | Measured on Comfy Cloud |
|---|---|---|---|---|
| **Reframe** | Pick a new shape (9:16, 4:5, 1:1, 16:9, 21:9 or any W:H) and drag the picture to frame it | Generates only the new space around your shot; the original is pasted back at full resolution with a soft seam | LTX-2.3 + outpaint IC-LoRA | 5 s: 50–67 s · 30 s: 4.2 min |
| **Remove** | Click the object (or name it) | SAM 3.1 finds it on the first frame and tracks it through the clip; LTX repaints only that area; everything else stays the original | SAM 3.1 + LTX-2.3 in/outpainting + clean-plate IC-LoRAs | 2 s: 23–50 s |
| **Smooth Cut** | Choose how long a pause must be to cut it | Cuts silences, filler words and repeated words from someone talking, and blends every cut with a short generated bridge so it doesn't jump | ffmpeg + whisper.cpp (optional) + LTX-2.3 first/last frame | ~15 s per bridge, 3 at a time |
| **Upscale** | ×2, ×3, ×4 or any factor, up to 4K | One-step video restoration and upscaling | SeedVR2 3B / 7B / 7B sharp | 5 s at ×2: 73 s · 30 s: OK |
| **Remove background** | Pick a color | Subject on a flat color, plus a black-and-white mask as a second video | BiRefNet | 1 s: 6–12 s · 30 s: 72 s |

Every tool works on the part of the clip you select: drag the box on the timeline or type the start, end and length (1 to 30 s; up to 180 s for Smooth Cut).

## What's different

1. **Native nodes only, so it's easy to reuse.** The official templates we started from pull in custom node packs (the LTX outpaint template has 46 nodes, 9 of them from KJNodes, VHS and others). Ours rebuild the same ideas with stock nodes that are already on Comfy Cloud: nothing to install, no version drift, and any ComfyUI user can follow the graph. We checked every node, input and link against Comfy Cloud's node catalog before shipping.
2. **Simple on the outside.** No LoRA strengths, steps or seeds in the interface. Each control says what changes in the video ("Crop or extend", "Room noise: Quiet / Normal / Noisy"), every choice has a *Custom* option for fine control, and the extra explanation lives behind a "?". The preview draws the result before you spend credits: the area the AI will paint in Reframe, the pauses Smooth Cut will cut (click one to keep it), the final size in Upscale.
3. **Keeps the original.** Reframe and Remove only generate where needed and paste your footage back. In Remove, the frame outside the object measured 42 dB PSNR against the source (that's just h264 re-encoding).
4. **Click to remove.** No masks to paint: one click, and SAM 3.1 follows the object through the shot.
5. **Smooth Cut hides the cut instead of just making it.** Silence cutters leave jump cuts, and hiding them is usually manual work. Here every cut gets an LTX bridge from the last frame before it to the first frame after it, automatically.
6. **One engine, many tools.** All LTX tools share one native graph: `GetICLoRAParameters` + `LTXVAddGuide` + an 8-step distilled sampler. A new tool is a new IC-LoRA and a new way to build the guide.

## How it works

```
Browser ──► Next.js API routes ──► @comfyorg/sdk ──► Comfy Cloud (native nodes, open weights)
              │                                            │
              ├─ lib/prep.ts: cut the selected part, cap at 30 fps
              ├─ lib/plan.ts: all geometry and values       └─ workflows/*.api.json
              └─ lib/smoothcut*.ts: ffmpeg + whisper.cpp + bridges + assembly
```

- **The graph generates; the app does the math.** `lib/plan.ts` computes frame sizes (multiples of 32), frame counts (8n+1), the reframe window, the paste-back position and every value, then sets them on nodes with fixed IDs (`in_*`, `p_*`). It has unit tests.
- **Workflows are generated, not hand-edited.** `scripts/build_workflows.py` writes them.
- **Only the selected part is uploaded.** The server cuts the range first and brings 50/60 fps phone clips down to 30 fps (LTX accepts up to 1,000 frames).

| Workflow | Nodes | Steps |
|---|---|---|
| `reframe` | 33 | crop window → place on a black canvas → LTX outpaint → scale → paste the original back with a feathered mask |
| `remove` | 52 | click point → SAM3_Detect (whole object) → SAM3_VideoTrack → grow mask → green guide → LTX in/outpainting + clean-plate → paste back outside the mask |
| `bridge` | 26 | frames A and B → LTX first/last-frame guides → bridge clip (one job per Smooth Cut cut) |
| `upscale` | 14 | native SeedVR2 nodes (direct path, as in the official template) |
| `cutout` | 13 | BiRefNet → flat color composite + mask |

## Run it

Requirements: Node.js 24 LTS or newer (tested on 26), ffmpeg and ffprobe. whisper.cpp (`whisper-cli` plus `ggml-large-v3-turbo.bin`) is optional; without it Smooth Cut cuts silences only.

```bash
npm ci
cp .env.example .env.local    # SITE_URL, OEV_REQUIRE_USER_KEY and the optional settings
npm run build
npm start -- -p 3000          # listens on 127.0.0.1; put it behind a reverse proxy or a tunnel to publish it
```

`.env.example` lists every setting. On a public server keep `OEV_REQUIRE_USER_KEY=1` so each visitor uses their own Comfy API key and the server stores none. For private use you can set `COMFY_API_KEY` instead.

Open http://127.0.0.1:3000. With `OEV_REQUIRE_USER_KEY=1`, the app asks for a Comfy API key the first time you run a tool and explains where to get one ([platform.comfy.org/profile/api-keys](https://platform.comfy.org/profile/api-keys)). The key stays in the visitor's browser and is only used to send their jobs. The account needs Comfy Cloud credits.

## Sample clip

`public/samples/cafe-talk.mp4` (12 s, 1280×704, with speech) was generated for this project with LTX-2.3 on Comfy Cloud, using the same native engine as the app (text to video with audio, 8 steps). It was designed to try every tool: a person talking with natural pauses for Smooth Cut, a cup, a plant and passers-by for Remove, a wide shot for Reframe, a clear subject for Remove background, and 720p for Upscale.

## Limits and what's next

What we reached in the time we had, and where it can improve:

- **Remove:** the click must land on the object (a miss returns the clip unchanged). Things a person holds stay unless you name both ("man, guitar"). Shadows and reflections outside the object can remain. *Next:* a mask preview before running.
- **Reframe:** very large AI areas (over half the frame) can invent details; describing the scene helps. *Next:* a second pass with LTX's latent upsampler for sharper borders.
- **Smooth Cut:** bridges look best when the head barely moves across the cut. Filler-word detection needs whisper.cpp on the server.
- **Upscale:** long 4K jobs are capped by memory; the app lowers the factor when needed. *Next:* split long clips into chunks.
- **Remove background:** some edge flicker on hair and fast motion. *Next:* combine BiRefNet with a SAM 3.1 track.
- **Lengths:** up to 30 s per run (180 s for Smooth Cut). Longer runs take minutes and more credits.
- **Jobs are kept in memory on one server:** fine for local use and the demo, not for many users.

## Acknowledgements

Redo is glue code. The heavy lifting is done by the open models and tools below. Thank you to their authors.

### Models

- **LTX-2.3 22B distilled (`ltx-2.3-22b-distilled-fp8`) and its audio VAE** — Lightricks — [Lightricks/LTX-2.3](https://huggingface.co/Lightricks/LTX-2.3), [LTX-2.3-fp8](https://huggingface.co/Lightricks/LTX-2.3-fp8), [code](https://github.com/Lightricks/LTX-2) — [LTX-2 Community License](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2) — the video engine behind Reframe, Remove and the Smooth Cut bridges.
- **Gemma 3 12B IT (`gemma_3_12B_it_fp4_mixed`)** — Google; fp4 repackaging by Comfy Org — [google/gemma-3-12b-it](https://huggingface.co/google/gemma-3-12b-it), [Comfy-Org/ltx-2](https://huggingface.co/Comfy-Org/ltx-2) — [Gemma Terms of Use](https://ai.google.dev/gemma/terms) — LTX-2.3's text encoder.
- **LTX-2.3 IC-LoRA Outpaint** — oumoumad — [oumoumad/LTX-2.3-22b-IC-LoRA-Outpaint](https://huggingface.co/oumoumad/LTX-2.3-22b-IC-LoRA-Outpaint) — LTX-2 Community License — fills the new canvas in Reframe.
- **LTX-2.3 IC-LoRA In/Outpainting** — Lightricks — [Lightricks/LTX-2.3-22b-IC-LoRA-In-Outpainting](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-In-Outpainting) — LTX-2 Community License — repaints the masked object in Remove.
- **LTX-2.3 IC-LoRA Clean Plate** — Lightricks — [Lightricks/LTX-2.3-22b-IC-LoRA-Clean-Plate](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Clean-Plate) — LTX-2 Community License — stacked with In/Outpainting so removed people don't get drawn back in.
- **SAM 3.1 (`sam3.1_multiplex_fp16`)** — Meta; ComfyUI repackaging by Comfy Org — [facebook/sam3.1](https://huggingface.co/facebook/sam3.1), [Comfy-Org/sam3.1](https://huggingface.co/Comfy-Org/sam3.1) — SAM License (Meta) — detects and tracks the clicked object in Remove.
- **SeedVR2 3B / 7B / 7B sharp** — ByteDance Seed (Jianyi Wang et al.); int8 conversions by Comfy Org — [SeedVR2-3B](https://huggingface.co/ByteDance-Seed/SeedVR2-3B), [SeedVR2-7B](https://huggingface.co/ByteDance-Seed/SeedVR2-7B), [Comfy-Org/SeedVR2](https://huggingface.co/Comfy-Org/SeedVR2), [code](https://github.com/ByteDance-Seed/SeedVR) — Apache-2.0 — Upscale.
- **BiRefNet** — Peng Zheng, Dehong Gao, Deng-Ping Fan, Li Liu, Jorma Laaksonen, Wanli Ouyang, Nicu Sebe; repackaging by Comfy Org — [ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet), [Comfy-Org/BiRefNet](https://huggingface.co/Comfy-Org/BiRefNet) — MIT — Remove background.
- **Whisper large-v3-turbo** — OpenAI; ggml conversion by the whisper.cpp project — [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo), [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) — MIT — optional word timings in Smooth Cut.

### Papers

- **LTX-2: Efficient Joint Audio-Visual Foundation Model** — Yoav HaCohen et al. (Lightricks) — [arXiv:2601.03233](https://arxiv.org/abs/2601.03233)
- **SAM 3: Segment Anything with Concepts** — Nicolas Carion, Laura Gustafson et al. (Meta) — [arXiv:2511.16719](https://arxiv.org/abs/2511.16719)
- **SeedVR2: One-Step Video Restoration via Diffusion Adversarial Post-Training** — Jianyi Wang et al. — [arXiv:2506.05301](https://arxiv.org/abs/2506.05301)
- **Bilateral Reference for High-Resolution Dichotomous Image Segmentation** — Peng Zheng et al. (CAAI AIR 2024) — [arXiv:2401.03407](https://arxiv.org/abs/2401.03407)
- **Robust Speech Recognition via Large-Scale Weak Supervision** — Alec Radford et al. — [arXiv:2212.04356](https://arxiv.org/abs/2212.04356)
- **Gemma 3 Technical Report** — Gemma Team, Google — [arXiv:2503.19786](https://arxiv.org/abs/2503.19786)

### Software

- **ComfyUI** — comfyanonymous and Comfy Org — [Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI) — GPL-3.0 — runs every workflow on Comfy Cloud. Native SeedVR2 nodes added in [PR #14424](https://github.com/Comfy-Org/ComfyUI/pull/14424) by pollockjj.
- **@comfyorg/sdk** — Comfy Org — [comfy-typescript-sdk](https://github.com/Comfy-Org/comfy-typescript-sdk) — MIT — submits jobs and fetches results.
- **comfy-reshoot** — Comfy Org — [Comfy-Org/comfy-reshoot](https://github.com/Comfy-Org/comfy-reshoot) — MIT — the example app our structure is based on (notice in `THIRD_PARTY_NOTICES/`).
- **Comfy workflow templates** — Comfy Org — [Comfy-Org/workflow_templates](https://github.com/Comfy-Org/workflow_templates) — the LTX outpaint, LTX inpaint, SeedVR2 and SAM 3 templates we studied and rebuilt with native nodes.
- **ComfyUI-LTXVideo** — Lightricks — [Lightricks/ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo) — reference LTX workflows; the green-guide inpaint idea comes from its `LTXVInpaintPreprocess`.
- **whisper.cpp** — Georgi Gerganov and the ggml authors — [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) — MIT.
- **FFmpeg** — the FFmpeg developers — [ffmpeg.org](https://ffmpeg.org/) — LGPL-2.1+ — called as an external program, not bundled.

## Licences

This code is MIT (see `LICENSE`). Model licences are separate. LTX-2.3 and its IC-LoRAs are used under the [LTX-2 Community License](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2), including its use restrictions (Attachment A). SAM 3.1 is used under Meta's SAM License. Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms. No model weights are redistributed: Comfy Cloud runs them.
