import { describe, expect, it, vi } from "vitest";
import { ensureDashboard } from "../../src/adapters/dashboardLauncher.ts";

const URL = "http://127.0.0.1:4747";

function deps(reachableAfter: number) {
  let probes = 0;
  return {
    isUp: vi.fn(async () => ++probes > reachableAfter),
    start: vi.fn(),
    open: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
}

describe("ensureDashboard", () => {
  it("leaves a dashboard that is already running alone and does not reopen it", async () => {
    const d = deps(0);
    await expect(ensureDashboard(4747, d)).resolves.toEqual({ url: URL, started: false });
    expect(d.start).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
  });

  it("starts it in the background, waits until it answers and opens it in the browser", async () => {
    const d = deps(3);
    await expect(ensureDashboard(4747, d)).resolves.toEqual({ url: URL, started: true });
    expect(d.start).toHaveBeenCalledWith(4747);
    expect(d.open).toHaveBeenCalledWith(URL);
  });

  it("gives up without throwing when it never answers, so the factory run still goes on", async () => {
    const d = deps(Number.POSITIVE_INFINITY);
    await expect(ensureDashboard(4747, d)).resolves.toEqual({ url: URL, started: false, error: expect.stringMatching(/did not answer/) });
    expect(d.open).not.toHaveBeenCalled();
  });

  it("reports a failure to start or open without throwing", async () => {
    const d = { ...deps(1), start: vi.fn(() => { throw new Error("spawn ENOENT"); }) };
    await expect(ensureDashboard(4747, d)).resolves.toMatchObject({ started: false, error: expect.stringMatching(/ENOENT/) });
  });
});
