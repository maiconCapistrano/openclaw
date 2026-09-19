import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scripts = [
  {
    file: "add-ollama-cloud-models.cjs",
    backupLabel: "add-ollama-cloud",
    run: require("../../add-ollama-cloud-models.cjs").run as (options: object) => unknown,
  },
  {
    file: "fix-openclaw-agents-models.cjs",
    backupLabel: "fix-agents-models",
    run: require("../../fix-openclaw-agents-models.cjs").run as (options: object) => unknown,
  },
];

let fixtureRoot: string;
let configPath: string;

function writeConfig(value: unknown) {
  fs.writeFileSync(configPath, JSON.stringify(value), "utf8");
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>;
}

function backups() {
  return fs.readdirSync(fixtureRoot).filter((name) => name.startsWith("openclaw.json.bak."));
}

function runCli(file: string, target = configPath) {
  return spawnSync(process.execPath, [path.join(repoRoot, file), "--config", target], {
    cwd: fixtureRoot,
    // If a CLI regression ignored --config, its default home is still disposable.
    env: {
      ...process.env,
      HOME: fixtureRoot,
      USERPROFILE: fixtureRoot,
      OPENCLAW_HOME: fixtureRoot,
      OPENCLAW_STATE_DIR: path.join(fixtureRoot, ".openclaw"),
      OPENCLAW_CONFIG_PATH: path.join(fixtureRoot, ".openclaw", "openclaw.json"),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-model-config-test-"));
  configPath = path.join(fixtureRoot, "openclaw.json");
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.each(scripts)("$file", ({ file, backupLabel, run }) => {
  it("rejects a missing config without creating a backup", () => {
    const result = runCli(file);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Config file does not exist");
    expect(backups()).toEqual([]);
  });

  it("rejects malformed JSON without printing its contents or creating a backup", () => {
    fs.writeFileSync(configPath, '{"secret":"DO_NOT_PRINT",', "utf8");
    const result = runCli(file);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Config file contains malformed JSON");
    expect(result.stdout + result.stderr).not.toContain("DO_NOT_PRINT");
    expect(backups()).toEqual([]);
    expect(fs.readFileSync(configPath, "utf8")).toContain("DO_NOT_PRINT");
  });

  it("rejects unsafe path and non-object config before mutation", () => {
    expect(runCli(file, "relative/openclaw.json").stderr).toContain("absolute path");
    writeConfig([]);
    const result = runCli(file);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Config root must be a JSON object");
    expect(backups()).toEqual([]);
  });

  it("preserves the original and backup when writing fails", () => {
    const original = { agents: { defaults: { models: { old: {} } } }, secret: "fixture-secret" };
    writeConfig(original);
    const bytes = fs.readFileSync(configPath);
    const failingFs = {
      ...fs,
      writeFileSync(tempPath: string) {
        fs.writeFileSync(tempPath, "partial fixture write");
        throw new Error("fixture write failure");
      },
    };
    expect(() => run({ configPath, fileSystem: failingFs })).toThrow("fixture write failure");
    expect(fs.readFileSync(configPath)).toEqual(bytes);
    const saved = backups();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain(`.bak.${backupLabel}.`);
    expect(fs.readFileSync(path.join(fixtureRoot, saved[0]))).toEqual(bytes);
    expect(fs.readdirSync(fixtureRoot).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("preserves the original when atomic rename fails", () => {
    writeConfig({ agents: { defaults: {} }, secret: "fixture-secret" });
    const bytes = fs.readFileSync(configPath);
    const failingFs = {
      ...fs,
      renameSync() {
        throw new Error("fixture rename failure");
      },
    };
    expect(() => run({ configPath, fileSystem: failingFs })).toThrow("fixture rename failure");
    expect(fs.readFileSync(configPath)).toEqual(bytes);
    expect(backups()).toHaveLength(1);
    expect(fs.readdirSync(fixtureRoot).filter((name) => name.includes(".tmp."))).toEqual([]);
  });
});

it("adds and refreshes Ollama cloud models while preserving unrelated fields and rerun output", () => {
  const original = {
    secret: "fixture-secret",
    custom: { keep: true },
    models: {
      mode: "replace",
      providers: {
        other: { keep: true },
        ollama: {
          baseUrl: "http://fixture-ollama:11434",
          extra: "keep",
          models: [
            { id: "existing", name: "Existing" },
            { id: "deepseek-v4-flash:cloud", name: "Old name", extra: "preserved" },
          ],
        },
      },
    },
    agents: {
      defaults: {
        models: {
          "custom/model": { alias: "keep" },
          "ollama/deepseek-v4-flash:cloud": { alias: "replaced" },
        },
        marker: "keep",
      },
    },
  };
  writeConfig(original);
  const first = runCli("add-ollama-cloud-models.cjs");
  expect(first.status).toBe(0);
  expect(first.stdout + first.stderr).not.toContain("fixture-secret");
  expect(first.stdout + first.stderr).not.toContain("preserved");
  const saved = backups();
  expect(saved).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(path.join(fixtureRoot, saved[0]), "utf8"))).toEqual(original);
  const config = readConfig();
  expect(config.secret).toBe("fixture-secret");
  expect(config.custom).toEqual({ keep: true });
  expect(config.models.mode).toBe("replace");
  expect(config.models.providers.other).toEqual({ keep: true });
  expect(config.models.providers.ollama.baseUrl).toBe("http://fixture-ollama:11434");
  expect(config.models.providers.ollama.extra).toBe("keep");
  expect(config.models.providers.ollama.models.map((model: { id: string }) => model.id)).toEqual([
    "existing",
    "deepseek-v4-flash:cloud",
    "deepseek-v4-pro:cloud",
    "glm-5.2:cloud",
  ]);
  expect(config.models.providers.ollama.models[1]).toMatchObject({
    name: "DeepSeek V4 Flash Cloud",
    extra: "preserved",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  });
  expect(config.agents.defaults.models["custom/model"]).toEqual({ alias: "keep" });
  for (const id of ["deepseek-v4-flash:cloud", "deepseek-v4-pro:cloud", "glm-5.2:cloud"]) {
    expect(config.agents.defaults.models[`ollama/${id}`]).toEqual({});
  }

  expect(runCli("add-ollama-cloud-models.cjs").status).toBe(0);
  expect(readConfig()).toEqual(config);
  const rerunBackups = backups();
  expect(rerunBackups).toHaveLength(2);
  const secondBackup = rerunBackups.find((name) => name !== saved[0]);
  expect(JSON.parse(fs.readFileSync(path.join(fixtureRoot, secondBackup!), "utf8"))).toEqual(
    config,
  );
});

it("creates Ollama defaults when model configuration is absent", () => {
  writeConfig({ unrelated: "keep" });
  expect(runCli("add-ollama-cloud-models.cjs").status).toBe(0);
  const config = readConfig();
  expect(config.unrelated).toBe("keep");
  expect(config.models.mode).toBe("merge");
  expect(config.models.providers.ollama.baseUrl).toBe("http://127.0.0.1:11434");
  expect(config.models.providers.ollama.models).toHaveLength(3);
  for (const model of config.models.providers.ollama.models) {
    expect(model).toMatchObject({
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    });
  }
});

it("replaces agent model selections, removes only the acknowledged wizard field, and is idempotent", () => {
  const original = {
    secret: "fixture-secret",
    custom: { keep: true },
    agents: {
      defaults: {
        models: { "old/model": { alias: "drop" } },
        model: { primary: "old/model", fallback: "drop" },
        marker: "keep",
      },
      list: [{ id: "other", workspace: "keep" }],
    },
    wizard: { securityAcknowledgedAt: "2026-09-19T00:00:00Z", marker: "keep" },
  };
  writeConfig(original);
  const first = runCli("fix-openclaw-agents-models.cjs");
  expect(first.status).toBe(0);
  expect(first.stdout + first.stderr).not.toContain("fixture-secret");
  const saved = backups();
  expect(saved).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(path.join(fixtureRoot, saved[0]), "utf8"))).toEqual(original);
  const config = readConfig();
  expect(config.secret).toBe("fixture-secret");
  expect(config.custom).toEqual({ keep: true });
  expect(config.agents.list).toEqual(original.agents.list);
  expect(config.agents.defaults.marker).toBe("keep");
  expect(config.agents.defaults.model).toEqual({
    primary: "vllm/unsloth/Qwen2.5-7B-Instruct-1M-bnb-4bit",
  });
  expect(Object.keys(config.agents.defaults.models)).toEqual([
    "vllm/unsloth/Qwen2.5-7B-Instruct-1M-bnb-4bit",
    "ollama/qwen3.5:latest",
    "ollama/gpt-oss:20b",
    "ollama/qwen3:30b",
    "ollama/qwen3-coder:30b",
    "ollama/qwen3:14b",
    "ollama/qwen3:8b",
    "ollama/qwen2.5vl:7b",
  ]);
  expect(config.wizard).toEqual({ marker: "keep" });

  expect(runCli("fix-openclaw-agents-models.cjs").status).toBe(0);
  expect(readConfig()).toEqual(config);
  expect(backups()).toHaveLength(2);
});
