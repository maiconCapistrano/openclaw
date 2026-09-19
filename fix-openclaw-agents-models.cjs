const {
  configPathFromArgs,
  requireRecord,
  updateConfig,
} = require("./model-config-script-utils.cjs");

const agentModels = {
  "vllm/unsloth/Qwen2.5-7B-Instruct-1M-bnb-4bit": {},
  "ollama/qwen3.5:latest": {},
  "ollama/gpt-oss:20b": {},
  "ollama/qwen3:30b": {},
  "ollama/qwen3-coder:30b": {},
  "ollama/qwen3:14b": {},
  "ollama/qwen3:8b": {},
  "ollama/qwen2.5vl:7b": {},
};

function run({ configPath, fileSystem, now } = {}) {
  return updateConfig({
    configPath,
    fileSystem,
    now,
    backupLabel: "fix-agents-models",
    transform(config) {
      config.agents ??= {};
      requireRecord(config.agents, "agents");
      config.agents.defaults ??= {};
      requireRecord(config.agents.defaults, "agents.defaults");
      config.agents.defaults.models = { ...agentModels };
      config.agents.defaults.model = {
        primary: "vllm/unsloth/Qwen2.5-7B-Instruct-1M-bnb-4bit",
      };
      if (config.wizard?.securityAcknowledgedAt) {
        delete config.wizard.securityAcknowledgedAt;
      }
    },
  });
}

if (require.main === module) {
  try {
    const { configPath, backupPath } = run({
      configPath: configPathFromArgs(process.argv.slice(2)),
    });
    console.log("Fixed agents.defaults.models schema.");
    console.log("Config:", configPath);
    console.log("Backup:", backupPath);
  } catch (error) {
    console.error(`Model config update failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { run };
