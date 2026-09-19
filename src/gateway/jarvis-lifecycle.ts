// Jarvis lifecycle events describe verified gateway run milestones.

export const JARVIS_LIFECYCLE_EVENT = "jarvis.lifecycle";

export type JarvisThinkingLifecyclePayload = {
  sessionKey: string;
  runId: string;
  seq: 1;
  state: "thinking";
  messageKey: "lifecycle.thinking";
  timestamp: string;
};

/** Builds the single currently supported lifecycle milestone for an accepted chat run. */
export function createJarvisThinkingLifecyclePayload(params: {
  sessionKey: string;
  runId: string;
  now?: Date;
}): JarvisThinkingLifecyclePayload {
  const sessionKey = params.sessionKey.trim();
  const runId = params.runId.trim();
  if (!sessionKey || !runId) {
    throw new Error("Jarvis lifecycle events require a session key and run ID");
  }

  return {
    sessionKey,
    runId,
    seq: 1,
    state: "thinking",
    messageKey: "lifecycle.thinking",
    timestamp: (params.now ?? new Date()).toISOString(),
  };
}
