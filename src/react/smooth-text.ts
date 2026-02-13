import { useEffect, useRef, useState } from "react";

// ============================================================================
// useSmoothText Hook
// ============================================================================

const FPS = 20;
const MS_PER_FRAME = 1000 / FPS;
const INITIAL_CHARS_PER_SEC = 128;

export type SmoothTextOptions = {
  charsPerSec?: number;
  startStreaming?: boolean;
  nowFn?: () => number;
};

/**
 * A hook that smoothly displays text as it is streamed.
 */
export function useSmoothText(
  text: string,
  { charsPerSec = INITIAL_CHARS_PER_SEC, startStreaming = false, nowFn = Date.now }: SmoothTextOptions = {},
): [string, { cursor: number; isStreaming: boolean }] {
  const [visibleText, setVisibleText] = useState(startStreaming ? "" : text || "");
  const smoothState = useRef({
    tick: nowFn(),
    cursor: visibleText.length,
    lastUpdate: nowFn(),
    lastUpdateLength: text.length,
    charsPerMs: charsPerSec / 1000,
    initial: true,
  });

  // eslint-disable-next-line react-hooks/refs
  const isStreaming = smoothState.current.cursor < text.length;

  useEffect(() => {
    if (!isStreaming) {
      return;
    }
    if (smoothState.current.lastUpdateLength !== text.length) {
      const timeSinceLastUpdate = Math.max(nowFn() - smoothState.current.lastUpdate, 1);
      const latestCharsPerMs = (text.length - smoothState.current.lastUpdateLength) / timeSinceLastUpdate;
      const rateError = latestCharsPerMs - smoothState.current.charsPerMs;
      const charLag = smoothState.current.lastUpdateLength - smoothState.current.cursor;
      const lagRate = charLag / timeSinceLastUpdate;
      const newCharsPerMs =
        latestCharsPerMs + (smoothState.current.initial ? 0 : Math.max(0, (rateError + lagRate) / 2));
      smoothState.current.initial = false;
      smoothState.current.charsPerMs = Math.min(
        (2 * newCharsPerMs + smoothState.current.charsPerMs) / 3,
        smoothState.current.charsPerMs * 2,
      );
    }
    smoothState.current.tick = Math.max(smoothState.current.tick, nowFn() - MS_PER_FRAME);
    smoothState.current.lastUpdate = nowFn();
    smoothState.current.lastUpdateLength = text.length;

    function update() {
      if (smoothState.current.cursor >= text.length) {
        return;
      }
      const now = nowFn();
      const timeSinceLastUpdate = now - smoothState.current.tick;
      const charsSinceLastUpdate = Math.floor(timeSinceLastUpdate * smoothState.current.charsPerMs);
      const chars = Math.min(charsSinceLastUpdate, text.length - smoothState.current.cursor);
      smoothState.current.cursor += chars;
      smoothState.current.tick += chars / smoothState.current.charsPerMs;
      setVisibleText(text.slice(0, smoothState.current.cursor));
    }
    update();
    const interval = setInterval(update, MS_PER_FRAME);
    return () => clearInterval(interval);
  }, [text, isStreaming, charsPerSec, nowFn]);

  // eslint-disable-next-line react-hooks/refs
  return [visibleText, { cursor: smoothState.current.cursor, isStreaming }];
}
