// @vitest-environment happy-dom
/**
 * Component-level tests for `<CronSection />` — the per-project scheduled-jobs
 * panel. Render coverage for a previously-untested 713-LOC component (QA audit
 * F-03). We pin the load contract that's most visible to the user:
 *
 *   - On mount it fetches the project's cron status + job list and renders the
 *     jobs (name + schedule summary).
 *   - With no jobs it shows the empty state rather than a blank pane.
 *
 * The create/toggle/run/delete mutations (each its own fetch) are a follow-up;
 * the high-value, low-brittleness slice is the mount → list render pinned here.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CronSection } from "./cron-section";

function stubCronFetch(jobs: unknown[], status: unknown = {}) {
  const fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    // Order matters: the status URL also contains "/cron".
    if (u.includes("/cron/status")) {
      return { ok: true, json: async () => status } as unknown as Response;
    }
    if (u.includes("/cron")) {
      return { ok: true, json: async () => ({ jobs }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const sampleJob = {
  id: "job-1",
  projectId: "p-1",
  name: "Nightly summary",
  enabled: true,
  createdAtMs: 0,
  updatedAtMs: 0,
  schedule: { kind: "every", everyMs: 3600000 },
  payload: { kind: "agentTurn", message: "summarize the day" },
  state: {},
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<CronSection /> — mount fetch + job list render", () => {
  it("fetches the project's cron jobs on mount and renders them", async () => {
    const fetchMock = stubCronFetch([sampleJob]);

    render(<CronSection projectId="p-1" />);

    expect(await screen.findByText("Nightly summary")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p-1/cron?includeDisabled=true"
    );
  });

  it("shows the empty state when the project has no cron jobs", async () => {
    stubCronFetch([]);

    render(<CronSection projectId="p-1" />);

    expect(await screen.findByText(/No cron jobs yet/i)).toBeTruthy();
  });
});
