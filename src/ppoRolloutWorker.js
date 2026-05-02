import { PpoTrainer } from "./ppoTrainer.js";

globalThis.onmessage = (event) => {
  const message = event.data ?? {};
  if (message.type !== "runEpisodes") return;
  try {
    const trainer = new PpoTrainer();
    trainer.importTrainingState(message.trainingState);
    const startedAt = performance.now();
    const episodes = trainer.runEpisodeBatch(message.seeds ?? []);
    globalThis.postMessage({
      id: message.id,
      type: "episodes",
      episodes,
      elapsedMs: Math.max(0.001, performance.now() - startedAt),
    });
  } catch (error) {
    globalThis.postMessage({
      id: message.id,
      type: "error",
      error: error instanceof Error ? error.message : "PPO worker failed.",
    });
  }
};
