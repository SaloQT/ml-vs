// Node worker_threads pool for PPO rollouts.
//
// Mirrors src/ppoWorkerPool.js (Web Worker, browser-only) but uses
// node:worker_threads. Each worker holds a PpoTrainer + its own ORT-CPU
// session (single-threaded — see src/ortMlp.js comment about avoiding
// threadpool contention; W workers each running single-threaded ORT is the
// configuration that lets us actually scale).
//
// Browser path is unaffected: PpoWorkerPool stays as the browser-side pool
// using Web Workers + the JS-only rollout (onnxruntime-node is Node-only).
// (Follow-up: onnxruntime-web could give the browser a similar win, but
// that's not implemented here.)

import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./ppoNodeRolloutWorker.js", import.meta.url);

export class PpoNodeWorkerPool {
  constructor({ workerCount = defaultWorkerCount() } = {}) {
    this.workerCount = Math.max(1, workerCount | 0);
    this.workers = [];
    this.nextJobId = 1;
  }

  get supported() {
    return this.workerCount > 0;
  }

  setWorkerCount(workerCount) {
    const next = Math.max(1, workerCount | 0);
    if (next < this.workers.length) {
      for (const worker of this.workers.splice(next)) worker?.terminate();
    }
    this.workerCount = next;
    return this.workerCount;
  }

  async runEpisodes(trainer, batchSize = trainer.batchSize) {
    const seeds = trainer.batchSeeds(batchSize);
    const W = Math.min(this.workerCount, seeds.length);
    const chunks = chunkSeeds(seeds, W);
    const trainingState = trainer.exportTrainingState();
    const startedAt = performance.now();
    const results = await Promise.all(
      chunks.map((chunk, index) => this.runWorkerJob(index, trainingState, chunk)),
    );
    return {
      episodes: results.flatMap((r) => r.episodes),
      elapsedMs: Math.max(0.001, performance.now() - startedAt),
      workerElapsedMs: Math.max(0.001, ...results.map((r) => r.elapsedMs)),
      workers: chunks.length,
    };
  }

  // Wrap runEpisodes with the rest of the trainBatch path (rewards baseline +
  // policy update on the main thread). Mirrors PpoTrainer.trainBatch.
  async trainBatch(trainer, batchSize = trainer.batchSize) {
    const startedAt = performance.now();
    const { episodes } = await this.runEpisodes(trainer, batchSize);
    const elapsedMs = Math.max(0.001, performance.now() - startedAt);
    return trainer.trainBatchFromEpisodes(episodes, elapsedMs);
  }

  terminate() {
    for (const worker of this.workers) worker?.terminate();
    this.workers = [];
  }

  runWorkerJob(index, trainingState, seeds) {
    const worker = this.workerAt(index);
    const id = this.nextJobId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
      };
      const onMessage = (message) => {
        if (!message || message.id !== id) return;
        cleanup();
        if (message.type === "error") reject(new Error(message.error ?? "PPO node worker failed."));
        else resolve({ episodes: message.episodes ?? [], elapsedMs: message.elapsedMs ?? 0 });
      };
      const onError = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.postMessage({ id, type: "runEpisodes", trainingState, seeds });
    });
  }

  workerAt(index) {
    if (!this.workers[index]) {
      this.workers[index] = new Worker(fileURLToPath(WORKER_URL), {
        name: `ppo-rollout-${index + 1}`,
      });
      this.workers[index].setMaxListeners(0);
    }
    return this.workers[index];
  }
}

function chunkSeeds(seeds, count) {
  if (count <= 1) return [seeds.slice()];
  const chunks = Array.from({ length: count }, () => []);
  // Contiguous chunks (not round-robin) — preserves locality for the per-tick
  // batched forward inside each worker; ordering of returned episodes doesn't
  // matter because trainBatchFromEpisodes treats them as a multiset.
  const per = Math.ceil(seeds.length / count);
  for (let i = 0; i < seeds.length; i += 1) {
    const idx = Math.min(count - 1, Math.floor(i / per));
    chunks[idx].push(seeds[i]);
  }
  return chunks.filter((c) => c.length > 0);
}

export function defaultWorkerCount() {
  const cpus = os.cpus()?.length ?? 2;
  return Math.max(1, Math.min(8, cpus - 1));
}

// Recommended (W, M) split: cap per-worker M near the ORT sweet spot (~256).
// If batchSize would push M above 256, add workers; if it would drop M below
// 32, drop workers.
export function recommendSplit(batchSize, requestedWorkers = defaultWorkerCount()) {
  const targetM = 256;
  const minM = 32;
  let W = Math.max(1, Math.min(requestedWorkers, Math.ceil(batchSize / targetM)));
  let M = Math.ceil(batchSize / W);
  while (M < minM && W > 1) {
    W -= 1;
    M = Math.ceil(batchSize / W);
  }
  return { W, M };
}
