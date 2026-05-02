import { describe, expect, it } from "vitest";
import { isToolInputAvailablePart } from "./messages";

describe("isToolInputAvailablePart", () => {
  it("returns true for tool input available objects", () => {
    expect(
      isToolInputAvailablePart({
        toolCallId: "tool-call-1",
        state: "input-available",
      }),
    ).toBe(true);
  });

  it("returns false for non-object values", () => {
    expect(isToolInputAvailablePart(null)).toBe(false);
    expect(isToolInputAvailablePart("tool-call-1")).toBe(false);
    expect(isToolInputAvailablePart(123)).toBe(false);
    expect(isToolInputAvailablePart(true)).toBe(false);
  });

  it("returns false when required fields are missing or invalid", () => {
    expect(
      isToolInputAvailablePart({
        state: "input-available",
      }),
    ).toBe(false);
    expect(
      isToolInputAvailablePart({
        toolCallId: 123,
        state: "input-available",
      }),
    ).toBe(false);
    expect(
      isToolInputAvailablePart({
        toolCallId: "tool-call-1",
        state: "output-available",
      }),
    ).toBe(false);
  });
});
