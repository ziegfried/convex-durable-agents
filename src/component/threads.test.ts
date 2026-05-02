import { beforeEach, describe, expect, it } from "vitest";
import { resetFinalizerMismatchAlertState, trackFinalizerMismatchRate } from "./threads";

describe("trackFinalizerMismatchRate", () => {
  beforeEach(() => {
    resetFinalizerMismatchAlertState();
  });

  it("alerts when mismatch threshold is reached within the window", () => {
    const now = 1_000_000;
    expect(trackFinalizerMismatchRate("thread-a", now)).toEqual({
      windowStartedAt: now,
      count: 1,
      shouldAlert: false,
    });
    expect(trackFinalizerMismatchRate("thread-a", now + 1_000)).toEqual({
      windowStartedAt: now,
      count: 2,
      shouldAlert: false,
    });
    expect(trackFinalizerMismatchRate("thread-a", now + 2_000)).toEqual({
      windowStartedAt: now,
      count: 3,
      shouldAlert: true,
    });
    expect(trackFinalizerMismatchRate("thread-a", now + 3_000)).toEqual({
      windowStartedAt: now,
      count: 4,
      shouldAlert: false,
    });
  });

  it("resets the counter outside the alert window and isolates by thread", () => {
    const now = 2_000_000;
    trackFinalizerMismatchRate("thread-a", now);
    trackFinalizerMismatchRate("thread-a", now + 1_000);
    expect(trackFinalizerMismatchRate("thread-b", now + 1_500)).toEqual({
      windowStartedAt: now + 1_500,
      count: 1,
      shouldAlert: false,
    });
    expect(trackFinalizerMismatchRate("thread-a", now + 6 * 60 * 1_000)).toEqual({
      windowStartedAt: now + 6 * 60 * 1_000,
      count: 1,
      shouldAlert: false,
    });
  });
});
