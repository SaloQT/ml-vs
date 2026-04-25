# Space Survivors

A small browser survival game inspired by Vampire Survivors, built as an extendable canvas simulation with multiplayer-friendly state boundaries.

## Run

Use any static file server from this folder:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Controls

- Move with `WASD` or arrow keys.
- Weapons auto-aim based on the targeting configuration.
- Pick one of three upgrades when you level up.
- Toggle the debug inspector with `F3` or the backquote key.

## Targeting

Default targeting lives in `src/config.js`:

```js
export const TARGETING = {
  primaryWeapon: {
    strategy: "nearest",
    enemyTypes: ["drone", "bruiser"],
    maxRange: 1200,
    firingAngleDegrees: 8,
  },
};
```

Available strategies are `nearest`, `lowestHp`, `highestHp`, `highestThreat`, and `random`.
`firingAngleDegrees` controls how closely the ship must face the selected target before it can fire.
You can also override targeting when creating a simulation:

```js
new GameSimulation({
  targeting: {
    primaryWeapon: {
      strategy: "highestThreat",
      enemyTypes: ["bruiser"],
      maxRange: 1400,
      firingAngleDegrees: 6,
    },
  },
});
```

## Visual Options

The main menu Options panel can toggle screen shake, lighting, and particles. Settings persist in `localStorage`.

Defaults live in `src/config.js`:

```js
screenShake: true,
lighting: true,
particles: true,
```

## Progression And PPO

- The Armory menu stores permanent upgrades, scrap, and equipped items in `localStorage`.
- Equipment is split into weapon, hull, and utility slots. Each slot has several sidegrades with visible stat tradeoffs, and invalid saved equipment IDs fall back to the default loadout.
- Scrap is awarded after runs from survival time, kills, wave reached, and salvage bonuses.
- The PPO Lab runs a lightweight policy-gradient trainer against `GameSimulation` and tracks score, damage, kills, survival, and death rate per batch.

## Economy Balance Script

Run deterministic economy samples from the command line:

```bash
npm run balance:economy
```

The script uses `GameSimulation` with several fixed seeds, then prints survival, kills, wave, earned scrap, rough scrap per hour, and starter permanent-upgrade time estimates. You can override the defaults:

```bash
node scripts/economy-balance.mjs --seeds=101,202,303 --seconds=600
```

## Architecture

- `assets/space-survivors-sprites.png` is the generated transparent sprite sheet used by the game.
- `assets/space-survivors-ui.png` is the generated transparent UI icon sheet used by the HUD and upgrade cards.
- `src/assets.js` maps sprite sheet cells to named game assets.
- `src/simulation.js` owns deterministic game state, ticks, inputs, snapshots, spawning, combat, pickups, and leveling.
- `src/entities.js` contains entity factories for players, enemies, projectiles, and pickups.
- `src/targeting.js` contains configurable auto-target selection for weapons.
- `src/upgrades.js` defines rogue-like upgrade data and effects.
- `src/input.js` translates browser input into player input frames.
- `src/render.js` draws snapshots without mutating simulation state.

The multiplayer path is to keep `GameSimulation` authoritative on a host or server, submit per-player input frames through `applyInput`, and broadcast `getSnapshot` output at a lower snapshot rate.
