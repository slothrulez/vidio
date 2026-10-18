# Real AI footage: Wan + FFmpeg

## Model, license and hardware

**Wan2.2 TI2V-5B** supports both image-to-video and text-to-video. Its
[official model card](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B) and
[official Apache 2.0 license](https://github.com/Wan-Video/Wan2.2/blob/main/LICENSE.txt)
permit commercial use. Apache conditions include preserving license/notices and
identifying modifications when redistributing; there is no trademark license.
Users still need rights to inputs and must review outputs. This repository does
not redistribute model weights.

The official offloaded TI2V recipe needs at least **24 GB NVIDIA VRAM**. Integrated
graphics is not a practical local inference target. Vidio's CPU still runs FFmpeg
composition, but not the diffusion model.

The integrated free test backend is the community-owned
[naxyiudu228/wan22-ti2v-5b Space](https://huggingface.co/spaces/naxyiudu228/wan22-ti2v-5b),
using [FastWan2.2-TI2V-5B-FullAttn-Diffusers](https://huggingface.co/FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers).
That derivative's publisher also declares Apache 2.0. It is a distilled,
four-step implementation, **not an official Wan-hosted inference service**. The
adapter pins the reviewed Space revision `566d80f899a628836941d69d8eb62ae1141142c8`
and rejects submissions if its deployed revision changes. Operators must then
review the new source, model/license and API before updating the pin.

## Free GPU availability and privacy

[Hugging Face's ZeroGPU documentation](https://huggingface.co/docs/hub/spaces-zerogpu)
documents daily quotas (2 GPU-minutes anonymous, 5 for a free account). Quotas,
capacity, queues and Space uptime may change. A running Space does not guarantee
an allocation. This is an experimental/free testing backend, **not a production
availability promise**.

The adapter is deliberately anonymous: no HF token, cookies, paid inference
endpoint, credit purchase or paid fallback. Existing HF tokens in the environment
are never read or forwarded. It requires running `zero-*` hardware. A quota or
allocation failure fails the job; it never buys more GPU time.

Enabling Wan sends the selected product image and visual prompts to that third
party. Only use images you are authorized to share. Owner-bound Vidio media URLs,
storage credentials and authentication cookies are never sent: validated image
bytes are multipart-uploaded instead. Do not assume the public Space provides
private or durable storage. Generated media is promptly copied into Vidio's owned
asset store; temporary Space outputs are not final assets.

## Enable and use

Use the existing managed PostgreSQL/web/worker setup in README.md, with FFmpeg and
FFprobe available. Add `VIDIO_WAN_ENABLED=true` to the private local/server
environment **for both web and worker**, then restart those processes. It is false
by default, works in managed demo or production mode, and needs no HF credential.
Do not enable `VIDIO_PAID_GENERATION_ENABLED` to use Wan. No deployment is required
for local testing.

1. Create a project; upload/select a PNG/JPEG for image-to-video. To use text-to-video,
   use a project without an image.
2. Review/save the narration/caption text and **visual direction** for each scene.
   The visual direction is the inference prompt. Demo recognition/script drafts
   remain fixtures; production recognition/TTS are not implemented by this change.
3. Select **Wan AI footage** and approve sharing/generation. The backend requests a
   short ~2-second, four-step clip per scene, at 576×320 landscape, 320×576 portrait,
   or 448×448 square. These are economical tests, not a quality guarantee.
4. Poll the durable job. Generated clips are downloaded, signature-checked,
   FFprobe-checked, fully decoded, then normalized to H.264/yuv420p, 24 fps, AAC
   stereo and the project ratio. Missing audio becomes silence, **not narration**.
   Duration/frame/resolution/byte/time limits apply before asset registration.
5. Select completed scenes and compose. FFmpeg retains scene audio, optionally
   mixes synthetic instrumental music, muxes English captions, and supports cuts
   or 0.2-second fades through black at scene boundaries. Fades do not overlap or
   shorten the caption timeline. Download the owned final MP4.

The web and embedded studios expose the source and stored provenance per scene.
**Static-image fallback** must be selected explicitly in those controls and
approved; its clips are visibly marked `STATIC FALLBACK - NOT AI`. Ark remains a
separate paid production option behind its existing credentials, opt-in and daily
budget. It is never selected after a Wan failure.

For API/MCP clients, pass `generationMode: "wan" | "static" | "ark"` on generation
and regeneration. Pass the same mode to the app-only `grant_cost_consent` call;
approval keys bind that choice, so static approval cannot authorize external AI
sharing or paid Ark generation. For composition use, for example:

```json
{"subtitles":true,"backgroundMusic":"soft","transition":"fade"}
```

For older clients only, an omitted mode retains the existing demo→static or
production→Ark behavior; it is not a failure-driven fallback. New clients should
always name the mode. Existing unconsumed generation approvals issued before this
change must be approved again because their keys lack the mode binding.

## Failure, recovery and retry

Jobs retain queued/running/partially-completed/completed/failed lifecycle states.
Segments retain queued/submitting/submitted/running/completed/failed states. The
Gradio stream only reports generating when the provider emits that event; Vidio
does not invent GPU progress while a task is submitted/queued.

The event ID is checkpointed immediately after submission. Worker recovery polls
the same event rather than submitting another inference. Completed scenes and
their provenance survive recovery. Lost/ambiguous submission responses fail closed
as `SUBMISSION_UNKNOWN`; new AI submissions for those scenes require operator
reconciliation. Media-validation failures never complete a scene. Free quotas and
provider error messages are surfaced in bounded/redacted form; the Space sometimes
returns an error without details, which is reported honestly.

Use **Retry saved job** for a resumable status/storage failure. For a confirmed
terminal provider failure, **Retry AI generation** requires a fresh approval;
already completed scenes remain available, and regenerating just a failed scene
avoids replacing other scenes. A new full generation requests every scripted scene.
Alternatively select and approve **Static-image fallback**. No failure automatically
calls another generation provider or the local static renderer.

## Verified on 2026-10-18

- Anonymous image-to-video: uploaded a synthetic cup image; received a real generated
  MP4, fully decoded it and normalized it. Duration: **2.041667 s**.
- Anonymous text-to-video: a genuine `runJob` worker execution with a durable database
  task ID completed, validated and stored its generated clip as an owned asset.
- Composed both real clips in a durable job with captions, synthetic music and fades;
  the final MP4 completed validation. Visual review found changing perspective,
  lighting/shadows and camera motion, not the static-image fallback. Product fidelity
  and marketing quality still need human review.
- Automated tests use mocks and synthetic FFmpeg fixtures only: provider protocol,
  image/text inputs, credential exclusion, task recovery, quota failure, no automatic
  fallback, explicit fallback, consent-mode binding, normalization and composition.
- No paid provider calls, cloud charges or deployment. Anonymous free capacity worked
  for these two requests; it is not guaranteed for the next request. GPU inference
  still requires the external Space. Browser/ChatGPT-host acceptance was not performed.
