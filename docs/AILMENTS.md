# Ailments & Damage Types

Internal reference for the combat ailment system. Source: `src/ailments.js`.
Tests: `tests/ailments.test.js`.

## Damage types

`DAMAGE_TYPES = ["physical", "fire", "cold", "lightning", "chaos"]`.

**Physical is the default.** Any projectile or hit without an explicit
`damageType` is treated as physical. Hits may also carry a `breakdown` map
splitting damage across types, e.g. `{ physical: 10, fire: 5 }`. When a
breakdown is present it is authoritative; otherwise the single `damageType`
field is used.

## Hit pipeline

1. A projectile or contact hit calls `simulation.damageEnemy(enemy, dmg, hit)`.
2. `damageEnemy` applies armor, shock/scorch multipliers, then subtracts HP.
3. If the hit is **not** marked `fromAilment`, it routes through
   `applyAilmentsFromHit(enemy, hit, rng)`. DOT ticks set `fromAilment:true`
   so they cannot recursively roll new ailments.
4. `applyAilmentsFromHit` iterates every entry in `AILMENT_CONFIG`, computes
   the typed portion of the hit (via `breakdown` or `damageType`), rolls an
   HP-threshold strength, and applies the ailment if the roll succeeds.

## DOT pipeline

`updateAilments(simulation, enemy, dt)` is called each tick per enemy. For
each active ailment it decays `remaining`, accumulates `tickAccumulator`, and
emits ticks via `simulation.damageEnemy(..., { fromAilment:true })`. Stacking
ailments (poison) tick each stack independently and prune expired stacks.

## HP-threshold formula

For each ailment:

```
strength   = clamp01(typedHitDamage / (enemyMaxHp * threshold * rankResistance))
chance     = lerp(chanceFloor, chanceMax, strength)
duration   = lerp(durationMin, durationMax, strength)
magnitude  = lerp(magnitudeMin, magnitudeMax, strength)   // if defined
dotPerSec  = (typedHitDamage * dotFraction) / duration    // if dotFraction set
```

`rankResistance` is `bossResistance` for `enemy.rank === "boss"` and
`eliteResistance` for elites; defaults to 1. Only ailments that opt in
(currently `freeze`) gate on rank.

## Ailment list

| Ailment | Source(s) | Effect |
|---|---|---|
| bleed | physical | DOT (70% of hit). 2x while moving. |
| poison | physical, chaos | DOT (30% of hit). Stacks up to 8. |
| ignite | fire | DOT (90% of hit). |
| chill | cold | Slows movement by `magnitude` (10–30%). |
| freeze | cold | Stops movement entirely. Bosses/elites resist. |
| shock | lightning | +`magnitude` damage taken (10–50%). |
| scorch | fire | +`magnitude` fire damage taken (10–30%). |
| brittle | cold | Outgoing hits crit (`magnitude` crit bonus on hit). |
| sap | lightning | Reduces enemy outgoing damage by `magnitude`. |

## Adding a new ailment

1. Add an entry to `AILMENT_CONFIG`. Required fields:
   `sources`, `threshold`, `chanceFloor`, `chanceMax`, `durationMin`, `durationMax`.
   Optional: `magnitudeMin/Max`, `dotFraction`, `tickRate`, `stack`+`maxStacks`,
   `bossResistance`, `eliteResistance`, `movingBonus`.
2. Add an entry to `AILMENT_DISPLAY` (label + color). Position in the list
   defines render priority of pips.
3. If the ailment changes a derived stat (speed, damage taken, crit, outgoing
   damage), extend the relevant `getAilment*Multiplier` helper or add a new
   one and consume it from the appropriate site in `simulation.js` /
   `entities.js`.
4. Add tests in `tests/ailments.test.js`.

`validateAilmentConfig()` will fail loudly if required fields are wrong or
if an ailment has no display entry — run it from a test (see
`tests/ailments.test.js`).

## Giving a tower/projectile a damageType

- Set `projectile.damageType = "fire"` (etc.) at spawn time.
- For mixed damage, set `projectile.damageBreakdown = { physical: 10, fire: 5 }`.
  The hit object passed to `damageEnemy` should forward `damageType` and
  `breakdown` so `applyAilmentsFromHit` can split correctly.

## Player-side ailment scaling

Per-player upgrades that buff ailments (e.g. the Virulence chain) must NOT
mutate `AILMENT_CONFIG` at runtime — that table is shared across all
sources, including enemy-on-player damage. Instead, scale at hit-construction
time by passing optional fields on the `hit` object into
`applyAilmentsFromHit`:

- `hit.poisonDotMultiplier` — multiplies the typed poison damage entering
  the strength/duration/dotPerSecond computation. Used by Virulence I.
- `hit.poisonMaxStacks` — overrides the per-call `maxStacks` for poison
  only. Used by Virulence III to raise the cap from 8 to 12 for the
  player's poisons. Other sources still use the global cap.
- `hit.brittleMagnitudeBonus` — additive bonus (clamped to 1) added to
  the rolled brittle `magnitude`. Used by Glaciation III (Cryoclasm) to
  push brittle's crit conversion above its baseline range.

Cold-archetype weapons (Rime Lance) also use **projectile/source-level
flags** read by `damageEnemy` rather than `applyAilmentsFromHit`:

- `source.frostbite` + `source.permafrostBonus` — multiplicative damage
  bonus applied when the target carries any cold-tag ailment
  (chill / freeze / brittle). Used by Glaciation I (Permafrost).
- `source.shatterpoint` + `source.shatterRadius` + `source.shatterDamage`
  + `source.shatterCritMultiplier` — when set, hits on a frozen-or-brittle
  target spawn a cold AoE burst that re-enters `damageEnemy` with
  `fromAilment: true` so it cannot recursively roll ailments. Brittle is
  not boss-gated, so the brittle path is the freeze-immune payoff hook
  for bosses/elites. Used by Glaciation II (Shatterpoint) and
  Glaciation III (Cryoclasm doubles the burst on critical hits).
- `source.cryoclasmBrittleBonus` — threaded into `applyAilmentsFromHit`
  as `hit.brittleMagnitudeBonus` for the lance's own brittle rolls.

`damageEnemy` looks up the owning player from `source.ownerId` and threads
these fields through automatically, so weapon/contagion/drone code paths
all benefit without per-site changes. New per-player ailment knobs should
follow the same flag-driven pattern.

## Tuning

All balance knobs live in `AILMENT_CONFIG`. To make an ailment apply more
often, lower `threshold` or raise `chanceFloor`. To make it hit harder,
raise `dotFraction` (DOTs) or `magnitudeMax`. Duration scales with the same
strength roll, so a higher `durationMax` rewards heavy hits.

## Known limitations

- **Brittle** is currently applied at projectile-hit time
  (`applyBrittleCrit(projectile, enemy)`) — it converts a non-crit into a
  crit on impact rather than boosting pre-fired crit chance. This means
  brittle does not interact with crit-roll modifiers that fire before the
  projectile is created.
- **Sap** affects contact damage and volatile death damage but does **not**
  affect siphon-drain HP transfer, since that mechanic is HP siphon rather
  than normal outgoing damage.
- **Debug visibility**: there is no general debug-overlay system in the
  project. To inspect live ailment state, log
  `getActiveAilmentDisplay(hoveredEnemy)` or `enemy.ailments` from
  `render.js` while iterating.

## Display & pip rendering

`drawAilmentPips` (in `src/render.js`) draws a compact row of colored pips
above each enemy's HP bar. The row sits on a translucent dark pill so pips
stay readable over bright sprites and the HP bar.

Visual conventions:

- **Priority order**: pips are drawn in the order returned by
  `getActiveAilmentDisplay(enemy)`, which is the order of `AILMENT_DISPLAY`.
  The current order groups by category: control (`freeze`, `shock`, `chill`)
  → DOT (`ignite`, `bleed`, `poison`) → debuff (`brittle`, `scorch`, `sap`).
- **Control emphasis**: control ailments render slightly taller with a
  white outline; non-control ailments use a dark outline. This makes
  freeze/shock/chill stand out from background DOTs.
- **Stack badges**: ailments with `showStackCount: true` (currently only
  `poison`) render their stack count inside the pip when `stacks > 1`.
  The pip is only 7×5px, so stack counts above 9 (possible once Pandemic
  raises the cap to 12) render as `9+` rather than enlarging the pip.
- **Overflow**: at most 5 pips render. If more are active, the highest-
  priority 5 render and a small `+N` is appended. Use
  `truncateAilmentDisplay(entries, maxVisible)` to do the same in HUD code.

## Display helper / tooltip extension point

`getActiveAilmentDisplay(enemy)` is the documented extension point for any
UI that needs to surface ailments (pips, tooltips, future HUD). It returns
a priority-ordered array of plain objects with both display metadata and
live state — UI code should never reach into `enemy.ailments` directly:

```js
{
  id, name,                  // ailment key, e.g. "poison"
  label, shortLabel, color,  // display metadata
  priority, category,        // 1..N (lower = more important); "control"|"dot"|"debuff"
  isControl, isDot, isDebuff,
  showStackCount,            // whether UI should render `stacks` as a badge
  stacks,                    // current stack count (1 for non-stacking)
  remaining,                 // longest remaining duration in seconds
  magnitude,                 // primary magnitude (e.g. shock multiplier)
}
```

To tune display, edit the corresponding row in `AILMENT_DISPLAY` — change
`priority` to reorder pips, `category` to flip visual emphasis,
`showStackCount` to opt new ailments into stack badges, or `shortLabel` /
`label` for new tooltip strings. The helper stays pure; do not put
canvas/render logic in `src/ailments.js`.
