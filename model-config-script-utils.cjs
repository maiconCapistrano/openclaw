const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, field) {
  if (!isRecord(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}

function configPathFromArgs(args) {
  if (args.length === 0) {
    return path.join(os.homedir(), ".openclaw", "openclaw.json");
  }
  if (args.length !== 2 || args[0] !== "--config") {
    throw new Error("Usage: node <script> [--config <absolute path to openclaw.json>]");
  }
  return args[1];
}

function updateConfig({ configPath, backupLabel, transform, fileSystem = fs, now = new Date() }) {
  if (
    typeof configPath !== "string" ||
    !path.isAbsolute(configPath) ||
    path.basename(configPath).toLowerCase() !== "openclaw.json"
  ) {
    throw new Error("Config path must be an absolute path to openclaw.json");
  }

  let stat;
  try {
    stat = fileSystem.lstatSync(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Config file does not exist", { cause: error });
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Config path must name a regular file, not a directory or symlink");
  }

  let config;
  try {
    config = JSON.parse(fileSystem.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Config file contains malformed JSON", { cause: error });
    }
    throw error;
  }
  requireRecord(config, "Config root");
  transform(config);

  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.bak.${backupLabel}.${timestamp}.${randomUUID()}`;
  fileSystem.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);

  const tempPath = `${configPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    fileSystem.writeFileSync(tempPath, JSON.stringify(config, null, 2), { flag: "wx" });
    fileSystem.renameSync(tempPath, configPath);
  } catch (error) {
    try {
      fileSystem.rmSync(tempPath, { force: true });
    } catch {
      // Keep the original write failure as the reported error.
    }
    throw error;
  }
  return { configPath, backupPath };
}

module.exports = { configPathFromArgs, requireRecord, updateConfig };
