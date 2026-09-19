import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const delivery = vi.hoisted(() => ({
  broadcastFailure: false,
  nodeFailure: false,
  broadcasts: [] as Array<{ event: string; payload: unknown }>,
  nodeSends: [] as Array<{ sessionKey: string; event: string; payload: unknown }>,
}));

vi.mock("./server-broadcast.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-broadcast.js")>();
  return {
    ...actual,
    createGatewayBroadcaster: (...args: Parameters<typeof actual.createGatewayBroadcaster>) => {
      const broadcaster = actual.createGatewayBroadcaster(...args);
      return {
        ...broadcaster,
        broadcast: ((event, payload, opts) => {
          if (event === "jarvis.lifecycle") {
            delivery.broadcasts.push({ event, payload });
            if (delivery.broadcastFailure) {
              throw new Error("controlled lifecycle broadcast failure");
            }
          }
          broadcaster.broadcast(event, payload, opts);
        }) satisfies typeof broadcaster.broadcast,
      };
    },
  };
});

vi.mock("./server-node-session-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-node-session-runtime.js")>();
  return {
    ...actual,
    createGatewayNodeSessionRuntime: (
      ...args: Parameters<typeof actual.createGatewayNodeSessionRuntime>
    ) => {
      const runtime = actual.createGatewayNodeSessionRuntime(...args);
      return {
        ...runtime,
        nodeSendToSession: ((sessionKey, event, payload) => {
          if (event === "jarvis.lifecycle") {
            delivery.nodeSends.push({ sessionKey, event, payload });
            if (delivery.nodeFailure) {
              throw new Error("controlled lifecycle node failure");
            }
          }
          runtime.nodeSendToSession(sessionKey, event, payload);
        }) satisfies typeof runtime.nodeSendToSession,
      };
    },
  };
});

import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("Jarvis lifecycle delivery failures through chat.send RPC", () => {
  let started: Awaited<ReturnType<typeof startServerWithClient>>;

  beforeAll(async () => {
    started = await startServerWithClient("jarvis-lifecycle-fixture-token");
    await connectOk(started.ws);
  });

  beforeEach(() => {
    delivery.broadcastFailure = false;
    delivery.nodeFailure = false;
    delivery.broadcasts.length = 0;
    delivery.nodeSends.length = 0;
  });

  afterAll(async () => {
    started?.ws.close();
    await started?.server.close();
    started?.envSnapshot.restore();
  });

  test.each([
    { label: "broadcast", broadcastFailure: true, nodeFailure: false },
    { label: "node", broadcastFailure: false, nodeFailure: true },
    { label: "both", broadcastFailure: true, nodeFailure: true },
  ])("accepts chat.send when $label lifecycle delivery fails", async (scenario) => {
    delivery.broadcastFailure = scenario.broadcastFailure;
    delivery.nodeFailure = scenario.nodeFailure;
    const runId = `jarvis-rpc-failure-${scenario.label}`;
    const sessionKey = `agent:main:jarvis-rpc-${scenario.label}`;

    const response = await rpcReq(started.ws, "chat.send", {
      sessionKey,
      message: "hello",
      idempotencyKey: runId,
    });

    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({ runId, status: "started" });
    expect(delivery.broadcasts).toHaveLength(1);
    expect(delivery.nodeSends).toHaveLength(1);
    const broadcastPayload = delivery.broadcasts[0]?.payload as Record<string, unknown>;
    expect(delivery.broadcasts[0]?.event).toBe("jarvis.lifecycle");
    expect(delivery.nodeSends[0]).toEqual({
      sessionKey,
      event: "jarvis.lifecycle",
      payload: broadcastPayload,
    });
    expect(broadcastPayload).toMatchObject({
      runId,
      sessionKey,
      state: "thinking",
      seq: 1,
    });
    expect(Object.keys(broadcastPayload).toSorted()).toEqual([
      "messageKey",
      "runId",
      "seq",
      "sessionKey",
      "state",
      "timestamp",
    ]);
  });
});
