import type { UIMessageChunk } from "ai";
import type { ComponentApi } from "../component/_generated/component";
import type { Doc, Id } from "../component/_generated/dataModel";
import type { ActionCtx } from "./types";

export class Streamer {
  #enableDeltaStreaming = false;
  #msgId: string | undefined;
  #inflight: Promise<void> | undefined;
  #queue: Array<UIMessageChunk> = [];
  #flushTimeout: NodeJS.Timeout | undefined;
  #seq = 0;

  constructor(
    public readonly component: ComponentApi,
    public readonly ctx: ActionCtx,
    public readonly config: {
      throttleMs: number;
      lockId: string;
      threadId: Id<"threads">;
      streamId: Id<"streams">;
    },
  ) {}

  async start(): Promise<Doc<"streams">> {
    const stream = await this.ctx.runMutation(this.component.streams.take, {
      threadId: this.config.threadId,
      streamId: this.config.streamId,
      lockId: this.config.lockId,
    });

    const thread = await this.ctx.runQuery(this.component.threads.get, { threadId: this.config.threadId });

    if (thread?.streamId !== stream._id) {
      throw new Error(`Thread ${this.config.threadId} active stream mismatch: ${thread?.streamId} !== ${stream._id}`);
    }

    return stream;
  }

  enableDeltaStreaming(): void {
    this.#enableDeltaStreaming = true;
  }

  async setMessageId(msgId: string | undefined, _existingMessage: boolean): Promise<void> {
    if (this.#msgId && this.#msgId !== msgId) {
      await this.flush();
    }
    this.#msgId = msgId;
    this.#seq = 0;
  }

  async process(part: UIMessageChunk): Promise<void> {
    if (this.#enableDeltaStreaming) {
      this.#queue.push(part);
      if (this.#flushTimeout == null) {
        this.#flushTimeout = setTimeout(() => this.flush(), this.config.throttleMs);
      }
    }
  }

  async flush(): Promise<void> {
    if (this.#flushTimeout != null) clearTimeout(this.#flushTimeout);
    this.#flushTimeout = undefined;
    if (this.#inflight != null) return this.#inflight.then(() => this.flush());

    this.#inflight = this.#flush();
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#inflight.finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #flush(): Promise<void> {
    if (this.#queue.length === 0) return;
    if (this.#msgId == null) throw new Error("Received chunks without message ID");
    try {
      const queue = this.#queue;
      this.#queue = [];
      await this.ctx.runMutation(this.component.streams.addDelta, {
        streamId: this.config.streamId,
        lockId: this.config.lockId,
        parts: compactQueue(queue),
        seq: this.#seq++,
        msgId: this.#msgId,
      });
    } catch (e) {
      console.error("Error in streamer flush:", e);
      throw e;
    }
  }

  async finish(): Promise<void> {
    if (this.#enableDeltaStreaming) {
      await this.flush();
    }
    await this.ctx.runMutation(this.component.streams.finish, {
      streamId: this.config.streamId,
    });
  }

  async fail(reason: string): Promise<void> {
    await this.ctx.runMutation(this.component.streams.abort, {
      streamId: this.config.streamId,
      reason,
    });
  }
}

export function compactQueue(queue: Array<UIMessageChunk>): Array<UIMessageChunk> {
  return joinAdjacentDeltas(queue.filter((part) => !(part.type === "tool-input-delta")).map(dropUnnecessaryInfo));
}

export function dropUnnecessaryInfo(chunk: UIMessageChunk): UIMessageChunk {
  let copy: UIMessageChunk | undefined;
  if ("providerMetadata" in chunk) {
    copy ||= structuredClone(chunk);
    delete (copy as any).providerMetadata;
  }
  return copy ?? chunk;
}

export function joinAdjacentDeltas(queue: Array<UIMessageChunk>): Array<UIMessageChunk> {
  if (queue.length === 0) return [];
  const result: Array<UIMessageChunk> = [];
  for (const chunk of queue) {
    if ((chunk.type === "text-delta" || chunk.type === "reasoning-delta") && result.length > 0) {
      const prev = result[result.length - 1]!;
      if (prev.type === chunk.type && "id" in prev && prev.id === chunk.id) {
        result[result.length - 1] = { ...prev, delta: prev.delta + chunk.delta };
        continue;
      }
    }
    result.push(chunk);
  }
  return result;
}
