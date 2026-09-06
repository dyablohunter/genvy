---
name: progress-feedback
description: Genvy's rule and improvement loop for progress feedback on slow AI work. Use when adding or touching ANY AI request (image, video, or text — API provider or local inference service), when a busy indicator/progress bar/loader is involved, when a forge feels like it hangs with no explanation, or when asked to make progress reporting more accurate or informative.
---

# Progress feedback

Every AI request in Genvy is slow enough (10–90s) that an unexplained wait feels
broken. The rule: **no AI request may run behind an indeterminate spinner.** The
user must always see (a) how far along it is and (b) what is happening right now.

## The contract

Every AI request — image, video, or text; API provider or local inference — must:

1. **Run behind `busy()` with a `timing` bucket.** The bar then fills to 90% over
   this bucket's learned average, creeps asymptotically toward 100%, and snaps
   full on completion (`HudShell.showBusy(label, expectedMs)`).
2. **Update its stage text at every step** via `HudShell.setBusyLabel()`, in the
   form `"<i>/<n> <WHAT IS WORKING> · <WHAT IT IS DOING>"` — name the model or
   service (`GPT-IMAGE-2`, `DEEPSEEK`, `RETRO DIFFUSION`, `LOCAL COMFYUI`), and
   say what it is producing in the user's terms. Free local steps get their own
   numbered stage; mark them so the user knows they cost nothing.
3. **Use a duration bucket keyed by what drives the duration** — operation plus
   shape (`anim:8`, `anchor:directional`, `tileset:image`), never an asset id, or
   the average never converges.

4. **Show per-unit progress when an operation has parts.** A job made of N
   frames, anchors or stages renders a chip row via `HudShell.setBusySteps()` —
   each chip is `pending` (dim), `active` (accent + blinking), `done` (green) or
   `failed` (red). Prefer N small requests over one opaque request when it lets
   the user watch parts land: the frame repair loop redraws one frame per call
   and repaints the sheet after each, so a 3-frame repair shows three chips
   completing instead of one 60-second silence.

Helpers: `client/src/hud/progress.ts` (`expectedDuration`, `recordDuration`,
`durationStats`), `HudShell.showBusy/setBusyLabel/setBusySteps/hideBusy/refreshSpend`,
and each scene's `busy(label, fn, timing)` wrapper. Only successful runs are
recorded — failures end early and would bias estimates low.

Refresh what the operation changed when it ends: the clip list, the spend
readout (`HudShell.refreshSpend()`), the strip and the preview. A finished job
that leaves stale pixels on screen reads as a failed job.

## Improvement loop

This is a standing invitation, not a finished feature. Whenever this skill loads,
consider whether the current estimate can be made more accurate or the reporting
more informative, and propose (or make) one concrete improvement. Do not stack
speculative work: pick the change that removes the most uncertainty for the user,
implement it behind the existing helpers, and keep the API the same.

Done so far: determinate bar paced by learned per-operation averages; stage text
naming the model/service; an API-layer safety net that guarantees a determinate
bar for every image request; per-unit step chips; spend + provider-reported
balance in the header.

Ideas worth weighing, roughly by value:

- **Server-driven progress.** The route knows things the client cannot: which
  attempt the retry loop is on, that a moderation retry fired, that the gate is
  running. Stream real stage events (SSE on `/api/ai/image`) instead of the
  client guessing stage boundaries. This is the single biggest accuracy win.
- **Per-provider, per-model buckets.** gpt-image-2 and Retro Diffusion have very
  different latencies (RD queues jobs and can run for minutes); so do local GPU
  tiers. Key buckets by provider and model, not just operation shape.
- **Retry-aware estimates.** A gated animation may run 1–3 attempts. Estimate
  attempt 1, then extend the bar when a retry starts rather than letting it sit
  at 99%. Tell the user a retry is happening and why (the gate's finding).
- **Variance, not just the mean.** Store a spread (or median + p90) per bucket
  and pace the bar so it reaches 90% at ~p50 and holds through p90, instead of
  overshooting on slow runs.
- **Cold-start seeding.** First run of any bucket has no data; seed defaults from
  published provider latencies rather than a flat guess.
- **Outlier rejection.** Discard samples from runs that hit a moderation retry or
  a network stall so one bad run does not poison the average.
- **Elapsed / remaining readout.** Show elapsed time and a remaining estimate
  once a bucket has enough samples to be trustworthy; hide it while unlearned.
- **Cancellation.** A long request the user no longer wants should be abortable
  from the indicator, with the partial spend reported honestly.
- **Cost preview.** Providers expose `costEstimate()`; showing "~$0.005" next to
  the stage makes the wait feel purposeful and ties into the header spend chips.
- **Stall detection.** If a stage exceeds ~2.5x its bucket average, say so
  ("PROVIDER SLOWER THAN USUAL") instead of silently creeping.
- **Debug surface.** `durationStats()` exists; a small dev view of learned
  buckets makes miscalibration visible instead of a mystery.

## Checklist when touching an AI call

- [ ] `timing` bucket passed, keyed by operation + shape
- [ ] Stage text set before each step, naming the model/service
- [ ] Local/free steps distinguished from paid ones
- [ ] Failures do not record a duration
- [ ] The bar reaches 100% and clears on both success and error
