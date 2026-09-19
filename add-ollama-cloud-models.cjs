const {
  configPathFromArgs,
  requireRecord,
  updateConfig,
} = require("./model-config-script-utils.cjs");

const cloudModels = [
  {
    id: "deepseek-v4-flash:cloud",
    name: "DeepSeek V4 Flash Cloud",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "deepseek-v4-pro:cloud",
    name: "DeepSeek V4 Pro Cloud",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "glm-5.2:cloud",
    name: "GLM 5.2 Cloud",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  },
];

function run({ configPath, fileSystem, now } = {}) {
  return updateConfig({
    configPath,
    fileSystem,
    now,
    backupLabel: "add-ollama-cloud",
    transform(config) {
      config.models ??= {};
      requireRecord(config.models, "models");
      config.models.mode ??= "merge";
      config.models.providers ??= {};
      requireRecord(config.models.providers, "models.providers");
      config.models.providers.ollama ??= {};
      requireRecord(config.models.providers.ollama, "models.providers.ollama");
      const ollama = config.models.providers.ollama;
      ollama.baseUrl ??= "http://127.0.0.1:11434";
      ollama.models ??= [];
      if (!Array.isArray(ollama.models)) {
        throw new Error("models.providers.ollama.models must be an array");
      }

      const byId = new Map();
      for (const model of ollama.models) {
        if (model && model.id) {
          byId.set(model.id, model);
        }
      }
      for (const model of cloudModels) {
        byId.set(model.id, { ...byId.get(model.id), ...model });
      }
      ollama.models = Array.from(byId.values());

      config.agents ??= {};
      requireRecord(config.agents, "agents");
      config.agents.defaults ??= {};
      requireRecord(config.agents.defaults, "agents.defaults");
      config.agents.defaults.models ??= {};
      requireRecord(config.agents.defaults.models, "agents.defaults.models");
      for (const model of cloudModels) {
        config.agents.defaults.models[`ollama/${model.id}`] = {};
      }
    },
  });
}

if (require.main === module) {
  try {
    const { configPath, backupPath } = run({
      configPath: configPathFromArgs(process.argv.slice(2)),
    });
    console.log("Updated OpenClaw config with Ollama cloud models.");
    console.log("Config:", configPath);
    console.log("Backup:", backupPath);
    console.log("Added:");
    for (const model of cloudModels) {
      console.log("-", `ollama/${model.id}`);
    }
  } catch (error) {
    console.error(`Model config update failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { run };
