/** On-demand isolated-world entry; always built as a self-contained classic IIFE. */
import { startContentSession } from './element-registry/session.js';

// Module state is new on each executeScript injection. Keep only the owner in
// the extension's isolated global, never page DOM attributes or the page world.
const owner = globalThis as typeof globalThis & {
  __privacAgentSession?: ReturnType<typeof startContentSession>;
};
owner.__privacAgentSession?.dispose();
owner.__privacAgentSession = startContentSession(document);
