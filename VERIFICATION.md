# Pyre Brand + Conflagration — Verification

## Design summary

Fire-themed weapon plus a 3-tier upgrade chain centred on **igniting and
scorching**. Mirrors the Plague Lance / Virulence shape exactly.

- **Pyre Brand** (rare, 1 stack) — equips a slow, pierce-2 fire bolt that
  deals `{ physical: 8, fire: 20 }` and reliably ignites + scorches.
  Independent cooldown loop in `updatePlayers`, parallel to Plague Lance.
- **Conflagration I — Cinderbloom** (rare) — sets `stats.conflagration1`,
  which threads `igniteDotMultiplier: 1.4` into every owned hit through
  `damageEnemy`. Increases ignite DOT by 40% via the standard
  hit-construction-time scaling pattern (no `AILMENT_CONFIG` mutation).
- **Conflagration II — Wildfire** (epic) — sets `stats.conflagration2`.
  Ignited enemies that die trigger `triggerWildfireBurst`, dealing fire
  burst damage (80% of ignite DPS) to enemies in radius 80 with
  `damageBreakdown: { fire: ... }`. Burst damage is real damage (not
  `fromAilment`) so neighbours can themselves be ignited — but the source
  carries `wildfireDepth: 1`, and the helper bails on any source whose
  `wildfireDepth >= 1`, so propagation is hard-capped at one hop.
- **Conflagration III — Pyroclasm** (epic) — sets `stats.conflagration3`,
  which threads `scorchMagnitudeBonus: 0.25` onto owned hits. In
  `applyAilmentsFromHit`, this is added to the rolled scorch magnitude
  (post-lerp), pushing scorch beyond its base 30% cap to up to ~55% extra
  fire damage taken on heavy hits. Global config remains untouched.

All three tiers escalate the same fantasy: more burn, burning enemies
spread fire on death, scorched enemies burn even harder.

## Files touched

- `src/ailments.js` — added `igniteDotMultiplier` and `scorchMagnitudeBonus`
  hit fields inside `applyAilmentsFromHit` (mirrors existing
  `poisonDotMultiplier` / `poisonMaxStacks` knobs). No render/UI code.
- `src/entities.js` — added `pyreBrandCooldown` and four new player stats:
  `pyreBrandLevel`, `conflagration1`, `conflagration2`, `conflagration3`.
- `src/simulation.js` — added Pyre Brand cooldown branch in
  `updatePlayers`, `firePyreBrand` weapon body, `triggerWildfireBurst`
  helper (called from death path next to `triggerContagionBurst`), and
  threaded the two new hit fields through `damageEnemy`'s
  `applyAilmentsFromHit` call.
- `src/upgrades.js` — added 4 upgrades and prerequisite chain.
- `tests/ailments.test.js` — added 4 ailment-side tests (weapon hit shape,
  Conflagration I scaling, Conflagration III magnitude bonus, Wildfire
  burst + depth cap).
- `tests/upgrades.test.js` — added Pyre Brand projectile-fire test and
  Conflagration prerequisite-chain test.
- No changes to `src/render.js`, `docs/AILMENTS.md`, or any other file.

`docs/AILMENTS.md` was intentionally left untouched: the new hit fields
(`igniteDotMultiplier`, `scorchMagnitudeBonus`) follow exactly the existing
`poisonDotMultiplier` / `poisonMaxStacks` pattern already documented in the
"Player-side ailment scaling" section.

## Test commands run

```
$ npm test
# tests 116
# pass  116
# fail  0
# duration_ms 1484
```

Real wall time: ~1.6s.

## Constraint checks

- `grep -n "AILMENT_CONFIG\s*=" src/` → only matches the export
  declaration in `src/ailments.js:23`. No runtime mutation.
- `src/ailments.js` has no canvas / render imports added.
- Wildfire burst damage uses `fromAilment: false` so neighbours can be
  freshly ignited — but `wildfireDepth: 1` on the source prevents any
  re-trigger of the burst itself.
- Plague Lance, Virulence chain, and all pre-existing tests still pass.

## Diffstat vs base/ailments

```
 src/ailments.js        |   8 ++-
 src/entities.js        |   5 ++
 src/simulation.js      |  67 +++++++++++++++++++++
 src/upgrades.js        |  21 +++++++
 tests/ailments.test.js | 155 +++++++++++++++++++++++++++++++++++++++++++++++++
 tests/upgrades.test.js |  26 +++++++++
 6 files changed, 281 insertions(+), 1 deletion(-)
```

## Caveats / risks

- Wildfire burst damage is scaled off the ignite stack's `dotPerSecond`,
  which itself can be inflated by Conflagration I. This is intentional
  scaling synergy, but means extreme Cinderbloom + Wildfire combos with
  big base hits can produce moderately large bursts. Burst damage is
  capped per-hop and the radius is small (80 px), so it can't snowball.
- The Pyroclasm scorch bonus is additive after the lerp, so on weak hits
  with no rolled scorch magnitude (or where scorch doesn't roll at all)
  the bonus simply doesn't apply — it doesn't grant scorch by itself.
- Pyre Brand uses a fixed `physical: 8` slice, which means Pyre Brand
  hits can also roll bleed (via the existing physical-source ailment).
  This is consistent with Plague Lance's chaos+physical mix.
