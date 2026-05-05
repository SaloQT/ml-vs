// Node worker_threads rollout worker for PPO.
//
// One worker thread = one PpoTrainer instance + one ORT session (single-
// threaded inside ORT, see src/ortMlp.js). On each "runEpisodes" message we
// import the latest weights into the trainer and run runEpisodeBatchVectorized
// over M seeds. The ORT session is reused across messages — it's lazily
// initialized on the first call to runEpisodeBatchVectorized and cached on the
// trainer instance, so subsequent calls skip session creation.

import { parentPort } from "node:worker_threads";
import { PpoTrainer } from "./ppoTrainer.js";

if (!parentPort) {
  throw new Error("ppoNodeRolloutWorker.js must be run as a worker_threads worker");
}

const trainer = new PpoTrainer();
trainer.useVectorizedRollout = true;

parentPort.on("message", async (message) => {
  if (!message || message.type !== "runEpisodes") return;
  const { id, trainingState, seeds } = message;
  try {
    if (trainingState) trainer.importTrainingState(trainingState);
    const startedAt = performance.now();
    const episodes = await trainer.runEpisodeBatchVectorized(seeds ?? []);
    parentPort.postMessage({
      id,
      type: "episodes",
      episodes,
      elapsedMs: Math.max(0.001, performance.now() - startedAt),
    });
  } catch (error) {
    parentPort.postMessage({
      id,
      type: "error",
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
  }
});
