// ============================================================================
// Serialization Helpers
// ============================================================================

/**
 * Recursively serialize an object for Convex storage.
 * Converts Date objects to ISO strings and handles nested objects/arrays.
 */
export function serializeForConvex(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeForConvex);
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = serializeForConvex(val);
    }
    return result;
  }
  return value;
}
