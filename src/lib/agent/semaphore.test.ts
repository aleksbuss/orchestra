/**
 * semaphore.test.ts — Comprehensive Semaphore Tests
 *
 * The Semaphore prevents VRAM exhaustion by limiting concurrent LLM calls.
 * Correctness here is critical for system stability under load.
 */
import { describe, it, expect, vi } from "vitest";
import { Semaphore } from "@/lib/agent/semaphore";

describe("Semaphore", () => {
  describe("Basic acquire/release", () => {
    it("should resolve acquire immediately when permits are available", async () => {
      const sem = new Semaphore(2);
      await expect(sem.acquire()).resolves.toBeUndefined();
    });

    it("should block on acquire when no permits remain, and unblock after release", async () => {
      const sem = new Semaphore(1);
      await sem.acquire(); // uses the only permit

      let secondResolved = false;
      const second = sem.acquire().then(() => {
        secondResolved = true;
      });

      // Should not have resolved yet
      expect(secondResolved).toBe(false);

      sem.release(); // frees the permit
      await second;

      expect(secondResolved).toBe(true);
    });

    it("release should increment permits when queue is empty", async () => {
      const sem = new Semaphore(1);
      sem.release(); // should increment permits from 1 to 2
      // Now two acquires should resolve immediately
      await sem.acquire();
      await sem.acquire();
    });
  });

  describe("run()", () => {
    it("should execute the function and return its result", async () => {
      const sem = new Semaphore(2);
      const result = await sem.run(async () => "hello semaphore");
      expect(result).toBe("hello semaphore");
    });

    it("should release the permit even when the function throws", async () => {
      const sem = new Semaphore(1);

      await expect(
        sem.run(async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      // The permit should have been released; this should resolve immediately
      await expect(sem.run(async () => "recovered")).resolves.toBe("recovered");
    });

    it("should limit concurrency to the semaphore's permit count", async () => {
      const PERMITS = 2;
      const sem = new Semaphore(PERMITS);
      let concurrent = 0;
      let maxConcurrent = 0;
      const TASKS = 8;

      const tasks = Array.from({ length: TASKS }, () =>
        sem.run(async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          // Simulate async work
          await new Promise((r) => setTimeout(r, 5));
          concurrent--;
        })
      );

      await Promise.all(tasks);

      expect(maxConcurrent).toBeLessThanOrEqual(PERMITS);
      expect(concurrent).toBe(0); // all tasks released
    });

    it("should process all queued tasks in FIFO order", async () => {
      const sem = new Semaphore(1);
      const order: number[] = [];

      const tasks = [1, 2, 3, 4, 5].map((n) =>
        sem.run(async () => {
          order.push(n);
        })
      );

      await Promise.all(tasks);
      expect(order).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("agentSemaphore", () => {
    it("should be initialized with 2 permits (global export)", async () => {
      const { agentSemaphore } = await import("@/lib/agent/semaphore");
      // Verify it allows 2 concurrent acquires
      await agentSemaphore.acquire();
      await agentSemaphore.acquire();
      // Release both to restore state
      agentSemaphore.release();
      agentSemaphore.release();
    });
  });
});
