import type { UIMessageChunk } from "ai";
import type { ComponentApi } from "../component/_generated/component";
import type { Doc, Id } from "../component/_generated/dataModel";
import { Logger } from "../logger";
import type { ActionCtx } from "./types";

export class Streamer {
  #enableDeltaStreaming = false;
  #msgId: string | undefined;
  #inflight: Promise<void> | undefined;
  #queue: Array<UIMessageChunk> = [];
  #flushTimeout: NodeJS.Timeout | undefined;
  #heartbeatInterval: NodeJS.Timeout | undefined;
  #heartbeatInflight: Promise<void> | undefined;
  #seq = 0;
  #logger: Logger;

  constructor(
    public readonly component: ComponentApi,
    public readonly ctx: ActionCtx,
    public readonly config: {
      throttleMs: number;
      heartbeatMs: number;
      lockId: string;
      threadId: Id<"threads">;
      streamId: Id<"streams">;
    },
  ) {
    this.#logger = new Logger(`streamer:${config.streamId}`);
  }

  async acquireLock(): Promise<Doc<"streams">> {
    this.#logger.debug(`Acquiring lock (lockId=${this.config.lockId}, threadId=${this.config.threadId})`);
    const stream = await this.ctx.runMutation(this.component.streams.take, {
      threadId: this.config.threadId,
      streamId: this.config.streamId,
      lockId: this.config.lockId,
    });
    this.#logger.debug("Lock acquired successfully");
    return stream;
  }

  enableDeltaStreaming(): void {
    this.#logger.debug("Delta streaming enabled");
    this.#enableDeltaStreaming = true;
  }

  async setMessageId(msgId: string | undefined, _existingMessage: boolean): Promise<void> {
    if (this.#msgId && this.#msgId !== msgId) {
      this.#logger.debug(`Message ID changing from ${this.#msgId} to ${msgId}, flushing pending queue`);
      await this.flush();
    }
    this.#logger.debug(`Set message ID: ${msgId} (existing=${_existingMessage})`);
    this.#msgId = msgId;
    this.#seq = 0;
  }

  startHeartbeat(): void {
    if (this.#heartbeatInterval != null) {
      return;
    }
    this.#logger.debug(`Starting heartbeat timer (${this.config.heartbeatMs}ms)`);
    this.#heartbeatInterval = setInterval(() => {
      if (this.#heartbeatInflight != null) {
        return;
      }
      this.#heartbeatInflight = this.#sendHeartbeat().finally(() => {
        this.#heartbeatInflight = undefined;
      });
    }, this.config.heartbeatMs);
  }

  async stopHeartbeat(): Promise<void> {
    if (this.#heartbeatInterval != null) {
      clearInterval(this.#heartbeatInterval);
      this.#heartbeatInterval = undefined;
      this.#logger.debug("Heartbeat timer stopped");
    }
    if (this.#heartbeatInflight != null) {
      await this.#heartbeatInflight;
    }
  }

  async #sendHeartbeat(): Promise<void> {
    try {
      await this.ctx.runMutation(this.component.streams.heartbeat, {
        streamId: this.config.streamId,
        lockId: this.config.lockId,
      });
    } catch (e) {
      this.#logger.warn(`Heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async process(part: UIMessageChunk): Promise<void> {
    if (this.#enableDeltaStreaming) {
      this.#queue.push(part);
      // this.#logger.debug(`Queued part type=${part.type} (queueSize=${this.#queue.length})`);
      if (this.#flushTimeout == null) {
        // this.#logger.debug(`Scheduling flush in ${this.config.throttleMs}ms`);
        this.#flushTimeout = setTimeout(() => this.flush(), this.config.throttleMs);
      }
    }
  }

  async flush(): Promise<void> {
    if (this.#flushTimeout != null) clearTimeout(this.#flushTimeout);
    this.#flushTimeout = undefined;
    if (this.#inflight != null) {
      this.#logger.debug("Flush already inflight, chaining after current flush");
      return this.#inflight.then(() => this.flush());
    }

    this.#logger.debug(`Flushing (queueSize=${this.#queue.length})`);
    this.#inflight = this.#flush();
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#inflight.finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #flush(): Promise<void> {
    if (this.#queue.length === 0) {
      this.#logger.debug("Flush skipped: queue empty");
      return;
    }
    if (this.#msgId == null) throw new Error("Received chunks without message ID");
    try {
      const queue = this.#queue;
      this.#queue = [];
      const compacted = compactQueue(queue);
      if (compacted.length === 0) {
        this.#logger.debug(`Skipping delta write: seq=${this.#seq}, rawParts=${queue.length}, compactedParts=0`);
        return;
      }
      this.#logger.debug(
        `Writing delta: seq=${this.#seq}, rawParts=${queue.length}, compactedParts=${compacted.length}, msgId=${this.#msgId}`,
      );
      await this.ctx.runMutation(this.component.streams.addDelta, {
        streamId: this.config.streamId,
        lockId: this.config.lockId,
        parts: compacted,
        seq: this.#seq++,
        msgId: this.#msgId,
      });
      this.#logger.debug(`Delta written successfully (nextSeq=${this.#seq})`);
    } catch (e) {
      this.#logger.error("Error in flush:", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async finish(): Promise<void> {
    try {
      if (this.#enableDeltaStreaming) {
        this.#logger.debug("Finishing: flushing remaining deltas...");
        await this.flush();
      }
      this.#logger.debug("Marking stream as finished");
      await this.ctx.runMutation(this.component.streams.finish, {
        streamId: this.config.streamId,
      });
      this.#logger.debug("Stream finished successfully");
    } finally {
      await this.stopHeartbeat();
    }
  }

  async fail(reason: string): Promise<void> {
    try {
      this.#logger.debug(`Aborting stream: ${reason}`);
      await this.ctx.runMutation(this.component.streams.abort, {
        streamId: this.config.streamId,
        reason,
      });
      this.#logger.debug("Stream aborted");
    } finally {
      await this.stopHeartbeat();
    }
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
