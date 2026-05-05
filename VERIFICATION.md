# Verification — Cold Archetype (Rime Lance + Glaciation)

## Design summary

A coherent slow → freeze → shatter → brittle-crit fantasy:

- **Rime Lance** (rare, base weapon): cold lance projectile, breakdown
  `{ physical: 10, cold: 22 }`, pierce 2, fires every ~1.67s. Chill /
  freeze / brittle roll naturally through the centralized
  `applyAilmentsFromHit` pipeline; nothing in the weapon code rolls
  ailments directly.
- **Glaciation I — Permafrost** (rare): Rime Lance hits deal +35% damage
  to enemies carrying any cold-tag ailment (chill, freeze, or brittle).
  Implemented as a `frostbite` + `permafrostBonus` flag on the projectile
  consumed inside `damageEnemy`.
- **Glaciation II — Shatterpoint** (epic): Rime Lance hits on a frozen
  *or brittle* target trigger a cold AoE shatter burst. The burst is
  emitted via `damageEnemy` with `fromAilment: true` so it cannot
  re-apply ailments. Because brittle has no boss/elite resistance, the
  burst still rewards play vs freeze-immune bosses.
- **Glaciation III — Cryoclasm** (epic): critical Rime Lance hits double
  the shatter burst (`shatterCritMultiplier: 2`) and the lance applies
  brittle with +0.10 magnitude (threaded as `hit.brittleMagnitudeBonus`
  through `applyAilmentsFromHit`).

## Files touched

- `src/entities.js` — added `rimeLanceCooldown`, `rimeLanceLevel`, three
  `glaciation*` stat fields, and projectile metadata fields
  (`frostbite`, `permafrostBonus`, `shatterpoint`, `shatterRadius`,
  `shatterDamage`, `shatterCritMultiplier`, `cryoclasmBrittleBonus`).
- `src/upgrades.js` — added `rime-lance`, `glaciation-1`, `glaciation-2`,
  `glaciation-3` mirroring the Plague Lance / Virulence shape.
- `src/simulation.js` — Rime Lance fire path, frostbite damage multiplier
  in `damageEnemy`, shatter trigger after damage application, helper
  methods `enemyHasColdAilment`, `enemyIsShatterable`,
  `triggerShatterBurst`, `fireRimeLance`. Threaded
  `cryoclasmBrittleBonus` → `brittleMagnitudeBonus` into
  `applyAilmentsFromHit`.
- `src/ailments.js` — single addition: when applying brittle, fold
  `hit.brittleMagnitudeBonus` into the rolled magnitude (clamped to 1).
  No new UI / render code.
- `tests/upgrades.test.js` — 7 new tests covering weapon spawn,
  prerequisite chain, projectile metadata under all tiers, Permafrost
  damage bonus on chilled targets, Shatterpoint burst (incl. assertion
  that it does not freeze neighbours), Shatterpoint payoff on brittle
  freeze-immune boss, and Cryoclasm brittle-magnitude bump.
- `docs/AILMENTS.md` — documented the new hit/source flags
  (`brittleMagnitudeBonus`, `frostbite`/`permafrostBonus`,
  `shatterpoint` + `shatterRadius`/`shatterDamage`/
  `shatterCritMultiplier`, `cryoclasmBrittleBonus`).
- `VERIFICATION.md` — this file.

## Hard-constraint audit

- ✅ `applyAilmentsFromHit` remains the only ailment application site —
  Rime Lance and shatter rely on it.
- ✅ `AILMENT_CONFIG` is never mutated at runtime
  (`grep -n "AILMENT_CONFIG\s*=" src/` returns only the export
  declaration in `src/ailments.js`).
- ✅ Shatter secondary damage carries `fromAilment: true` so it cannot
  recursively roll ailments — verified in test
  `Shatterpoint burst hits neighbours, sets fromAilment so it cannot
  re-apply ailments`.
- ✅ Boss/elite freeze immunity is honoured — the cold lance still rolls
  freeze through the central pipeline (which gates on rank). Brittle has
  no rank gate, so the shatter payoff still triggers on a brittle boss
  (`Shatterpoint payoff still works on freeze-immune bosses via
  brittle`).
- ✅ `src/ailments.js` has no UI/render additions; the only edit is the
  pure-logic brittle-magnitude bonus inside `applyAilmentsFromHit`.
- ✅ `src/render.js` untouched — existing `getActiveAilmentDisplay` /
  `AILMENT_DISPLAY` cover all visible cold ailments (chill/freeze/
  brittle) already.

## Test commands and results

```
$ npm test
# tests 117
# pass 117
# fail 0
# duration_ms ≈ 1437
```

All 117 tests pass (110 pre-existing + 7 new). Runtime ≈ 1.4 s. The
`validateAilmentConfig()` test in `tests/ailments.test.js` continues to
pass, confirming that no config invariants were broken.

## Diffstat

```
$ git diff --stat HEAD
 src/ailments.js        |   5 +-
 src/entities.js        |  12 ++
 src/simulation.js      | 106 +++++++++++++-
 src/upgrades.js        |  21 +++
 tests/upgrades.test.js | 161 ++++++++++++++++++++
 5 files changed, 303 insertions(+), 2 deletions(-)
```

(plus `docs/AILMENTS.md` and `VERIFICATION.md`.)

## Caveats / risks

- The Permafrost damage bonus (`frostbiteMultiplier` in `damageEnemy`)
  is checked on every hit, not only on Rime Lance hits — but it is gated
  by `source.frostbite`, which only Rime Lance projectiles set. Other
  cold sources (e.g. future weapons) can opt-in by setting the same
  flag.
- The shatter burst includes the originating enemy in its target list
  so a brittle (but not yet dead) boss takes the burst as well as the
  lance hit. This is intentional for the freeze-immune payoff.
- Brittle's pre-existing `applyBrittleCrit` runs before `damageEnemy`,
  so a brittle-converted critical Rime Lance hit will already have
  `source.isCritical = true` when shatter fires, correctly doubling
  the burst under Cryoclasm. This is exercised indirectly by the
  metadata test (`shatterCritMultiplier` is propagated) but no
  end-to-end brittle→crit→shatter×2 scenario test was added; the path
  is covered by the existing brittle test plus the metadata
  propagation test.
