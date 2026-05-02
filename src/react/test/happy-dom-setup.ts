import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost" });

// Register DOM globals that @testing-library/react needs
const globals = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "MutationObserver",
  "Event",
  "CustomEvent",
  "getComputedStyle",
] as const;

for (const key of globals) {
  if ((win as any)[key] !== undefined) {
    (globalThis as any)[key] = (win as any)[key];
  }
}

// Bind document.createElement etc. properly
globalThis.document = win.document as any;
