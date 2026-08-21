---
name: screensaver-video
description: Generate seamlessly-looping 1920x480 screensaver/wallpaper videos for the open-quake touch panel using T.J.'s ComfyUI server (192.168.1.95:8188, RTX 3090). Use this whenever T.J. asks for a screensaver video, panel wallpaper, animated background, looping video, a video "like the DK-Suite wallpapers", or to animate a scene (aurora, matrix rain, city, landscape, etc.) for the panel — even if he doesn't say "screensaver" or "loop". Covers the full pipeline — Flux still → Wan 2.2 first-last-frame loop → verify → trim → deliver — with validated settings; do not improvise a different workflow when this applies.
---

# Looping screensaver videos for the open-quake panel

Produces mp4s for the panel's Screensaver app (see `docs/screensaver.md`: it plays mp4/webm/mov from a media folder, muted, each video through to the end). Because videos repeat, **the last frame must land back on the first frame** — everything below is built around that.

All settings here were validated 2026-08-20 against ComfyUI 0.31.0 on 192.168.1.95:8188 (RTX 3090 24GB, fp8 Wan 2.2 + Lightning LoRAs). Confirm the server is up with a quick GET `/system_stats` before promising anything; list models with GET `/models/<folder>` if in doubt.

## Pipeline overview

1. **Still first** — generate a 1920×480 start frame with Flux Schnell (~30s). Wan is image-to-video only; there is no t2v model on the box.
2. **Review the still** before spending GPU time — a bad still wastes a 10–25 min render.
3. **Loop render** — Wan 2.2 with `WanFirstLastFrameToVideo`, passing the **same image as `start_image` and `end_image`**. The model animates away from the frame and back to it. This is the whole looping trick.
4. **Verify** the last frame actually matches the first (see below) — never claim "seamless" unchecked.
5. **Trim the duplicate final frame** (last frame == first frame, so leaving it in causes a 1-frame stutter on repeat) and re-encode.
6. **Deliver**: save to `C:\Users\tschmitz\Videos\wallpapers-generated\` and send the file in chat (SendUserFile). Only copy into a screensaver media folder if T.J. asks.

## Driver

`scripts/comfy.py` (stdlib-only) submits API-format graphs and moves files:

```
python scripts/comfy.py run <workflow.json>              # submit + poll until complete
python scripts/comfy.py upload still.png name.png        # → ComfyUI input folder
python scripts/comfy.py download <fname> <sub> output <dest>   # video outputs use sub="video"
```

## Workflow templates

- `scripts/wf_still_template.json` — Flux Schnell t2i. Edit the prompt (node 2) and seed (node 5). Flux settings that work: 4 steps, cfg 1.0, euler/simple, `EmptySD3LatentImage` 1920×480. The fp8 checkpoint is all-in-one (model+clip+vae via `CheckpointLoaderSimple`).
- `scripts/wf_loop_template.json` — the loop render. Edit: motion prompt (8), negative (9), input image name (11), `length` (12), seed (13+14, keep identical), filename_prefix (17).

Sampler settings in the loop template are load-bearing — two-stage `KSamplerAdvanced` (high-noise model steps 0→2, low-noise 2→end, 4 steps total, cfg 1.0, euler/simple, `ModelSamplingSD3` shift 5.0, Lightning LoRAs at 1.0). Don't tweak these without reason; they're the Wan 2.2 Lightning recipe and they work.

## Frame math (16 fps output)

`length = seconds × 16 + 1` and must be ≡1 mod 4: **81 = 5s, 121 = 7.5s, 161 = 10s**. After trimming the duplicate last frame you get exactly N-1 frames = whole seconds.

- 1920×480 has the same pixel budget as 720p — Wan's sweet spot; fits the 3090 with fp8+Lightning.
- Validated render times: 81f ≈ 7–15 min, 121f ≈ 13–15 min, 161f ≈ 20 min (validated, no VRAM issues).
- **Length policy (T.J., 2026-08-20): 5s is the minimum, not the target — build amazing videos, up to 30s when the content earns it.** Longer runtime is the tool for making big motions (orbits, fly-throughs) loop gracefully instead of feeling rushed. Texture-only motion (rain, neon flicker) can stay short; camera moves and slow ambient scenes should go long. Beyond ~161f per render, chain segments (below) rather than pushing a single render.

## Prompting the motion

- Describe **what moves and what stays still**, and say **"static camera"** — camera drift ruins loops.
- Anchor the subject: "car parked completely still", "landscape stays still", or Wan will move it.
- Negative prompt: `blurry, jerky motion, camera shake, zoom, pan, low quality, watermark, text overlay` (+ scene-specific, e.g. "car moving").
- Matching a reference video: probe it (`ffprobe`) and pull frames (`ffmpeg -vf "select='eq(n\,0)+eq(n\,90)'"`), look at them, and write the still prompt from what you see. Reference wallpapers on the panel are 1920×480 60fps ~5s.
- **Camera moves need forceful language.** Wan strongly prefers to anchor the scene: "the camera flies forward down the street" produced a static camera with only subject motion. What works: name the shot type ("FPV drone footage", "first-person view", "strong forward dolly"), describe the parallax ("buildings rushing toward the camera and sweeping past out of the frame edges", "road streaming underneath"), and put "static camera, stationary, frozen, no camera movement" in the negative. Orbits respond well to "the camera orbits around X, circling to reveal the rear" — that worked first try.

## Verify the loop, then trim

Extract first and last frames and compare — both numerically and by eye:

```bash
ffmpeg -y -v error -i raw.mp4 -vf "select='eq(n\,0)+eq(n\,<N-1>)'" -vsync 0 f_%d.png
# RMSE via PIL: observed 8 (neon/rain scenes) to ~20 (soft clouds) on good loops.
# <25 AND visual composition match = pass. Composition shifted = fail → new seed or prompt fix.
```

Trim the duplicate last frame and finalize (keep `lt(n,N-1)`):

```bash
ffmpeg -y -v error -i raw.mp4 -vf "select='lt(n\,120)',setpts=N/16/TB" -r 16 \
  -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart Name_loop.mp4
```

Output is 16 fps (Wan 2.2 14B native). If T.J. wants it smoother, offer ffmpeg `minterpolate` to 60fps as a post-step — don't do it unasked.

## Big camera moves: multi-segment loops

A one-shot FLF render can only loop motion that stays near the start view. Asking it for a **360° orbit or a long fly-through in one go fails** — at the midpoint the model has to invent unseen geometry and it morphs (observed: doubled wheels, mangled car front). Chain segments instead:

1. **Segment 1** — plain `WanImageToVideo` (no end pin) from the start still, prompting the motion outward ("camera orbits toward the rear of the car"). The model moves freely and convincingly when it doesn't have to return.
2. **Extract segment 1's final frame** (ffmpeg), upload it, and check it's clean before continuing.
3. **Segment 2** — `WanFirstLastFrameToVideo` with `start_image` = segment 1's last frame, `end_image` = the original still, prompting the motion to continue home. FLF interpolating between two *real* frames is exactly what it's good at.
4. **Concatenate**: segment1 frames `[0..N-1]` + segment2 frames `[1..M-2]` (drop seg2's first frame = seam duplicate, and its last frame = loop duplicate). Use the same seed style/prompt phrasing in both segments so speed feels continuous across the seam.

Two 121f segments ≈ 15s total. For even longer arcs, insert more unpinned middle segments before the FLF closer — but each unpinned segment accumulates drift, so verify each segment's end frame before building on it.

## Character motion (a walking animal/person) that loops

An animated character (dog walking, person strolling) loops with the FLF pin *only if the travel is contained*. A character that crosses the whole frame and must return to the exact start frame makes Wan render the character at **both** ends near the loop point — ghost/duplicate bodies (seen with a corgi walking the full storefront: clean going out, duplicated coming back). Keep the motion local: "takes a few steps left, sniffs, turns and walks back to where it started, staying close to the shopfront" loops cleanly; "walks across the scene and back" ghosts. Put `two dogs, multiple dogs, duplicate, ghost, second <subject>` in the negative. Illustrated/anime styles tolerate character motion better than photoreal. Always check the mid-and-late frames (30/60/90%) for a single well-formed body, not just the endpoints — the duplication shows up around 75%, which endpoint RMSE misses. If a contained walk still ghosts, fall back to ambient life (sit/sniff/tail-wag while other elements move) — lower morph risk, still reads as alive.

## Batch runs (multiple videos)

ComfyUI queues prompts and runs them serially — POST all jobs at once (capture each `prompt_id`), then watch with one Monitor task polling `/history/<id>` every ~20s, emitting `<name> DONE` / `<name> ERROR` per job. Process each video (download → verify → trim → deliver) as its notification arrives. Don't foreground-wait on renders; a single Bash call will time out before a render finishes.

## Alternative: crop existing footage to panel size

When you have real source video (a 4K wallpaper clip, stock footage), **cropping it to 1920×480 beats AI generation** — especially for anything with rigid 3D structure the i2v model mangles (a car walkaround is the clear case: real footage has true geometry and never morphs). Always prefer this when a good source exists.

Geometry: the panel is 4:1, most source is 16:9. Going to 1920×480 means **cropping off top and bottom** (a horizontal band), never the sides — 4:1 is wider than 16:9, so horizontal fill is never needed. The max-vertical-content crop at full width is `crop=3840:960:0:<y>` then `scale=1920:480`; `y` is the only free parameter and it sets what's kept vertically. A tall subject (a front-on car ≈ 950px of the 960 band) leaves almost no headroom — you can center it *or* give it sky, not both; pick the offset that reads best.

- Find the offset by subject: sample frames across the whole clip (subjects move), try a few `y` values, and look — don't guess. For the DK-Suite car platform clip, `y=820` centered the car across all rotation angles; `y=600` sat it low, `y=1020` clipped the roof.
- The blurred-side-fill trick (fit whole frame, blur the pillars) exists but wastes ~two-thirds of a 4:1 strip on blur — only worth it if losing top/bottom content is unacceptable.
- Encode `-crf 21 -preset slow` to stay visually clean and under the 30 MB delivery limit for a ~40s clip; strip audio (`-an`). Real footage rarely loops — that's fine, the panel plays through and moves on; only force a loop if asked.

## Gotchas

- In Bash-tool loops on Windows, use **forward slashes** for absolute paths (`"C:/Program Files/..."`); backslash + `$var` in double quotes mangles the path.
- ffmpeg select-filter commas need escaping: `select='eq(n\,0)'`.
- `SaveVideo` writes to output subfolder `video/` — download with `sub="video"`.
- Node schemas: GET `/object_info/<NodeName>` when anything mismatches — verify, don't guess.
- One render at a time on the GPU; a queued job's poll just takes longer to start. Check `/queue` if unsure whether something is already running. Remove a not-yet-started job with POST `/queue` `{"delete": ["<prompt_id>"]}`.
- Don't assume a reference wallpaper loops cleanly — check its first vs last frame (the DK-Suite car.mp4 jumps hard at the loop point, RMSE 75). We can beat the references, not just match them.
- Multi-frame-check big motions: for orbits/fly-throughs, extract frames at 25/50/75% and confirm the motion actually happened and nothing morphed — endpoint RMSE alone passes broken videos.
