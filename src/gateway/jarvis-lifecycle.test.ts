import { describe, expect, it } from "vitest";
import {
  createJarvisThinkingLifecyclePayload,
  JARVIS_LIFECYCLE_EVENT,
} from "./jarvis-lifecycle.js";

describe("Jarvis lifecycle contract", () => {
  it("builds the authoritative thinking milestone", () => {
    const payload = createJarvisThinkingLifecyclePayload({
      sessionKey: "agent:main:jarvis:test",
      runId: "run-1",
      now: new Date("2026-07-21T12:34:56.789Z"),
    });

    expect(JARVIS_LIFECYCLE_EVENT).toBe("jarvis.lifecycle");
    expect(payload).toEqual({
      sessionKey: "agent:main:jarvis:test",
      runId: "run-1",
      seq: 1,
      state: "thinking",
      messageKey: "lifecycle.thinking",
      timestamp: "2026-07-21T12:34:56.789Z",
    });
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
  });

  it.each([
    { sessionKey: "", runId: "run-1" },
    { sessionKey: "session-1", runId: "   " },
  ])("rejects missing authoritative identifiers", (params) => {
    expect(() => createJarvisThinkingLifecyclePayload(params)).toThrow(
      "Jarvis lifecycle events require a session key and run ID",
    );
  });
});
