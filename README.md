# Space Survivors

A browser-based arena survival game with deterministic simulation, persistent Armory progression, enemy/boss variety, timed overrun events, and an in-browser PPO training lab.

The project is intentionally lightweight: it is plain JavaScript modules, Canvas rendering, local assets, and Node's built-in test runner.

## Features

- **Playable arena survivor loop**: move, aim, collect pickups, level up, choose upgrades, and survive escalating waves.
- **30-minute victory and overrun mode**: normal runs can end in victory, while overrun mode keeps scaling difficulty past the standard run length.
- **Bosses, elites, and special enemies**: splitters, spitters, bulwarks, chargers, siphons, wardens, rare affixes, scheduled bosses, boss portraits, and spawn telegraphs.
- **Timed run events**: lane sweeps, reward caches, warning HUD, cache collapse effects, and deterministic event scheduling.
- **Persistent Armory**: permanent upgrades with prestige-style progression, scrap economy, and equipment pages for weapons, hulls, and utility rigs.
- **Weapon and upgrade depth**: pierce, chain lightning, ricochet, splash, shield mechanics, pickup modifiers, economy upgrades, and defensive panic tools.
- **PPO Lab**: train and watch a lightweight policy-gradient agent using the same simulation rules as the player, including fixed-step timing and run events.
- **Worker-backed PPO rollouts**: optional parallel browser workers for faster PPO batches.
- **Deterministic tests and scripts**: Node test coverage for simulation, drops, weapons, gear, upgrades, run events, and PPO behavior.
- **Static deploy ready**: serve it locally or upload the static files to Netlify Drop, GitHub Pages, or any static host.

## Requirements

- Node.js 20+ recommended.
- A modern browser with JavaScript modules and Canvas support.
- No npm dependencies are required for the current project.

## Run Locally

From the repo root:

```bash
npm run serve
```

Then open the URL printed by the dev server, usually:

```text
http://localhost:4173
```

You can also use any static file server:

```bash
python3 -m http.server 4173
```

## Controls

- Move: `WASD` or arrow keys.
- Aim: mouse, right stick, or auto-aim depending on input mode.
- Upgrade selection: click an upgrade card when leveling pauses the run.
- Debug inspector: `F3` or backquote.
- Armory/PPO panels: available from the main menu.

## Testing

Run the full suite:

```bash
npm test
```

The tests use Node's built-in test runner and cover deterministic simulation behavior, pickup/drop rules, weapon mechanics, Armory progression, run events, and PPO training paths.

## PPO Training

Run deterministic PPO benchmarks:

```bash
npm run ppo:benchmark -- --batches=6 --batch-size=4
```

Run longer command-line training:

```bash
npm run ppo:train -- --batches=20 --batch-size=8
```

The browser PPO Lab can also train from the UI, export/import models, adjust reward weights, and use rollout workers.

## Economy Sampling

Run deterministic economy samples:

```bash
npm run balance:economy
```

With custom seeds and duration:

```bash
node scripts/economy-balance.mjs --seeds=101,202,303 --seconds=600
```

## Project Structure

- `index.html` - app shell and UI panels.
- `styles.css` - game UI, menu, Armory, HUD, and lab styling.
- `assets/` - sprite sheets, UI icons, Armory icons, enemy sprites, boss art, and portraits.
- `src/simulation.js` - deterministic game state, spawning, combat, events, pickups, leveling, and snapshots.
- `src/entities.js` - factories for players, enemies, projectiles, pickups, and effects.
- `src/render.js` - Canvas rendering for world, HUD, bosses, telegraphs, and UI effects.
- `src/input.js` - keyboard/mouse/gamepad input and target mode handling.
- `src/upgrades.js` - in-run upgrade catalog and effects.
- `src/metaProgression.js` - Armory economy, permanent upgrades, equipment, migration, and prestige helpers.
- `src/ppoTrainer.js` - PPO model, rollout, reward shaping, import/export, and training logic.
- `src/ppoWorkerPool.js` / `src/ppoRolloutWorker.js` - browser worker rollout support.
- `scripts/` - local dev server, PPO CLI, benchmark, economy sampler, and asset helpers.
- `tests/` - Node test suite.

## Deployment

This is a static app. Deploy these paths to any static host:

```text
index.html
styles.css
src/
assets/
```

For Netlify Drop, zip or drag those files/folders from the repo root. Generated deployment folders such as `netlify-drop/` and `netlify-drop.zip` are intentionally ignored.

## Notes

- Save data lives in browser `localStorage`.
- The simulation is built so browser play, PPO rollouts, tests, and future multiplayer/server work can share the same authoritative rules.
- The repo does not include generated model output such as `ppo-model.json`.
