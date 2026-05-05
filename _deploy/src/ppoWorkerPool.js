export class PpoWorkerPool {
  constructor({ workerCount = defaultWorkerCount(), workerUrl = new URL("./ppoRolloutWorker.js", import.meta.url) } = {}) {
    this.workerUrl = workerUrl;
    this.workerCount = workerCount;
    this.workers = [];
    this.nextJobId = 1;
  }

  get supported() {
    return typeof Worker !== "undefined" && this.workerCount > 0;
  }

  setWorkerCount(workerCount) {
    const nextCount = clampWorkerCount(workerCount, defaultWorkerCount());
    if (nextCount < this.workers.length) {
      for (const worker of this.workers.splice(nextCount)) worker?.terminate();
    }
    this.workerCount = nextCount;
    return this.workerCount;
  }

  async runEpisodes(trainer, batchSize = trainer.batchSize) {
    if (!this.supported) throw new Error("PPO Web Workers are not available in this browser.");
    const seeds = trainer.batchSeeds(batchSize);
    const chunks = chunkSeeds(seeds, Math.min(this.workerCount, seeds.length));
    const trainingState = trainer.exportTrainingState();
    const startedAt = performance.now();
    const results = await Promise.all(chunks.map((chunk, index) => this.runWorkerJob(index, trainingState, chunk)));
    return {
      episodes: results.flatMap((result) => result.episodes),
      elapsedMs: Math.max(0.001, performance.now() - startedAt),
      workerElapsedMs: Math.max(0.001, ...results.map((result) => result.elapsedMs)),
      workers: chunks.length,
    };
  }

  terminate() {
    for (const worker of this.workers) worker?.terminate();
    this.workers = [];
  }

  runWorkerJob(index, trainingState, seeds) {
    const worker = this.workerAt(index);
    const id = this.nextJobId;
    this.nextJobId += 1;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      const onMessage = (event) => {
        const message = event.data ?? {};
        if (message.id !== id) return;
        cleanup();
        if (message.type === "error") reject(new Error(message.error ?? "PPO worker failed."));
        else resolve({ episodes: message.episodes ?? [], elapsedMs: message.elapsedMs ?? 0 });
      };
      const onError = (event) => {
        cleanup();
        reject(new Error(event.message || "PPO worker failed."));
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage({ id, type: "runEpisodes", trainingState, seeds });
    });
  }

  workerAt(index) {
    if (!this.workers[index]) {
      this.workers[index] = new Worker(this.workerUrl, { type: "module", name: `ppo-rollout-${index + 1}` });
    }
    return this.workers[index];
  }
}

function chunkSeeds(seeds, count) {
  const chunks = Array.from({ length: count }, () => []);
  for (let i = 0; i < seeds.length; i += 1) chunks[i % count].push(seeds[i]);
  return chunks.filter((chunk) => chunk.length > 0);
}

function defaultWorkerCount() {
  const cores = Number(globalThis.navigator?.hardwareConcurrency ?? 2);
  return Math.max(1, Math.min(6, Math.floor(cores) - 1 || 1));
}

function clampWorkerCount(value, fallback) {
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? Math.max(1, Math.min(12, count)) : fallback;
}
