// ============================================================================
// Usage Tracking
// ============================================================================

export type UsageInfo = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
};

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getNestedNumber(obj: unknown, ...path: string[]): number | undefined {
  let current: unknown = obj;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return numberOrUndefined(current);
}

function getProviderMetadataCacheTokens(providerMetadata: unknown): {
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
} {
  return {
    cacheReadInputTokens: numberOrUndefined(
      getNestedNumber(providerMetadata, "bedrock", "usage", "cacheReadInputTokens") ??
        getNestedNumber(providerMetadata, "bedrock", "usage", "cache_read_input_tokens") ??
        getNestedNumber(providerMetadata, "anthropic", "cacheReadInputTokens") ??
        getNestedNumber(providerMetadata, "anthropic", "cache_read_input_tokens") ??
        getNestedNumber(providerMetadata, "anthropic", "cachedInputTokens"),
    ),
    cacheWriteInputTokens: numberOrUndefined(
      getNestedNumber(providerMetadata, "bedrock", "usage", "cacheWriteInputTokens") ??
        getNestedNumber(providerMetadata, "bedrock", "usage", "cache_write_input_tokens") ??
        getNestedNumber(providerMetadata, "anthropic", "cacheCreationInputTokens") ??
        getNestedNumber(providerMetadata, "anthropic", "cache_creation_input_tokens") ??
        getNestedNumber(providerMetadata, "anthropic", "cacheWriteInputTokens"),
    ),
  };
}

function normalizeUsage(usage: unknown, providerMetadata?: unknown): UsageInfo | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  const inputTokens = numberOrUndefined(u.inputTokens ?? u.promptTokens ?? u.prompt_tokens ?? u.input_tokens);
  const outputTokens = numberOrUndefined(
    u.outputTokens ?? u.completionTokens ?? u.completion_tokens ?? u.output_tokens,
  );
  const totalTokens =
    numberOrUndefined(u.totalTokens ?? u.total_tokens) ??
    (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : undefined);

  if (inputTokens == null || outputTokens == null || totalTokens == null) return null;

  const metadataCache = getProviderMetadataCacheTokens(providerMetadata);

  const reasoningTokens = numberOrUndefined(
    getNestedNumber(u, "outputTokenDetails", "reasoningTokens") ?? u.reasoningTokens ?? u.reasoning_tokens,
  );
  const cachedInputTokens = numberOrUndefined(
    getNestedNumber(u, "inputTokenDetails", "cacheReadTokens") ??
      u.cachedInputTokens ??
      u.cached_input_tokens ??
      u.cacheReadInputTokens ??
      u.cache_read_input_tokens ??
      getNestedNumber(u, "raw", "cache_read_input_tokens") ??
      metadataCache.cacheReadInputTokens,
  );
  const cacheWriteInputTokens = numberOrUndefined(
    getNestedNumber(u, "inputTokenDetails", "cacheWriteTokens") ??
      u.cacheWriteInputTokens ??
      u.cache_write_input_tokens ??
      u.cacheCreationInputTokens ??
      u.cache_creation_input_tokens ??
      getNestedNumber(u, "raw", "cache_creation_input_tokens") ??
      metadataCache.cacheWriteInputTokens,
  );

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
  };
}

export async function getStreamTextProviderMetadata(result: unknown): Promise<unknown | undefined> {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (!("providerMetadata" in r)) return undefined;
  const rawProviderMetadata = r.providerMetadata;
  try {
    const resolvedProviderMetadata =
      rawProviderMetadata && typeof rawProviderMetadata === "object" && "then" in (rawProviderMetadata as any)
        ? await (rawProviderMetadata as any)
        : rawProviderMetadata;
    return resolvedProviderMetadata ?? undefined;
  } catch {
    return undefined;
  }
}

export async function getStreamTextUsage(result: unknown, providerMetadata?: unknown): Promise<UsageInfo | null> {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (!("usage" in r)) return null;
  const rawUsage = r.usage;
  try {
    const resolvedUsage =
      rawUsage && typeof rawUsage === "object" && "then" in (rawUsage as any) ? await (rawUsage as any) : rawUsage;
    return normalizeUsage(resolvedUsage, providerMetadata);
  } catch {
    return null;
  }
}
