import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { connectReq } from "./test-helpers.js";

const checkoutRoot = fileURLToPath(new URL("../../", import.meta.url));
const executable = path.join(checkoutRoot, "dist", "entry.js");
const buildStampPath = path.join(checkoutRoot, "dist", ".buildstamp");
const MAX_OUTPUT = 16_384;

function decodeFrame(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return data instanceof ArrayBuffer
    ? Buffer.from(new Uint8Array(data)).toString("utf8")
    : Buffer.from(data).toString("utf8");
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve a local port");
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return address.port;
}

async function waitUntilReady(port: number, child: ChildProcess, diagnostics: () => string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`isolated gateway exited before readiness: ${diagnostics()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok && (await response.json())?.status === "live") {
        return;
      }
    } catch {
      // Retry until readiness or the bounded deadline.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`isolated gateway did not become ready: ${diagnostics()}`);
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill();
  await Promise.race([
    exited,
    new Promise((resolve) => {
      setTimeout(resolve, 5_000);
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function request(ws: WebSocket, method: string, params: unknown) {
  const id = randomUUID();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`${method} response timed out`));
    }, 10_000);
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(decodeFrame(data)) as Record<string, unknown>;
      if (frame.type === "res" && frame.id === id) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(frame);
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

test("source-built isolated gateway emits the Jarvis lifecycle contract", async () => {
  await fs.access(executable);
  const buildStamp = JSON.parse(await fs.readFile(buildStampPath, "utf8")) as {
    builtAt: number;
    head: string;
  };
  // The smoke is valid only for a build made after the lifecycle source used here.
  for (const relativePath of [
    "src/gateway/jarvis-lifecycle.ts",
    "src/gateway/server-methods/chat.ts",
    "src/gateway/server-broadcast.ts",
    "src/gateway/server-methods-list.ts",
  ]) {
    const source = await fs.stat(path.join(checkoutRoot, relativePath));
    expect(buildStamp.builtAt).toBeGreaterThanOrEqual(source.mtimeMs);
  }
  expect(buildStamp.head).toBe(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkoutRoot, encoding: "utf8" }).trim(),
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-lifecycle-executable-"));
  const home = path.join(root, "home");
  const state = path.join(home, ".openclaw");
  const configPath = path.join(state, "openclaw.json");
  const port = await getFreePort();
  const token = `jarvis-smoke-${randomUUID()}`;
  let child: ChildProcess | undefined;
  let ws: WebSocket | undefined;
  let output = "";
  try {
    await fs.mkdir(state, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "local",
          port,
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: true, dangerouslyDisableDeviceAuth: true },
        },
        agents: { defaults: { workspace: path.join(root, "workspace") } },
        plugins: { enabled: false },
      }),
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|OPENCLAW_/i.test(key)) {
        delete env[key];
      }
    }
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_ONBOARD: "1",
      OPENCLAW_DISABLE_BONJOUR: "1",
    });
    child = spawn(
      process.execPath,
      [executable, "gateway", "--port", String(port), "--bind", "loopback"],
      {
        cwd: checkoutRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-MAX_OUTPUT);
      });
    }
    await waitUntilReady(port, child, () => output);
    ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws?.once("open", () => resolve());
      ws?.once("error", reject);
    });
    const connected = await connectReq(ws, {
      token,
      skipDefaultAuth: true,
      device: null,
      scopes: ["operator.admin", "operator.write", "operator.read"],
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });
    expect(connected.ok).toBe(true);
    const advertised = (connected.payload as { features?: { events?: string[] } })?.features
      ?.events;
    expect(advertised).toContain("jarvis.lifecycle");

    const events: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => {
      const frame = JSON.parse(decodeFrame(data)) as Record<string, unknown>;
      if (frame.type === "event" && frame.event === "jarvis.lifecycle") {
        events.push(frame);
      }
    });
    const runId = `jarvis-runtime-${randomUUID()}`;
    const accepted = await request(ws, "chat.send", {
      sessionKey: "main",
      message: "/context list",
      idempotencyKey: runId,
    });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(accepted.payload).toMatchObject({ runId, status: "started" });
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      runId,
      sessionKey: "agent:main:main",
      state: "thinking",
      seq: 1,
      messageKey: "lifecycle.thinking",
    });
    expect(Object.keys(payload).toSorted()).toEqual([
      "messageKey",
      "runId",
      "seq",
      "sessionKey",
      "state",
      "timestamp",
    ]);
    expect(Number.isNaN(Date.parse(payload.timestamp as string))).toBe(false);

    const rejected = await request(ws, "chat.send", {
      sessionKey: "main",
      message: "invalid\u0000message",
      idempotencyKey: `jarvis-rejected-${randomUUID()}`,
    });
    expect(rejected.ok).toBe(false);
    expect(events).toHaveLength(1);
  } finally {
    ws?.terminate();
    let childExited = true;
    if (child) {
      await stopChild(child);
      childExited = child.exitCode !== null || child.signalCode !== null;
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    expect(childExited).toBe(true);
    await expect(
      fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow();
  }
}, 60_000);
