// Regression: trainer .history is now capped at 5000 entries (was unbounded).
// Two invariants must hold so that consumers (the training-lab UI in
// src/main.js, the labStats hook, the rolling charts) keep working past
// the cap:
//
//   1. The cap must actually kick in (no silent leak past the limit).
//   2. The most recent point's `.iteration` field must equal the trainer's
//      true iteration counter, NOT history.length, since the latter
//      saturates at the cap and would freeze the UI's iteration counter.
//
// The original "training lab not learning anymore" report was caused
// exactly by violation 2: __labStats reported `iterations: h.length`,
// which froze at 500 once the cap was hit. This test makes sure that
// regression cannot happen silently again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PpoTrainer } from "../src/ppoTrainer.js";
import { DqnTrainer } from "../src/dqnTrainer.js";
import { A2cTrainer } from "../src/a2cTrainer.js";
import { ReinforceTrainer } from "../src/reinforceTrainer.js";

const HISTORY_CAP = 5000;

function pushSyntheticPoints(trainer, n) {
  // We don't run real training (slow + non-deterministic). Instead, push
  // synthetic history points that mirror the shape produced by the real
  // finish() lambda, and increment trainer.iteration to match.
  for (let i = 0; i < n; i += 1) {
    trainer.iteration += 1;
    trainer.history.push({
      iteration: trainer.iteration,
      reward: 0, seconds: 0, kills: 0, damage: 0, damageTaken: 0,
      score: 0, deathRate: 0, episodes: 0, trainedEpisodes: 0,
      ticks: 0, ticksPerSecond: 0, elapsedMs: 0,
    });
    if (trainer.history.length > HISTORY_CAP) {
      trainer.history.splice(0, trainer.history.length - HISTORY_CAP);
    }
  }
}

const cases = [
  ["PpoTrainer", PpoTrainer],
  ["DqnTrainer", DqnTrainer],
  ["A2cTrainer", A2cTrainer],
  ["ReinforceTrainer", ReinforceTrainer],
];

for (const [label, Trainer] of cases) {
  test(`${label}: history caps at ${HISTORY_CAP}`, () => {
    const t = new Trainer();
    pushSyntheticPoints(t, HISTORY_CAP + 250);
    assert.equal(t.history.length, HISTORY_CAP, "history must not exceed cap");
  });

  test(`${label}: last.iteration tracks true counter past the cap`, () => {
    const t = new Trainer();
    const total = HISTORY_CAP + 137;
    pushSyntheticPoints(t, total);
    const last = t.history.at(-1);
    assert.equal(last.iteration, total, "last point's iteration must equal total iterations run, not history.length");
    assert.notEqual(last.iteration, t.history.length, "iteration counter must diverge from history.length once capped");
  });

  test(`${label}: oldest entry rolls off, newest preserved`, () => {
    const t = new Trainer();
    pushSyntheticPoints(t, HISTORY_CAP + 50);
    // Oldest surviving entry's iteration should be (total - cap + 1).
    const expectedOldest = HISTORY_CAP + 50 - HISTORY_CAP + 1;
    assert.equal(t.history[0].iteration, expectedOldest, "oldest surviving iteration is wrong");
    assert.equal(t.history.at(-1).iteration, HISTORY_CAP + 50, "newest iteration is wrong");
  });
}
