# Portfolio Section — Rebuild Plan

**Status:** Phases 1–5 implemented. See §12 for what shipped and what is still open.
**Baseline commit:** `88f330a` (clean tree)
**Owner decisions captured:** 2026-07-21

> **§2.2's asset inventory is historical.** It measures the four pre-recut clips,
> which no longer exist. Current inventory is in §12.2.

> **How to use this doc.** It is written for handoff to an agent or developer with no
> prior context on this conversation. Sections 1–3 are findings and decisions — read
> them before touching code, and do not re-litigate the decisions in §3 without the
> owner. Sections 4–9 are the phased work. §10 is a landmine list; read it, several
> of those will silently break things.
>
> **Line numbers are as of `88f330a` and will drift once Phase 1 lands.** Every
> reference below also names the symbol or selector — grep for that, not the line.

---

## 1. Goals

From the site owner, verbatim intent:

1. Display **really high quality video that doesn't feel rushed.** Current playback
   is far too fast.
2. **Hybrid playback:** clip autoplays at 1× by default; the visitor can take over
   and scrub on demand, and playback resumes when they stop.
3. **Duration-agnostic logic.** The owner is recutting the clips but wants the
   implementation to work correctly for a clip of *any* length, not tuned to
   specific runtimes.
4. **The video keeps playing** once the descriptor/story text appears.
5. **Must work well on mobile.** (It currently does not work on mobile *at all* —
   see §2.4.)
6. **Full analytics** on the section — per-project views, watch-through, live-site
   click attribution, video health — **without introducing lag spikes.**

Non-goal: GIF conversion. Evaluated and rejected — see §3.1.

---

## 2. Current state

### 2.1 File map

| Concern | Location |
|---|---|
| Portfolio markup (JSX) | [src/main.jsx:865-937](src/main.jsx#L865-L937) — `<section id="portfolio">` |
| Project data (titles, copy, stack, urls) | [src/main.jsx:70-75](src/main.jsx#L70-L75) — `projects` array |
| Scrub/pacing constants | [src/main.jsx:100-104](src/main.jsx#L100-L104) |
| Cache-buster hack | [src/main.jsx:62-68](src/main.jsx#L62-L68) — `PORTFOLIO_VIDEO_VERSION`, `clip()` |
| Scrub state (refs) | [src/main.jsx:437-447](src/main.jsx#L437-L447) |
| Visual writer | [src/main.jsx:544-600](src/main.jsx#L544-L600) — `applyPortfolioVisuals`, `queuePortfolioVisuals` |
| Eased seek loop | [src/main.jsx:601-646](src/main.jsx#L601-L646) — `scrubPortfolioVideoTo`, `updatePortfolioScrubTarget` |
| Metadata handler | [src/main.jsx:647-657](src/main.jsx#L647-L657) — `handlePortfolioMetadata` |
| Exit-gesture machinery | [src/main.jsx:658-686](src/main.jsx#L658-L686) — `waitForFreshPortfolioGesture`, `resetPortfolioDemo` |
| **Wheel hijack (the core problem)** | [src/main.jsx:687-735](src/main.jsx#L687-L735) — `handlePortfolioInteractionWheel` |
| Rail autoplay gating (good, reuse) | [src/main.jsx:740-772](src/main.jsx#L740-L772) |
| Styles | [src/portfolio.css](src/portfolio.css) — 266 lines |
| Video assets (source of truth) | [public/portfolio/](public/portfolio/) — copied verbatim to `dist/portfolio/` |
| Analytics engine | [src/lib/analytics.js](src/lib/analytics.js) |
| Analytics field/type whitelist | [src/lib/analytics.js:31-34](src/lib/analytics.js#L31-L34) **and** [firestore.rules:155-177](firestore.rules#L155-L177) |
| Hosting cache headers | [firebase.json:19-41](firebase.json#L19-L41) |

### 2.2 Measured asset inventory

Measured with `ffprobe` on `88f330a`. **All four have `faststart`** (`ftyp moov free mdat`) —
streaming start is *not* a problem, do not "fix" it.

| File | Duration | Resolution | Video bitrate | Size | Keyframe interval | Audio |
|---|---|---|---|---|---|---|
| `BodegaProject.mp4` | 25.30s | 1280×720 @30 | 7.83 Mbps | 25.4 MB | **5.2s** ❌ | AAC 192 kbps (waste) |
| `nexusverium.mp4` | 22.50s | 1336×720 @24 | 7.28 Mbps | 20.5 MB | **6.25s** ❌ | AAC 2 kbps (waste) |
| `cliftonaveanimalhospital.mp4` | 46.93s | 1920×1084 @30 | 2.24 Mbps | 13.2 MB | 0.5s ✅ | none |
| `stonebellisimo.mp4` | 83.97s | 1920×1084 @30 | 2.98 Mbps | 31.3 MB | 0.5s ✅ | none |

**Total page video payload: ~90 MB.**

Notes:
- Two clips were clearly already re-encoded for scrubbing (0.5s GOP); two were not.
  Every seek on Bodega/Nexus forces a decode from a keyframe up to 6.25s away — this
  is the visible stutter.
- Bitrates are inverted: the 720p clips carry ~3× the bitrate of the 1080p clips.
- `1084` is a non-standard height from a screen-recording crop.
- Original source material at repo root: `Clifton Ave Animal Hospital.mov` (229 MB),
  `New Background Concept.mov` (5.5 MB). Both gitignored.

### 2.3 Why it feels rushed — exact math

The demo video **never plays.** [`scrubPortfolioVideoTo`](src/main.jsx#L601) pauses it
permanently and drives `currentTime` from wheel delta.

`handlePortfolioInteractionWheel` advances progress by `deltaY / PORTFOLIO_SCRUB_DISTANCE`
(2200), and `updatePortfolioScrubTarget` maps progress `0.12 → 0.86` onto time `0 → duration`.
**Effective scrub window is therefore `(0.86 − 0.12) × 2200 = 1628px` of wheel delta for
the entire clip**, regardless of its length:

| Project | Duration | Video-ms per pixel | One trackpad flick (~400px) = |
|---|---|---|---|
| Stone Bellisimo | 84.0s | 51.6 ms | **20.6 seconds of footage** |
| Clifton Ave | 46.9s | 28.8 ms | 11.5 s |
| Bodega | 25.3s | 15.5 ms | 6.2 s |
| Nexus Verium | 22.5s | 13.8 ms | 5.5 s |

Two independent defects: pacing is far too fast, **and** it is inconsistent between
projects by 3.7×. Both follow from mapping a variable duration onto a fixed pixel span.

### 2.4 Mobile is completely dead

`grep -n "touchmove\|touchstart\|pointerdown\|coarse\|ontouch" src/main.jsx src/portfolio.css`
returns **nothing**. The only input path is a `wheel` listener registered at
[src/main.jsx:733](src/main.jsx#L733). Touch scrolling emits no `wheel` events, so on
every phone and tablet:

- the demo never expands (`--portfolio-demo-opacity` stays 0)
- `portfolioPhase.complete` is unreachable, so the back button at
  [src/main.jsx:907](src/main.jsx#L907) never appears
- the visitor sees the rail and nothing else

The footer even instructs `↓ Scrub demo` ([src/main.jsx:934](src/main.jsx#L934)) on a
device where that is impossible.

### 2.5 Other defects

- **No `poster` on any `<video>`.** With `preload="metadata"` the section paints black
  rectangles until frames arrive. [src/main.jsx:892](src/main.jsx#L892), [:904](src/main.jsx#L904).
- **Story panel lead is hardcoded** to 3.5s from the end
  ([`PORTFOLIO_DESCRIPTION_LEAD`](src/main.jsx#L103), used at [:554-555](src/main.jsx#L554-L555)).
  Correct-ish for a 25s clip, wrong for a 6s clip (would fire at 42% in).
- **No responsive variants.** Phones download the same 1920px file as desktops.
- **`prefers-reduced-motion` hides the demo entirely**
  ([portfolio.css:264](src/portfolio.css#L264) — `.portfolio-demo { display: none; }`),
  so those visitors get no demo at all rather than a static one.
- **Cache-buster hack.** `?v=2` query param exists because `firebase.json` applies a
  24h TTL to `**/*.mp4` by path alone; a missing clip gets the SPA HTML shell cached
  under the video URL by Cloudflare for a day. See the comment at
  [src/main.jsx:62-66](src/main.jsx#L62-L66) — this is real, it has bitten before.

---

## 3. Decisions (settled — do not re-litigate)

### 3.1 GIF is rejected

Evaluated at owner request. Rejected on four independent grounds:

1. **It breaks the feature.** A GIF has no `currentTime`. Scrubbing becomes impossible,
   which removes the interaction the section is built around.
2. **Quality.** 256-color palette; these are screen recordings full of UI gradients →
   visible banding. This directly contradicts goal #1.
3. **Performance.** No hardware decode. GIF decoding runs on the main thread and would
   jank worse than the current video path.
4. **Size.** 5–10× the bytes. A 15s 1080p GIF is ~40–80 MB versus ~9 MB of H.264.

The instinct behind the request — "a clean loop with no player chrome" — is already
satisfied by a `muted loop playsInline` MP4, which is what the rail cards do at
[src/main.jsx:892](src/main.jsx#L892). Keep video.

### 3.2 Keep the videos on Firebase Hosting

They are *already* served by Firebase Hosting (`public/portfolio/` → `dist/portfolio/`).
Moving to Cloud Storage would add CORS configuration, a second origin, and per-GB egress
billing, for **zero** latency gain — both are Google's Fastly-backed CDN. The real
problem is the cache-header configuration, not the host. See Phase 4.

### 3.3 Hybrid playback model (owner's pick)

Default is **1× autoplay**; scrub is an opt-in override that hands control back after
an idle timeout. This is the only model that satisfies goal #1 — pacing is fixed by the
edit, not by how hard someone flicks a trackpad.

### 3.4 Remove the wheel hijack

Every symptom in §2.3, §2.4 and the `PORTFOLIO_EXIT_GESTURE_PAUSE` complexity traces to
`event.preventDefault()` in the wheel handler ([src/main.jsx:722](src/main.jsx#L722)).
**The page must scroll normally, always.** Expansion becomes a discrete click/tap on a
rail card — same visual animation, driven by a CSS transition on a class rather than a
scroll-linked custom property.

Consequence: the section keeps its current `100svh` height. No sticky/tall-section
rewrite is needed, because scroll no longer drives the timeline.

---

## 4. Phase 1 — Playback engine

**Goal:** 1× autoplay + scrub-on-demand, duration-agnostic, no scroll hijack.
**Touches:** `src/main.jsx`, `src/portfolio.css`.

### 4.1 Delete

- `handlePortfolioInteractionWheel` and its listener registration
  ([src/main.jsx:687-735](src/main.jsx#L687-L735))
- `waitForFreshPortfolioGesture`, `PORTFOLIO_EXIT_GESTURE_PAUSE`
  ([src/main.jsx:658-665](src/main.jsx#L658-L665), [:104](src/main.jsx#L104))
- `PORTFOLIO_SCRUB_DISTANCE`, `PORTFOLIO_VIDEO_START`, `PORTFOLIO_VIDEO_END`
  ([src/main.jsx:100-102](src/main.jsx#L100-L102))
- `portfolioProgressRef` and every `progress`-derived value in `applyPortfolioVisuals`

### 4.2 Keep and reuse

- **`scrubPortfolioVideoTo`** ([src/main.jsx:601-639](src/main.jsx#L601-L639)) — the
  eased seek loop with the `video.seeking` guard is correct and hard-won. Keep it as
  the single write path for all seeks. The comment at [:612-615](src/main.jsx#L612-L615)
  explains why the guard matters; preserve it.
- **Rail autoplay gating** ([src/main.jsx:740-772](src/main.jsx#L740-L772)) — the
  IntersectionObserver + `document.hidden` + `video.muted = true` assertion is well
  built. Extend it to gate the demo video rather than replacing it.
- **The no-re-render discipline** ([src/main.jsx:429-433](src/main.jsx#L429-L433)) —
  continuous values live in refs and are written as CSS custom properties; only
  threshold crossings touch React state. **This is a hard requirement, not a
  preference.** It is also how goal #6 (no lag spikes) is met.

### 4.3 Build

**Expansion.** `activeProject` selection + a new `expanded` boolean in
`portfolioPhase`. Clicking/tapping a rail card sets it. Drive `--portfolio-expand`
from a class-based CSS transition instead of a scroll value.

**1× playback.** Once expanded: `video.play()`, `loop`, `muted`, `playsInline`.
Gate on visibility/`document.hidden` via the existing observer. Upgrade `preload` to
`auto` on approach (logic already exists at [src/main.jsx:762](src/main.jsx#L762)).

**Drag scrubber.** A progress bar on the expanded demo using **pointer events**
(`pointerdown`/`pointermove`/`pointerup` + `setPointerCapture`). One code path serves
mouse and touch — **this is what makes mobile work; do not write a separate touch
branch.** Writes through `scrubPortfolioVideoTo`.

**Wheel-over-video scrub (desktop only).** Non-passive `wheel` listener scoped to the
video element. On wheel: pause, seek by a **fraction of duration per pixel** (never an
absolute time), and start a 400ms idle timer; on expiry, `play()` from the current
position. Constraints:
- Must **not** `preventDefault()` when the seek would run past either end, so the page
  never traps the visitor. This is the bug that made the old version feel broken.
- Duration-agnostic by construction: a 6s and a 60s clip feel identical.

**Story panel — dynamic and latched.** Replace the fixed 3.5s lead at
[src/main.jsx:554-555](src/main.jsx#L554-L555) with:

```js
const storyStart = Math.max(duration - 3.5, duration * 0.6);
```

Never earlier than 60% in, never later than 3.5s from the end — correct at any length.

> ⚠️ **The panel must be latched.** Per goal #4 the video keeps playing, and it loops —
> so `currentTime` resets to 0 and the naive `smoothStep` would snap the panel off on
> every loop. Latch it: once shown for a given `activeProject`, keep it visible until
> the project changes. Reset the latch in the `useEffect` on `[activeProject]`
> ([src/main.jsx:481-496](src/main.jsx#L481-L496)).

### 4.4 Acceptance criteria

- [ ] Page scrolls normally with the cursor anywhere over the section, at all times
- [ ] Expanded clip plays at 1×; the visual pace matches the source file
- [ ] Scrubbing then stopping resumes 1× playback from the scrubbed position
- [ ] Behaviour is identical for a 6s clip and an 84s clip (test by swapping `src`)
- [ ] Story panel appears near the end and **stays** through subsequent loops
- [ ] No React re-render during playback or scrub (verify with React DevTools Profiler)

---

## 5. Phase 2 — Mobile

**Depends on:** Phase 1 (the pointer-event scrubber does most of this).

- Tap a rail card → expand. The rail's horizontal scroll-snap
  ([portfolio.css:57-78](src/portfolio.css#L57-L78)) already works on touch; keep it.
- Make the back/close affordance reachable — it is currently gated behind
  `portfolioPhase.complete` ([src/main.jsx:907](src/main.jsx#L907)), which is
  unreachable on touch. Gate on `expanded` instead.
- Serve a 720p variant under `max-width: 760px` (see Phase 3 encode matrix).
- Update the gesture hint at [src/main.jsx:934](src/main.jsx#L934) — `↓ Scrub demo` is
  wrong on every device after Phase 1.
- Replace the `prefers-reduced-motion` blackout at
  [portfolio.css:258-266](src/portfolio.css#L258-L266): show the poster frame plus an
  explicit play button rather than `display: none`.

**Acceptance:** full select → expand → play → scrub → dismiss cycle works on a real
iOS Safari and a real Android Chrome device. Not just a desktop emulator — iOS
autoplay policy and `playsInline` behaviour differ from emulation.

---

## 6. Phase 3 — Re-encode

**Blocked on:** owner recuts. Everything else can proceed without this.

Recut guidance given to owner: target ~15s; **the clips loop**, so a cut that ends near
where it starts loops invisibly, while one ending on a hard cut will visibly snap.

### 6.1 Recipe (duration-agnostic, apply to whatever is delivered)

```bash
ffmpeg -i IN.mov \
  -c:v libx264 -profile:v high -crf 20 -maxrate 6M -bufsize 12M \
  -vf scale=1920:-2 \
  -g 15 -keyint_min 15 -sc_threshold 0 \
  -an \
  -movflags +faststart \
  OUT.mp4
```

720p mobile variant: `-vf scale=1280:-2 -maxrate 3M -bufsize 6M`.

Poster frame:
```bash
ffmpeg -i OUT.mp4 -vf "select=eq(n\,0)" -frames:v 1 -c:v libwebp -quality 82 OUT-poster.webp
```

### 6.2 Why each flag

| Flag | Fixes |
|---|---|
| `-g 15 -keyint_min 15 -sc_threshold 0` | 0.5s GOP at 30fps. Bodega's 5.2s and Nexus's 6.25s GOPs are the stutter. Matches the two clips that already scrub cleanly. **Scrub-critical.** |
| `-crf 20 -maxrate 6M` | Bodega is 7.83 Mbps at *720p*; Stone is 2.98 at 1080p. Normalises quality, cuts bytes where wasted, adds them where needed. |
| `-an` | Bodega carries 192 kbps AAC (~600 KB) and Nexus 2 kbps. Everything is `muted`. Pure waste. |
| `scale=1920:-2` | Normalises the non-standard 1084px crop height; `-2` keeps it even for yuv420p. |
| `-movflags +faststart` | Already correct on all four — preserve it, don't regress it. |

### 6.3 Expected outcome

At ~15s recuts: **~9 MB per clip, ~36 MB total** versus 90 MB today — while looking
*better*, because bitrate is reallocated rather than merely reduced.

### 6.4 Verification commands

```bash
# Keyframe interval — must be ~0.5s
ffprobe -v error -select_streams v -skip_frame nokey \
  -show_entries frame=pts_time -of csv=p=0 FILE.mp4 | head -8

# Atom order — must be ftyp ... moov ... mdat
ffprobe -v trace -i FILE.mp4 2>&1 | grep -m5 "type:'\(moov\|mdat\)'"

# Full spec sheet
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,bit_rate \
  -show_entries format=duration,size,bit_rate -of default=noprint_wrappers=1 FILE.mp4
```

---

## 7. Phase 4 — Asset pipeline & cache headers

**Goal:** retire the `?v=` hack permanently.

### 7.1 Move to content-hashed filenames

`public/` is copied verbatim by Vite (no hashing) — that is *why* the manual
`PORTFOLIO_VIDEO_VERSION` counter exists.

**There is already a working precedent in this repo:** team videos live in
[src/assets/team/](src/assets/team/) and are emitted hashed, e.g.
`dist/assets/nussein-iounakov-SpwrIpZj.mp4`. Do the same:

1. Move clips to `src/assets/portfolio/`
2. `import` them and reference the imported URL in the `projects` array
   ([src/main.jsx:70-75](src/main.jsx#L70-L75))
3. Delete `PORTFOLIO_VIDEO_VERSION` and `clip()`
   ([src/main.jsx:62-68](src/main.jsx#L62-L68))

### 7.2 Fix the header ambiguity

[firebase.json:30](firebase.json#L30) matches `**/*.@(png|jpg|jpeg|svg|webp|mp4|ico|woff2)`
with `max-age=86400`, and [firebase.json:36](firebase.json#L36) matches `/assets/**` with
`immutable`. **Both match a hashed clip under `/assets/`.** Rather than depend on
Firebase's rule-precedence behaviour, make it deterministic:

> **Remove `mp4` from the glob at [firebase.json:30](firebase.json#L30)** once clips are
> hashed. Hashed assets are covered by the `/assets/**` immutable rule; unhashed ones no
> longer exist.

### 7.3 Verify at the edge, not the origin

⚠️ `bitesites.org` is served through **Cloudflare**. A green `firebase deploy` can still
leave the apex domain serving stale content for up to 24h. After deploying:

```bash
curl -sI https://bitesites.org/assets/<hashed>.mp4 | grep -i 'cache-control\|cf-cache-status\|age'
```

Confirm `immutable` **and** the Cloudflare cache status. Checking the
`*.web.app` origin alone proves nothing.

---

## 8. Phase 5 — Analytics

**Hard constraint (goal #6): nothing in this section may call `setState` during
playback or scrub.** All counters live in refs; milestones ride the native
`timeupdate` event (~4/s) rather than rAF, so they cost nothing per frame.

### 8.1 Events

| Event | Trigger | Volume |
|---|---|---|
| `portfolio_project_view` | card becomes active; dwell ms recorded on leaving | 1 per selection |
| `portfolio_progress` | 25/50/75/100% per project, `Set`-guarded so each fires once | ≤4 per project |
| `outbound` *(extend existing)* | add source project to the existing call at [analytics.js:250](src/lib/analytics.js#L250) | unchanged |
| `portfolio_video_health` | `stalled`/`waiting` count + time-to-first-frame | 1 per project per session, hard-capped |

All flow through the existing `enqueue`/`flush` batching at
[analytics.js:75-129](src/lib/analytics.js#L75-L129) — no new network path.

### 8.2 ⚠️ Two whitelists must be updated together

This is the highest-risk item in the whole plan. See §10.1 before writing any code.

- **Event types:** [analytics.js:31-34](src/lib/analytics.js#L31-L34) (`EVENT_TYPES`)
  **and** [firestore.rules:162-163](firestore.rules#L162-L163) (`data.type in [...]`)
- **Field names:** [firestore.rules:157-161](firestore.rules#L157-L161) uses
  `keys().hasOnly([...])` — a strict whitelist. Prefer reusing existing fields
  (`label`, `section`, `value`, `href`, `interactive`) over adding new ones.

### 8.3 Acceptance

- [ ] Events visible in the admin dashboard ([src/admin/](src/admin/))
- [ ] Firestore rules updated **and deployed** (`firebase deploy --only firestore:rules`)
- [ ] No console warning `[analytics] events could not be recorded`
- [ ] Chrome Performance profile over a full play + scrub cycle shows no long task > 50ms

---

## 9. Suggested order

Phases 1, 2 and 5 are unblocked today. Phase 3 waits on the owner's recuts; Phase 4
should follow Phase 3 so files are only renamed once.

```
Phase 1 (engine) ──► Phase 2 (mobile) ──► Phase 5 (analytics)
                                              │
        owner recuts ──► Phase 3 (encode) ──► Phase 4 (pipeline/cache)
```

---

## 10. Landmines

### 10.1 A bad analytics event silently destroys all analytics

`flush()` at [analytics.js:108-129](src/lib/analytics.js#L108-L129) `splice`s events off
the queue **before** committing, then commits them as a single `writeBatch`. A Firestore
rules rejection fails the **entire batch**, the spliced events are already gone, and the
catch block warns **once per session** and swallows everything after.

**Adding an event type to `analytics.js` without also adding it to `firestore.rules`
will silently drop every event in every affected batch, site-wide.** Update both, deploy
the rules, and verify against the emulator (`firebase emulators:start`, config at
[firebase.json:43-48](firebase.json#L43-L48)) before deploying the client.

### 10.2 The story panel will flicker without a latch

Covered in §4.3. `loop` resets `currentTime` to 0; an unlatched `smoothStep` on
`videoTime` snaps the panel off on every loop.

### 10.3 Cloudflare, not Firebase, is the cache of record

See §7.3 and the comment at [src/main.jsx:62-66](src/main.jsx#L62-L66). A green deploy is
not proof. Verify at `bitesites.org`.

### 10.4 Don't "fix" faststart

All four files already have `moov` before `mdat`. An earlier analysis pass got this
wrong before verifying. Preserve `-movflags +faststart`; don't chase it as a defect.

### 10.5 `video.muted` must be asserted as a property

React assigns `muted` as a property, not an attribute, and autoplay policy only permits
`play()` on a muted element. The existing code asserts `video.muted = true` imperatively
at [src/main.jsx:752](src/main.jsx#L752) for exactly this reason. Any new playback path
must do the same or `play()` will reject on iOS.

### 10.6 Don't reintroduce React state on the hot path

[src/main.jsx:429-433](src/main.jsx#L429-L433) documents a prior regression where scrub
values lived in state and re-rendered the entire marketing page up to 20×/second. The
`setPortfolioPhase` bail-out at [:585-592](src/main.jsx#L585-L592) is deliberate —
returning the identical object makes React skip the render. Preserve that pattern.

### 10.7 `.portfolio-demo` has `pointer-events: none` by default

[portfolio.css:120](src/portfolio.css#L120), enabled only via
`.portfolio-demo-active` at [:124](src/portfolio.css#L124). A scrubber built inside it
will be inert until that class is applied.

---

## 11. Open items for the owner

- [x] Deliver recuts. Delivered 2026-07-21 as five 1880×1080 HEVC masters.
- [ ] Confirm whether the rail should keep looping preview clips on mobile, or show
      poster stills to save bandwidth on cellular.
- [ ] Confirm the StockRoom NJ stack pills (§12.3) — inferred from the shipped
      bundle, not from the source repo.

---

## 12. Implementation log — 2026-07-21

### 12.1 What landed

| Phase | State | Notes |
|---|---|---|
| 1 — Playback engine | done | Wheel hijack gone; 1× autoplay + scrub-on-demand, all pacing duration-relative. |
| 2 — Mobile | done | Pointer-event scrubber; reduced-motion blackout replaced (§12.4). Still needs a **real-device pass** on iOS Safari and Android Chrome. |
| 3 — Re-encode | done | Five recuts encoded; §12.2. |
| 4 — Asset pipeline | done | Clips imported from `src/assets/portfolio/`, Vite hashes them, `?v=` hack and `PORTFOLIO_VIDEO_VERSION` deleted, `mp4` removed from the `firebase.json` glob. |
| 5 — Analytics | done | Three event types, both whitelists, five new rules tests (§12.5). |

### 12.2 Current asset inventory

Encoded from the recuts with the §6.1 recipe. **All ten verified**: H.264, 0.5s
keyframe interval, `moov` before `mdat`, no audio track.

| Project | Duration | 1080p | 720p | Poster |
|---|---|---|---|---|
| Clifton Ave Animal Hospital | 16.03s | 7.0 MB | 3.4 MB | 83 KB |
| Stone Bellisimo | 23.60s | 9.0 MB | 4.4 MB | 70 KB |
| Nexus Verium | 24.27s | 15.0 MB | 7.0 MB | 197 KB |
| Rutgers Newark Bodega Project | 23.63s | 12.5 MB | 6.2 MB | 73 KB |
| StockRoom NJ | 18.07s | 11.1 MB | 5.5 MB | 87 KB |

**54.6 MB across five clips, down from 90 MB across four** — and only the opened
clip is ever fetched in full; the rail holds at `preload="metadata"`.

> **One deviation from §6.1:** no `scale=1920:-2` on the 1080p variants. The
> recuts are already 1880×1080, so the scale filter existed only to normalise the
> old 1084px crop height. Upscaling 1880→1920 would spend bytes and sharpness
> fixing a width that was never the defect. The 720p variants do scale.

### 12.3 Content changes

- **StockRoom NJ added** as project 05 — Wallington, NJ collectibles shop.
  Stack pills (`React`, `Vite`, `Firebase`, `Cloud Firestore`) were **inferred
  from the deployed bundle**, not from source: `onSnapshot` and the Firestore
  SDK are present in the vendor chunk, and the CSS carries no Tailwind markers.
  Worth an owner confirmation.
- **Rutgers Newark Bodega Project repointed** to
  `https://jjimenez723.github.io/the-bodega-project-demo/`. This is a *different
  application* from the old `Bodega-Project-2` link — a neighbour-to-neighbour
  produce-sharing platform, not the fast-vs-fresh mapping tool — so the blurb,
  the three bullets and the stack were rewritten to match what the link now
  opens. Leaving the old copy would have described a site that no longer exists.

### 12.4 Reduced motion

§5 asked for the `display: none` blackout to become a poster plus an explicit
play control, and that is what it now is. `openPortfolioProject` no longer bails
out, so the stage opens for everyone; under the preference it opens *without*
animation (fixed overlay, no clip-path reveal, no transitions), holds on the
poster frame, and waits for the play button. `loop` is also disabled there —
looping is unrequested motion — and the control returns on `ended`. The consent
flag is a ref read by `playPortfolioDemo`, which is the single funnel every
resume path goes through, so no code path can start motion nobody asked for.

### 12.5 Analytics

Three types added to **both** whitelists in one change: `portfolio_project_view`
(dwell, floored at 1s so a rail sweep is not counted as five views),
`portfolio_progress` (25/50/75/100, `Set`-guarded, riding `timeupdate`), and
`portfolio_video_health` (time-to-first-frame in `value`, stall count in
`section`). `outbound` now carries `section`, and the story panel has a
per-project `data-section`, so a click through to a client site is attributable
to the project that produced it.

No new *fields* were added — the `hasOnly` whitelist is untouched, which is the
half of §10.1 that is hardest to recover from. `analyticsDuration()` clamps to
the rules' 100000 ceiling so a long visit cannot fail a batch.

`npm run test:rules` — **83 passed, 0 failed**, including five new cases
asserting the exact payload shapes `src/main.jsx` builds.

### 12.6 Still outstanding

- **Real-device mobile pass** (§5 acceptance). Not doable from here; iOS autoplay
  and `playsInline` behaviour differ from emulation.
- **React DevTools Profiler check** (§4.4) — the no-re-render property is correct
  by construction (every continuous value is a ref) but has not been measured.
- ~~Edge verification after deploy (§7.3)~~ — **done, verified at the apex.**
  `https://bitesites.org/assets/stockroomnj-DTc4ePaU.mp4` returns
  `200`, `content-type: video/mp4`,
  `cache-control: public, max-age=31536000, immutable`, `cf-cache-status: HIT`.
  HTML at the apex is `no-cache` / `DYNAMIC`, and the live `index-*.js` hash
  matches the local build, so Cloudflare is serving the new bundle rather than a
  stale shell. The `?v=` hack is retired with nothing left depending on it.

### 12.7 Deployed

| Commit | Message |
|---|---|
| `20590b4` | portfolio fixed — phases 2–5, encodes, StockRoom NJ, Bodega repoint |
| `99f8717` | portfolio analytics: only count dwell while the section is on screen |

> **`99f8717` fixes a defect introduced by `20590b4`.** Dwell started counting when
> a card became active, which on page load is project 01 at mount — so the first
> project was billed for all the time spent in the hero above it, and a visitor
> who never scrolled to the portfolio still logged a view on SPA navigation. The
> clock is now gated on the section being on screen, via the rail's existing
> IntersectionObserver; the active index reaches that effect through
> `portfolioActiveRef` so the observer does not re-subscribe on every rail snap.


### 12.8 Intro copy over the cards — fixed 2026-07-21

Reported on mobile: the intro paragraph ("Browse sideways, then open a
project…") printed straight over the project cards.

**Cause.** `.portfolio-intro` was `position: absolute; top: 84px` while
`.portfolio-track` was `position: absolute; top: 29%`. Two rules encoding the
same boundary independently, in different units. The intro's height is set by
how its text wraps, so on any screen narrow or short enough to cost it one more
line, it crossed into the rail. Measured on the shipped build, the intro
overlapped the active card on **8 of 14 viewports** — every phone size, plus
`667×375` by 105px and `1440×700` by 1px. `344×882` cleared by 5.8px. So this
was never mobile-only; phones were just where it crossed far enough to see.

**Fix.** `.portfolio-stage` is a flex column: intro (`flex: 0 0 auto`), rail
(`flex: 1 1 auto; min-height: 0`), footer (`flex: 0 0 auto`). The intro takes
the height its text needs and the rail takes what is left, so overlap is not
possible at any viewport, font size or copy length — the guarantee is
structural, not a tuned number. The cards keep their proportions through
`height: min(var(--portfolio-card-height), 100%)` on the track: the variable
caps them per breakpoint, and the `100%` makes them give way rather than grow
into the copy when space is tight.

Two consequences worth knowing:

- **The demo's open animation is now measured.** `clip-path` was
  `inset(27% 18% round 28px)` — the same hardcoded percentage, describing where
  the rail used to sit. `writePortfolioClipOrigin` in `src/main.jsx` now writes
  `--portfolio-clip` from the opened card's own rect (and its computed corner
  radius), once per open, before the transition starts. Verified to match the
  card exactly at six viewports. It is not on the playback path.
- **A `max-height: 480px` / `max-width: 900px` query was added** for phones held
  sideways, where the intro alone is most of the viewport. It drops the
  paragraph, as the existing short-desktop query already did.

Verified with headless Chrome across 14 viewports (320×568 → 1920×1080, plus
landscape and `prefers-reduced-motion`): no overlap anywhere, open → play →
drag-scrub → resume still works at every one. `npm run build` clean.

> **Do not reintroduce a percentage `top` on the track.** That coupling is the
> defect. If the rail needs to move, move it by changing what surrounds it or
> by `--portfolio-card-height`, both of which the column keeps honest.

---

## 13. Portrait clips — 2026-07-21

### 13.1 The defect §2.5 missed

"No responsive variants" was diagnosed as a *bytes* problem and fixed with the
720p tier. It was also an **aspect-ratio** problem, and that half went unfixed.
The masters are 1880×1080 (1.74:1); the expanded stage on a 390×844 phone is
0.46:1. With `object-fit: cover` ([portfolio.css:183](src/portfolio.css#L183)):

| Viewport | Container | Frame visible |
|---|---|---|
| Desktop 1440×800 | demo 1.80:1 | 97% |
| Phone 390×844 | rail card 0.53:1 | 30% |
| Phone 390×844 | expanded demo 0.46:1 | **27%** |

Phones were seeing roughly a quarter of every frame — a vertical slice through
the middle of a desktop layout. No re-encode at any resolution moves that number.

### 13.2 Capture, not re-crop

[scripts/capture-portfolio.mjs](scripts/capture-portfolio.mjs) records each site's
**mobile layout** in Playwright's WebKit at 405×877 CSS / dpr 2 → 810×1754, which
is 0.4618 against the stage's 0.4621. It scrolls at a fixed 9 px/frame, screenshots
each frame as lossless PNG, and pipes the sequence to ffmpeg — one lossy generation,
no rescale, no device UI to crop off.

WebKit rather than Chromium deliberately: these clips are evidence the sites work
on a phone, and Chrome device emulation is desktop Blink with a resized viewport.
It will render a layout that is broken in Safari.

Two deviations from §6.1, both forced by PNG input:
- **`-pix_fmt yuv420p` is mandatory.** x264 defaults to yuv444p from RGB; Safari
  refuses to decode it and the clip ships black.
- **No `scale` filter** — frames are already at target size.

### 13.3 Inventory

All five verified: 810×1754, yuv420p, 0.5s GOP, `moov` before `mdat`, no audio.

| Project | Duration | Portrait | Poster | Page covered |
|---|---|---|---|---|
| Clifton Ave Animal Hospital | 26.00s | 7.2 MB | 80 KB | 94% |
| Stone Bellisimo | 26.00s | 6.4 MB | 69 KB | **41%** |
| Nexus Verium | 26.00s | 9.7 MB | 109 KB | **67%** |
| Rutgers Newark Bodega Project | **7.47s** | 2.9 MB | 103 KB | 100% |
| StockRoom NJ | 21.37s | 5.6 MB | 77 KB | 100% |

**31.8 MB added; 86.4 MB in the tree.** Only one tier is ever fetched per visitor.

> ⚠️ **Pacing is unresolved — see §13.5.** Holding velocity constant across all
> five was a deliberate choice, and it produced a 3.5× duration spread and three
> clips that stop partway down the page. This is a taste call, not a bug.

### 13.4 Tier selection

`portfolioTier()` in [src/main.jsx](src/main.jsx) replaces the `max-width: 760px`
test with `(max-aspect-ratio: 1/1)` → `(max-width: 1100px), (max-height: 500px)`
→ full. Aspect ratio is the correct axis because *any* viewport taller than it is
wide has the crop problem — the old width test served a 768px portrait iPad the
1880px master **and** a 44% crop.

The tier is now **latched on first call** rather than read live from the
MediaQueryList. The comment at the old `portfolioClip` promised a rotated device
keeps its variant, but `.matches` is live, so a rotation that crossed 760px
already swapped the `src` and dropped the playhead. Aspect ratio flips on every
rotation, which would have made that pre-existing bug fire every time.

Both helpers fall back a tier when an asset is missing, so a project can ship
without a portrait capture rather than 404ing.

No CSS changed. `object-fit: cover; object-position: center top` is correct for
all three tiers — on the rail card a portrait clip crops 12% off the bottom, and
on a portrait iPad 38%, both top-anchored.

### 13.5 Open

- **Pacing.** Constant velocity gives a consistent feel but a 7.5s clip next to
  three 26s clips, and Stone Bellisimo — a 16651px page — stops at 41%. Options:
  per-project `travelPx` to curate the strongest stretch (keeps velocity honest),
  a lower global cap, or per-project velocity (breaks cross-clip consistency).
- **On-page animation speed.** Frames are captured at 50–91ms of wall clock but
  played at 33ms, so any animation still running plays back 1.5–2.7× fast. The
  `prewarm` pass hides most of it by settling one-shot scroll reveals before
  capture; `timeScale` is the escape hatch if a specific site needs it.
- **Real-device pass still outstanding** (§12.6). WebKit-in-Playwright is much
  closer to iOS Safari than Chrome emulation, but it is not an iPhone.

---

## 14. The dossier — 2026-07-22

### 14.1 The details were, in practice, invisible

§4.3 specified the story panel as a finale: `max(duration - 3.5, duration * 0.6)`.
That is a correct *finale* rule and it was implemented correctly. It was the wrong
rule.

The captures shipped at 16–26s ([§13.3](#133-inventory)), so the panel opened
16.5–22.5s after the visitor clicked a card. Nobody watches a silent scroll-through
of a website for twenty seconds to find out whose it is. The observable behaviour
was: open a project, get a video, get no name, no stack, no link — the project copy
existed in the DOM the entire time at `opacity: 0`.

The acceptance criterion in §4.4 — *"Story panel appears near the end and stays
through subsequent loops"* — passed. It tested the mechanism, not the outcome.

### 14.2 What replaced it

Opening a project schedules the panel on a **1.4s timer** (`PORTFOLIO_DETAILS_LEAD`),
long enough for the `clip-path` reveal to land and the first frames to read. Zero
under `prefers-reduced-motion`, where the clip is held on its poster anyway and the
copy is the only thing on offer. It then stays until dismissed.

Nothing on the playback path can show or hide it any more, so §10.6 holds harder
than before: `writePortfolioProgress` no longer calls `setState` at all. The latch
of §10.2 is gone with the threshold that needed it — a timer cannot re-fire on a
loop.

A **toggle** in a new `.portfolio-hud` cluster (top right, beside the "Playing"
chip) collapses it back to a clean frame and cancels any pending reveal, so a panel
the visitor just dismissed cannot be pushed back over the video by a timer they
never saw.

### 14.3 What the change broke, and the fixes

- **Wheel scrub was dead on arrival.** The wheel handler released to the page
  whenever `portfolioStoryRef` was set — sound when the panel meant "the visitor
  reached the end and is reading", nonsense when it is up for the whole visit. The
  test is now the pointer's position: `event.target.closest('.portfolio-story')`.
  Over the video it scrubs, over the copy card it scrolls.
- **The panel was a frame-sized click target.** `pointer-events: auto` on an
  `inset: 0` overlay swallowed drags aimed at the video, and while hidden it left an
  invisible sheet of clickable nothing over the stage. Now `none` on the panel,
  `auto` on the copy card only, and only while `.portfolio-story-visible`.
- **Overlay chrome washed out on hover.** `.portfolio-back` and the new toggle
  hovered to `rgba(255,255,255,.14)` — invisible over a white capture, which is
  every capture for most of its runtime. Hover now goes *darker*.

### 14.4 Reading copy over a website capture

The copy column is a **glass card** (`backdrop-filter: blur(26px) saturate(150%)`)
rather than bare text, because a paragraph laid straight over a scroll-through is
unreadable the moment a pale section passes behind it. The heading has no card, so
it carries its own `text-shadow` — and the gradient-filled `h3`, whose glyphs are
`color: transparent` under `background-clip: text`, uses `drop-shadow()` instead.

The frame vignette was rebalanced bottom-heavy: everything written sits in the
lower third, and the top of the frame is where the captured site's own header is.
On ≤760px it becomes a single vertical scrim — a phone has no side margins for a
horizontal gradient to work in — and the bullet list drops, leaving the paragraph,
the stack pills and the live link.

### 14.5 Verified

Playwright, 1512×860 / 1280×660 / 390×844, worst-case frame parked on StockRoom NJ's
product grid: panel arrives unaided at ~1.4s; wheel over the video scrubs (1.94s →
13.89s) while the panel is up; wheel over the card scrolls the page; collapse holds
through a subsequent 1.6s; Escape closes; reopening a different project shows that
project's copy. No console errors.

---

## 15. The expanded stage as a deck — 2026-07-22

### 15.1 Sideways already meant "next project"

The rail taught the gesture: browse sideways to move between projects. Opening one
threw it away — the only way to reach the next project was to close the stage, find
the rail, scroll it, and open the next card. Four steps to do the thing the section
had already trained the visitor to do with one flick.

Sideways now means the same thing on both sides of the open: it moves between
projects, and the stage stays expanded.

### 15.2 Four ways in

| Input | Path |
| --- | --- |
| Trackpad flick | `wheel`, sideways branch of `handlePortfolioDemoWheel` |
| Touch swipe | pointer events on `.portfolio-demo`, filtered to `pointerType === 'touch'` |
| `←` / `→` | the expanded-phase `keydown`, unless focus is inside the scrub bar |
| `‹` `›` in the dossier | `.portfolio-pager`, which is also how the gesture is discovered |

All four funnel through `switchPortfolioProject(direction)`.

**The sideways branch runs before both existing guards.** Ahead of the
reduced-motion check, because changing project is navigation rather than motion —
that preference asks us not to move things unbidden, not to withhold the work.
Ahead of the dossier check, because a sideways flick means the same thing over the
copy as over the video. It `preventDefault`s unconditionally while expanded, which
also stops macOS's two-finger back-navigation from firing out of a full-screen
viewer.

**One flick is one project.** A trackpad delivers a single gesture as a long stream
of small deltas that outlives the threshold crossing by a wide margin; committing
per-crossing runs through three projects on one flick. Travel accumulates, the
commit locks, and the lock only releases after `PORTFOLIO_SWIPE_SETTLE` of quiet.
Touch needs none of this — a finger has a real beginning and end.

**Vertical always wins on touch.** If a drag's `dy` exceeds its `dx` the gesture is
abandoned outright: that is the page scrolling, and §4.3's standing rule is that
this section never takes the page's scroll away. `touch-action: pan-y` on the demo
states the same split to the browser, which is also what keeps the `pointermove`
stream arriving instead of being swallowed as an overscroll.

### 15.3 The swap

`<video>` is keyed on the clip, so React remounts it and the incoming element runs
the CSS animation from its first frame — no JS timing, nothing to keep in step. It
slides in from the side the gesture came from, over the stage's own black.

At either end of the deck nothing remounts, so the same mechanism runs a short
push-back against the edge instead. A dead gesture at the last project reads as a
broken one; the nudge says "that is the end" rather than "that did nothing".

**The dossier is cut, not faded, during a swap.** The copy changes in the same frame
as the clip, so a transition would fade out text that had only just arrived — the
outgoing panel showing the incoming project's words. `setPortfolioDetails(false)` is
batched into the switch and the transition is suppressed while a swap class is on;
it fades back in afterwards on its own `PORTFOLIO_DETAILS_LEAD`.

### 15.4 Why the closing clip-path is not re-measured

`--portfolio-clip` is measured once, off the card that was opened (§12.1). Switching
projects does not stale it: every card is the same size and `showProject` centres
the one it is given, so the centred box is identical whichever project holds it. The
rail is scrolled along with each swap anyway — invisible behind the demo, but still
what decides which card is centred when the visitor comes back out.

### 15.5 Verified

Playwright, 1512×860 and 390×844-with-touch: one trackpad flick advances exactly one
project across a 14-event stream; a second flick after the settle window advances
again; flick left goes back; `→`/`←` and both pager buttons agree. At the last
project the index holds at 05, `portfolio-swap-end-next` runs, and the next button
reports `disabled`. Touch swipe left/right moves forward/back; a short drag and a
mostly-vertical drag both leave the index alone. Vertical wheel still scrubs
(0.98s → 9.84s) after all of it, and Escape still closes onto the project swiped to.
A real pointer click and a keyboard activation of the pager both leave `window.scrollY`
untouched. No console errors.

---

## 16. Click the frame to close — 2026-07-22

Closing was a 27px target in one corner (`.portfolio-back`) or a key most visitors
never try. The clip itself now dismisses on click, the backdrop-dismiss every
full-screen viewer has, and it routes through the same `closePortfolioProject(true)`
the back button calls — including the focus return to the rail.

### 16.1 What a click must not close

`PORTFOLIO_KEEPS_OPEN` names every surface inside the stage that owns its own
click: the back button, the scrub bar, the HUD, the pager, the reduced-motion play
control, and the dossier's **copy card**. The card is on the list because it is a
reading surface with the outbound link in it — dismissing the stage out from under
someone reaching for "Visit the live site" is the worst available reading of a
click. The bare title beside it is painted straight on the frame and is not on the
list, so it closes; the card's border and glass are what make that legible as two
different surfaces rather than one inconsistency.

### 16.2 A drag is not a click

Scrubbing, swiping and dragging to select all end in a `mouseup` the browser is
happy to promote to a `click`. Every pointer that goes down on the stage is now
tracked, and a press that travels more than `PORTFOLIO_CLICK_SLOP` is marked as a
drag and refused by the close handler.

This merged the touch-swipe record and the click record into one `press` object.
They were going to be two refs answering the same question — how far did this
pointer travel between down and up — and two answers to that question is exactly how
they would have come to disagree. The record deliberately survives `pointerup`,
because the `click` that reads it arrives afterwards; `pointercancel` clears it,
because no click follows one.

`cursor: zoom-out` on the expanded demo says all of this before it is tried —
`zoom-out` rather than `pointer` because the click shrinks the stage back to the
card it grew from rather than activating anything.

### 16.3 Verified

Playwright, 1512×860 and 390×844-with-touch, one assertion per surface: clicks on
the dossier paragraph, the pager, the details toggle and the scrub bar all leave the
stage open and do their own job (the pager advances, the toggle hides the dossier,
the bar seeks). A 200px drag across the clip leaves it open. A plain click on the
clip, and one on the bare title, both close. The back button still closes exactly
once — it is on the keep-open list, so its own handler runs and the bubbled click
finds `portfolioExpandedRef` already false. On touch, a tap closes and a swipe
switches project without closing, including when a `click` is synthesised behind the
swipe. All prior suites still pass.

> One test caught this rather than the code: `deck.mjs`'s swipe helper opened with a
> stray `tap(1, 1)`, which under this change is a perfectly valid dismiss. The
> failure was the test asserting on a stage its own setup had just closed.

---

## 17. Two Bodega entries, and toured captures — 2026-07-22

### 17.1 One card was covering two different pieces of work

[§12.3](#123-content-changes) repointed the Bodega card from `Bodega-Project-2` to
`the-bodega-project-demo` and rewrote its copy to match, on the reading that the
second link had replaced the first. It had not. They are two halves of the same
programme:

| | |
|---|---|
| `Bodega-Project-2` | the **research site** — the Rutgers Business School–Newark and Bergen Community College programme, its Fast vs. Fresh food-access map, its KPI Builder, the story, blog and gallery |
| `the-bodega-project-demo` | the **app MVP**, in development with Rutgers — the neighbour-to-neighbour product built on top of that research |

So the rail now carries both. The existing card goes back to the research site
with copy rewritten to it, and **project 05 is new**: `Bodega Project App MVP`,
placed immediately after its sibling because §15's deck makes sideways mean "next
project", and the two belong next to each other under that gesture. StockRoom NJ
moves to 06.

Six projects needs nothing else: the `0{index + 1}` counters in `src/main.jsx`
hold to nine, and the pager, dots and swipe deck are all length-derived already.

### 17.2 Scrolling the landing page was the wrong clip for both

[§13](#13-portrait-clips--2026-07-21) captures a site by scrolling it top to
bottom. That is right for the four marketing sites, whose landing page *is* the
work, and wrong for both of these:

- The research site's substance is behind two tools and three sub-pages. Its home
  page is a hero, an About block and two cards that link away.
- The MVP is a tab bar. A scroll of its feed shows a list and implies the rest of
  the app does not exist.

`scripts/capture-portfolio.mjs` therefore grew a **tour**: an optional array of
steps, per project and if needed per orientation, that clicks through a site the
way a visitor would. Without one a project still gets the plain scroll, so the
other four are untouched.

| step | does |
|---|---|
| `{ scroll: px }` | travel down at the same global `PX_PER_FRAME` as everything else |
| `{ jump: px }` | reposition **without filming** — a cut, where `scroll` is a move |
| `{ click: sel, hold: n }` | in-page click; the camera keeps rolling through the state change |
| `{ open: sel, hold: n }` | a click that navigates; filming pauses for load and prewarm |
| `{ hold: n }` | stay put |

Three things this needed that are worth knowing:

- **`aim` resolves the scroller, then travels it.** Playwright's `click` scrolls
  an element into view itself, instantly — a jump cut mid-clip. So the step finds
  the element's own scrolling ancestor first and moves *that* at `PX_PER_FRAME`.
  The map page needs it: `#layerModeBtn` sits 1117px down a control panel with
  `overflow-y: auto`, on a page whose window scroll maxes at 620.
- **Anything under a `fixed` or `sticky` ancestor is never travelled to.** It is
  on screen wherever the document is, and its document position is meaningless.
  This covers the MVP's tab bar and the research site's header.
- **A failed step fails the capture.** A tour step that silently no-ops ships a
  clip of a site sitting still, and the encode downstream would produce it
  happily.

`--probe` runs a tour with the screenshots switched off. It is the cheap oracle:
it proves every selector still resolves, and reports the frame count, in about a
minute — against roughly seven for a real run.

> **Selectors are matched on text, not `href`.** Both navs emit relative links, so
> `a[href="kpi-builder/"]` matches on the home page and misses on every other
> page in the site.

### 17.3 The landscape tier is now capturable too

Only the portrait tier was. The other four projects' landscape masters are owner
recuts, and project 05 had none — so `ORIENTATIONS` gained a landscape entry at
940×540 CSS / dpr 2 = **1880×1080**, which is the exact size of those recuts. A
capture and a recut are therefore interchangeable under the same `object-fit`,
and `scale=1280:-2` produces the same 1280×736 for the 720 tier either way.

`orientations` on a project defaults to `['portrait']`, so a plain run cannot
overwrite a recut with a capture. Only the two Bodega entries opt into both.

> **`-maxrate` is per tier, and it binds.** Both landscape tiers first shipped at
> the portrait tier's `3M`, and came out 13.6 MB and 8.5 MB — the 720 tier at 94%
> of the master, which is the entire reason it exists gone. Screen capture at
> `crf 20` wants more than 3 Mbps at 1880px. §6.1's split — `6M` for 1080p, `3M`
> for 720 — is right, and it is not optional.

### 17.4 What the tours show

**Rutgers Newark Bodega Project.** Home → the "Turn field data into action" tool
cards → Fast vs. Fresh food-access map → drop the fast-food layer → scroll the
control panel → Switch to Cluster View → KPI Builder → remodel margins as
Distributor, then as Bodega → Story. Desktop reaches the tools through the header
submenu; the phone uses the off-canvas drawer, and reaches the map from the drawer
rather than the funnel cards — those sit 2552px down an 11306px document, and nine
seconds of scrolling to reach a link is most of the clip's budget.

**Bodega Project App MVP.** Feed → filter to Greens, then Tomatoes, then back to
all → open a harvest's detail sheet → Local Map with the Newark food nodes → My
Harvest → the add-harvest sheet, choosing a category and switching the exchange
type to a price.

> **`jump` before each tab change is load-bearing.** Switching tabs swaps the
> content but leaves `scrollY` where the last tab left it, so arriving on Local
> Map from a scrolled feed opens 680px down — past the map, which is the whole
> tab. The first cut of this clip did exactly that. It is a jump rather than a
> `scroll` because two and a half seconds of scrolling backwards is dead footage,
> and cutting on a tab change reads as the page change it is.

### 17.5 Inventory

All six files verified: H.264, yuv420p, 0.5s keyframe interval, `moov` before
`mdat`, no audio track.

| Project | Duration | 1080p | 720p | Portrait | Posters |
|---|---|---|---|---|---|
| Rutgers Newark Bodega Project | 25.10 / 26.00s | 13.2 MB | 8.1 MB | 8.1 MB | 115 + 110 KB |
| Bodega Project App MVP | 25.87 / 24.33s | 9.6 MB | 5.7 MB | 7.2 MB | 45 + 103 KB |

The two durations are landscape and portrait: a tour's length is what its steps
add up to, and the two layouts do not take the same number of steps. Both stay
under the 26s house maximum the four scrolled clips hit. **51.9 MB across the two
entries**, replacing 21.6 MB for the single card they came from — and, as before,
only one tier is ever fetched per visitor.

### 17.6 Verified

`npm run build` clean. Playwright against the built bundle at 1512×860 and
390×844-with-touch: six cards in the rail and `06` in the footer counter; the
research site and the MVP adjacent at 04 and 05; each dossier carrying its own
title, stack, blurb and outbound link; each `<video>` resolving to its own hashed
asset and playing; the deck's pager disabled at 06 and stepping back onto the MVP.
No console errors, no failed requests.

### 17.7 Open

- **The tours are pinned to two sites' markup.** `--probe` is how that gets
  caught; run it before assuming a stale clip is an encode problem.
- The real-device pass ([§12.6](#126-still-outstanding)) is still outstanding, and
  now covers two more clips.
