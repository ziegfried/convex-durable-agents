import type { UIMessage as AIUIMessage } from "ai";
import type { ThreadStatus } from "./types";

// Metadata type for custom fields in UIMessage
export type ConvexUIMessageMetadata = {
  key: string;
  status: ThreadStatus | "success";
  _creationTime: number;
  committedSeq?: number;
};

// // UI-friendly message format using AI SDK's UIMessage with custom metadata
export type UIMessageWithConvexMetadata = AIUIMessage<ConvexUIMessageMetadata>;

export function deepEquals(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!deepEquals(a[key], b[key])) return false;
  }
  return true;
}
