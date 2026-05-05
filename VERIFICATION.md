# Tempest Coil — Verification

## Design summary

Lightning weapon archetype focused on chaining hits, damage amplification
via shock, and weakening enemies via sap.

- **Tempest Coil** (rare). A slow, large lightning bolt. Pierces 3.
  Pure-lightning damage breakdown. On hit, arcs to up to two additional
  nearby enemies via a dedicated `tempestCoilChainDamage` helper; chain
  hops are marked `fromAilment:true` so they cannot recursively roll new
  shocks/saps. Same target cannot be re-hit by the same chain. Hard
  depth cap of 8 hops on top of the configured `tempestArcs`.
- **Overcharge I — Static Buildup** (rare): +2 chain hops (4 total),
  +0.15 hop damage multiplier.
- **Overcharge II — Conductive Surge** (epic): the primary projectile
  carries `shockMagnitudeBonus = 0.25` and `sapMagnitudeBonus = 0.10`.
  Bonuses flow through `damageEnemy → applyAilmentsFromHit` exactly like
  the existing Virulence poison fields and are clamped (`shock <= 1`,
  `sap <= 0.6`) so they can never become degenerate.
- **Overcharge III — Static Discharge** (epic): on enemy death, if the
  corpse is still shocked and the killing player owns the upgrade,
  release exactly one lightning burst at the corpse. Burst damage is
  `fromAilment:true` so it cannot apply more shock — guaranteeing only
  one discharge per death (no chain storms).

## Files touched

- `src/ailments.js` — added support for `hit.shockMagnitudeBonus` and
  `hit.sapMagnitudeBonus` (additive, clamped) inside
  `applyAilmentsFromHit`. No UI/render code added.
- `src/entities.js` — added `tempestCoilCooldown` field and
  `tempestCoilLevel`, `overcharge1`, `overcharge2`, `overcharge3` stats.
  Added projectile fields `weaponKind`, `tempestArcs`, `tempestRange`,
  `tempestDamageMultiplier`, `shockMagnitudeBonus`, `sapMagnitudeBonus`.
- `src/simulation.js` — wired Tempest Coil firing in `updatePlayers`,
  added `fireTempestCoil`, `tempestCoilChainDamage`,
  `triggerStaticDischarge`. Threaded `shockMagnitudeBonus` /
  `sapMagnitudeBonus` from source projectile/hit into
  `applyAilmentsFromHit` (mirrors Virulence pattern).
- `src/upgrades.js` — added `tempest-coil` weapon and
  `overcharge-1/2/3` chain with `requiresUpgrade` prerequisites.
- `tests/upgrades.test.js` — 7 new tests (firing shape, requires chain,
  tier I deepens chain, tier II adds magnitude bonuses, chain depth cap
  + no re-hit, tier III bursts on shocked-kill, tier III silent on
  un-shocked kill).
- `tests/ailments.test.js` — 4 new tests (shock+sap from lightning
  hits, `shockMagnitudeBonus` boosts and clamps, chain hops do not
  re-roll ailments, validateAilmentConfig still passes).
- `docs/AILMENTS.md` — documented the new
  `hit.shockMagnitudeBonus` / `hit.sapMagnitudeBonus` flag pattern in
  the existing "Player-side ailment scaling" section.

`src/render.js` was **not** modified — the new mechanic is fully
representable with the existing shock/sap pips routed through
`getActiveAilmentDisplay` / `AILMENT_DISPLAY`.

## Verification commands and results

```text
$ npm test
# tests 121
# pass 121
# fail 0
# duration_ms 1431.33
```

```text
$ git diff --stat base/ailments
 docs/AILMENTS.md       |  11 ++
 src/ailments.js        |  10 +-
 src/entities.js        |  11 ++
 src/simulation.js      | 120 +++++++++++++++++++++++++
 src/upgrades.js        |  21 +++++
 tests/ailments.test.js | 107 ++++++++++++++++++++++
 tests/upgrades.test.js | 159 ++++++++++++++++++++++++++++++++
 7 files changed, 438 insertions(+), 1 deletion(-)
```

```text
$ grep -n "AILMENT_CONFIG\s*=" src/
src/ailments.js:23:export const AILMENT_CONFIG = {
```

Only the original declaration — no runtime mutation anywhere.

## Caveats / risks

- The shock magnitude clamp (`<= 1.0`) is hit by `shockMagnitudeBonus
  >= 0.5` on a max-strength roll. Tier II's bonus of 0.25 is well
  below this, so the clamp only matters for future stacking of new
  shock-bonus sources.
- `triggerStaticDischarge` runs after `triggerContagionBurst`. A future
  tier could in principle let a contagion burst kill a shocked enemy
  whose discharge then damages a third enemy; the discharge itself
  cannot recurse (it is `fromAilment:true`), but the design choice is
  intentional — kills of any kind can release the stored charge.
- Chain hops carry a synthetic `damageBreakdown: { lightning: ... }`.
  This is consistent with the projectile being a lightning weapon and
  matters only for the (currently no-op) interaction with `scorch` /
  fire-typed damage takers.
