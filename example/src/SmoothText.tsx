/* eslint-disable react-hooks/refs */
import { useRef } from "react";
import { useSmoothText } from "convex-durable-agents/react";

/**
 * Smooth text component for streaming messages
 */
export function SmoothText({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const wasStreamingRef = useRef(isStreaming);
  if (isStreaming) {
    wasStreamingRef.current = true;
  }

  const [visibleText] = useSmoothText(text, {
    startStreaming: wasStreamingRef.current,
    charsPerSec: isStreaming ? 128 : 512,
  });

  return <span>{visibleText}</span>;
}
