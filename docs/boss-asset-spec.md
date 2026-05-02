# Boss & Run-Event Asset Spec

Status: deferred from gameplay shipping. Cover art for 4 bosses + a few missing enemy sprites + boss HUD portraits + boss-spawn telegraph visuals.

Bosses today reuse the underlying enemy `type` sprite plus a generic dashed aura (`drawBossAura` in `src/render.js` ~L397). Players can't tell `brood-splitter` from `nova-spitter` at a glance beyond color tinting. This spec covers both **PNG assets to generate** and **procedural canvas overlays** that will composite over them.

---

## TL;DR

- 4 boss body sprites (256×256 PNG, transparent bg, top-down view).
- 4 boss HUD portrait chips (64×64 PNG).
- 3 missing base enemy sprites: `splitter`, `bulwark`, `spitter` (256×256 PNG).
- Procedural overlays in `render.js` for auras, telegraphs, boss-spawn warning, and HUD chip framing.

---

## 1. Image generation requests

All assets: **transparent background, top-down orthographic view, neon sci-fi style, additive glow accents, dark base palette (`#080b15` / `#0d1423`), readable silhouette at 32px**. Match the existing enemy sprite style: see `assets/enemy-sprites/charger.png`, `siphon.png`, `warden.png` for reference (compact mechanical/biological hybrids, glowing core + 1-2 accent rim lights).

### A. Base enemy sprites (256×256 PNG, transparent)

These are missing from `assets/enemy-sprites/`; they currently render as canvas primitives in `drawEnemy` (`src/render.js:342`).

| File | Subject | Notes |
|---|---|---|
| `assets/enemy-sprites/splitter.png` | A small spiky polygonal drone, ~6 jagged points radiating outward, glowing orange `#ff9a3d` core, dark armor segments. Reads as "fragile, will shatter." | Will be reused tinted for `brood-splitter` boss. |
| `assets/enemy-sprites/bulwark.png` | A thick armored square/octagonal mecha, riveted plating, glowing slit-eye band in violet `#7c88ff`. Reads as "tank, hard to crack." | Will be reused for `bastion-bulwark` boss. |
| `assets/enemy-sprites/spitter.png` | A bulbous bio-mech with a wide central maw/vent glowing yellow-green `#d7ff57`, surrounded by 3-4 venting nozzles. Reads as "ranged, volatile." | Will be reused for `nova-spitter` boss. |

### B. Boss body sprites (256×256 PNG, transparent)

Distinct from base enemies — bigger, more detail, more menacing silhouette. Same top-down view, same palette discipline. Each should be **immediately distinguishable from its base enemy** so the player knows when a boss is on screen even with overlays disabled.

| File | bossId | Brief |
|---|---|---|
| `assets/enemy-sprites/boss-brood-splitter.png` | `brood-splitter` | Large jagged crystal-cluster boss, multiple shard-children visible orbiting the core, dominant orange `#ff9a3d` glow with hot-white core. Spikes longer and more numerous than base splitter. Hint of cracks suggesting it will fragment. |
| `assets/enemy-sprites/boss-siphon-prime.png` | `siphon-prime` | Hollow ringed predator with a central void/mouth, concentric armor rings, 4 prehensile tendrils suggesting siphon attacks. Dominant cyan `#25d6ff` glow, dark core void at center. |
| `assets/enemy-sprites/boss-bastion-bulwark.png` | `bastion-bulwark` | Heavy fortress-mech with 4 visible armor plates on cardinal faces, thick hex shield outline, glowing violet `#7c88ff` seams. Reads as "siege boss, must break plates first." |
| `assets/enemy-sprites/boss-nova-spitter.png` | `nova-spitter` | Unstable bio-reactor boss with bulging central pressure chamber, exposed plasma vents leaking yellow-green `#d7ff57` motes, cracked outer shell with hot-white fissures. Reads as "will detonate." |

### C. Boss HUD portrait chips (64×64 PNG, transparent)

Used in the top-of-screen boss bar (`drawBossHud` in `src/render.js:1189`). Tightly framed bust/silhouette of each boss, high contrast, readable at 36×36. Match boss accent color as the dominant tone.

| File | bossId |
|---|---|
| `assets/enemy-sprites/portrait-brood-splitter.png` | `brood-splitter` |
| `assets/enemy-sprites/portrait-siphon-prime.png` | `siphon-prime` |
| `assets/enemy-sprites/portrait-bastion-bulwark.png` | `bastion-bulwark` |
| `assets/enemy-sprites/portrait-nova-spitter.png` | `nova-spitter` |

---

## 2. Procedural overlays (implementation in `src/render.js`)

Layered **on top** of the PNG sprites above. These convey state (HP, attacking, charging) that a static image can't.

### Per-boss aura + body overlays

Replace the single `drawBossAura` (`src/render.js:397`) with a dispatch on `bossId`. Each boss gets:

| Boss | Aura | Body overlay | Mechanic telegraph |
|---|---|---|---|
| `brood-splitter` | 6 segmented arcs (each 36° span, 6° gap, strokeWidth 4, `#ff9a3d`), rotating 0.6 rad/s. Arcs fade out one-by-one as HP drops in 6 buckets. | 3 small shard-silhouettes (r=4) orbiting at body radius+20 at 1.4Hz — preview of the children that will spawn. | 0.8s before split: orbiting shards detach outward to radius+50, body squashes scale 1.0→0.78→1.15, white flash. |
| `siphon-prime` | Counter-rotating dashed rings: outer r+18 dashed `[6,4]` at +1.2 rad/s, inner r+8 `[3,9]` at -2.4 rad/s. While siphoning: spawn 1 cyan particle/frame along player→boss line. | 3px transparent inner void at r=radius*0.55 (vacuum mouth). | Tether line boss→target while draining: dashed `[10,6]` cyan, lineWidth 1.5, alpha 0.55, dashOffset advancing -elapsed*60. |
| `bastion-bulwark` | Hex shield outline at r+22 (6-sided polygon, lineWidth 3, dash `[2,4]`, 0.2 rad/s). Flashes white→violet on `armored` tick (0.25s). | 4 trapezoidal armor plates on N/E/S/W faces, fill `#7c88ff` at 0.55 alpha, 1px white inner edge. Plates rotate with body bob. | Pre-slam: plates extend outward (radius lerp +0 → +12 over 1.0s) then snap back with a r+60 expanding ring (lineWidth 6→0 over 0.35s). |
| `nova-spitter` | Single jagged ring of 12 short radial spikes (r → r+10, lineWidth 2). Spikes flicker at 30%/frame chance (random alpha 0.4-1.0). | 3 ember motes orbiting at r=radius*0.7 at 3 Hz, gradient `#fff7c0` → `#d7ff57`, additive. | 1.0s before volatile burst: ember motes accelerate inward, body scales 1.0→1.18, screen-space radial gradient `rgba(215,255,87, 0→0.45)` over r+90. |

All overlays use `globalCompositeOperation = "lighter"` (matches existing aura code at `src/render.js:401`).

### Boss HUD portrait frame

`drawBossHud` (`src/render.js:1189`) currently shows name + bar only. Add a 36×36 chip immediately left of the bar (shift bar `x += 44`):

- `chamferedRectPath` 36×36, fill `rgba(4,9,20,0.85)`, stroke `bossColor(boss)` 1.4px.
- Draw the corresponding `portrait-*.png` sprite inside, scaled to 32×32 with 2px inset.
- At HP < 25%: chip border pulses `boss accent → #ff5b79` over 0.5s (sin-driven).

### Boss-spawn telegraph (new — recommended)

Players have no warning before a boss appears. Add 2.5s pre-spawn telegraph at the spawn point:

- Concentric expanding ring: r=10 → 90 over 2.5s, lineWidth 3→1, color `bossColor(bossId)`.
- 6 inward-flying chevrons (each a 2-line `>` pointing center) starting at r=160, ease-in to r=20 over 2.5s.
- Last 0.4s: full-screen vignette pulse (`rgba(boss-accent, 0→0.18)`) drawn screen-space after world transform restore.
- Final frame: 60-particle radial burst (existing particle system).

Requires `simulation.js` to expose `bossSpawnTelegraph` state starting at `nextBossSpawnAt - 2.5`.

---

## 3. Affix auras — keep as-is, one tweak

Existing four affix auras (`affixAuraStyle` in `src/render.js:1880`) are visually distinct enough:

- `armored`: solid + slow.
- `regenerating`: short-dash green + dot constellation.
- `hasted`: medium-dash gold spinning fast.
- `volatile`: long-dash red+amber.

**One tweak**: when a `volatile` enemy is within 0.6s of bursting, increase pulse from 11 to 22 and add a 1-frame white core flash at radius*0.4. Warns the player before the burst.

---

## 4. Run events — keep as-is, one tweak

`drawLaneSweepEvent` (`src/render.js:132`) and `drawRewardCacheEvent` (`src/render.js:159`) are already well-specced.

**One tweak**: `rewardCache` keeps drawing after pickup (`src/simulation.js:332`). Add a collapse animation: radius lerps to 0 over 0.4s with alpha fade. Track via `event.collectedAt` in sim.

---

## Palette reference

From existing code (no `styles.css` lookup needed):

- Cyan `#64d9ff` / `#25d6ff`
- Amber `#ffc857` / `#ff9a3d`
- Red `#ff5b79`
- Violet `#7c88ff`
- Lime `#d7ff57`
- Regen green `#3cff94`
- Plate white `#ffffff` @ 0.24 alpha

---

## Files the implementation will touch

- `assets/enemy-sprites/` — drop new PNGs from sections A/B/C above.
- `src/assets.js` — register new enemy sprites in `ENEMY_IMAGES`, add new `BOSS_IMAGES` and `BOSS_PORTRAIT_IMAGES` maps with the same `loadSheet`/`loadImageSet` pattern as existing entries.
- `src/render.js` — replace `drawBossAura` with dispatcher; add `drawBossBodyOverlay`, `drawBossSpawnTelegraph`, `drawBossSigil` (or sprite-based `drawBossPortrait`); rework `drawBossHud` layout; tweak `volatile` pulse near burst.
- `src/simulation.js` — add `bossSpawnTelegraph` state (start 2.5s before `nextBossSpawnAt`); add `event.collectedAt` for `rewardCache`.

No changes to `entities.js` or `config.js` for the visual layer.
