import os from "os";

/**
 * A simple asynchronous Semaphore to limit concurrent execution of heavy tasks.
 * Prevents VRAM exhaustion (Out-Of-Memory) when Ollama receives parallel LLM requests.
 */
export class Semaphore {
  private permits: number;
  private totalPermits: number;
  private readonly maxQueue: number;
  private queue: Array<() => void> = [];

  constructor(permits: number, maxQueue = 200) {
    this.permits = permits;
    this.totalPermits = permits;
    this.maxQueue = maxQueue;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      throw new Error(
        `[Semaphore] Queue full (${this.maxQueue} tasks waiting). ` +
        "The system is overloaded. Please wait for running tasks to finish."
      );
    }
    console.log("[Semaphore] Task added to queue. Waiting for available permits...");
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        // Run next in macro-task queue to avoid deep stack limits
        setTimeout(next, 0);
      }
    } else {
      this.permits++;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  getPermits(): number {
    return this.permits;
  }

  getTotalPermits(): number {
    return this.totalPermits;
  }
}

/**
 * Calculates the recommended number of parallel local LLM inferences 
 * based on total system RAM (which is shared with VRAM on Apple Silicon).
 */
function getRecommendedPermits(): number {
  try {
    // Robust check for Node environment and 'os' availability
    if (typeof process === 'undefined' || process.release?.name !== 'node') {
      return 2;
    }
    
    const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);
    
    // Scale concurrency based on RAM tiers
    if (totalMemoryGB <= 9) return 1;    // 8GB: Strictly sequential
    if (totalMemoryGB <= 18) return 2;   // 16GB: Moderate (default)
    if (totalMemoryGB <= 36) return 4;   // 32GB: Performance
    if (totalMemoryGB <= 72) return 8;   // 64GB: High-end
    if (totalMemoryGB <= 144) return 12; // 128GB: Workstation
    if (totalMemoryGB > 144) return 16;  // 192GB+: Ultra
    
    return 2; // Fallback
  } catch (err) {
    console.warn("[Semaphore] Failed to detect system memory, falling back to 2 permits:", err);
    return 2;
  }
}

const permits = getRecommendedPermits();
if (typeof process !== 'undefined' && process.release?.name === 'node') {
  console.log(`[Semaphore] System memory detected. Initializing agent semaphore with ${permits} permits.`);
}

// Global semaphore: Limits local model parallel inference to prevent system instability.
export const agentSemaphore = new Semaphore(permits);

