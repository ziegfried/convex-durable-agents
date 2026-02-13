import type { UIMessage } from "ai";

export type ThreadStatus = "streaming" | "awaiting_tool_results" | "completed" | "failed" | "stopped";

export type ThreadDoc = {
  _id: string;
  _creationTime: number;
  status: ThreadStatus;
  stopSignal: boolean;
};

export type MessageDoc = UIMessage & {
  _id: string;
  _creationTime: number;
  threadId: string;
  committedSeq?: number | undefined;
};

export type StreamingMessageUpdates = {
  messages: Array<{ msgId: string; parts: unknown[] }>;
};
