import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApiUrl, getAuthMode, getNormiesHome } from "./config.js";


export function buildClaudeConfigFragment({ binPath, command = process.execPath } = {}) {
  return {
    mcpServers: {
      normies: {
        command,
        args: [binPath, "mcp"],
        env: buildNormiesEnv()
      }
    }
  };
}

export function getClaudeConfigStatus({ targetPath } = {}) {
  const candidates = targetPath
    ? [{ label: "Custom path", path: path.resolve(targetPath), priority: 0 }]
    : getClaudeConfigCandidates();

  return {
    platform: process.platform,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      ...inspectClaudeConfig(candidate.path)
    }))
  };
}

export function writeClaudeConfig({ binPath, targetPath, force = false } = {}) {
  const targets = getClaudeWriteTargets(targetPath);
  const fragment = buildClaudeConfigFragment({ binPath });
  const results = targets.map((target) => writeClaudeConfigFile({
    target,
    fragment,
    force
  }));

  return {
    written: results,
    nextSteps: [
      "Fully quit and reopen Claude Desktop.",
      "Start a fresh Claude chat.",
      "Ask Claude to check Normies auth status."
    ]
  };
}

export function getClaudeConfigCandidates() {
  const candidates = [];
  const home = os.homedir();

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");

    candidates.push({
      label: "Claude Desktop",
      path: path.join(appData, "Claude", "claude_desktop_config.json"),
      priority: 1,
      writeDefault: true
    });
    candidates.push({
      label: "Claude Desktop (Microsoft Store)",
      path: path.join(
        localAppData,
        "Packages",
        "Claude_pzs8sxrjxfjjc",
        "LocalCache",
        "Roaming",
        "Claude",
        "claude_desktop_config.json"
      ),
      priority: 2,
      writeDefault: true
    });
    candidates.push({
      label: "Claude Desktop (Microsoft Store alternate)",
      path: path.join(
        localAppData,
        "Packages",
        "Claude_pzs8sxrjxfjjc",
        "LocalCache",
        "Roaming",
        "Claude-3p",
        "claude_desktop_config.json"
      ),
      priority: 3,
      writeDefault: false
    });
  } else if (process.platform === "darwin") {
    candidates.push({
      label: "Claude Desktop",
      path: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      priority: 1,
      writeDefault: true
    });
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    candidates.push({
      label: "Claude Desktop",
      path: path.join(configHome, "Claude", "claude_desktop_config.json"),
      priority: 1,
      writeDefault: true
    });
  }

  return uniqueCandidates(candidates);
}

function buildNormiesEnv() {
  const env = {
    NORMIES_API_URL: getApiUrl(),
    NORMIES_HOME: getNormiesHome()
  };


  return env;
}

function getClaudeWriteTargets(targetPath) {
  if (targetPath) {
    return [{ label: "Custom path", path: path.resolve(targetPath), priority: 0 }];
  }

  const candidates = getClaudeConfigCandidates();
  const writable = candidates.filter((candidate) => candidate.writeDefault !== false);
  const existing = writable.filter((candidate) => fs.existsSync(candidate.path));
  return existing.length > 0 ? existing : writable.slice(0, 1);
}

function writeClaudeConfigFile({ target, fragment, force }) {
  fs.mkdirSync(path.dirname(target.path), { recursive: true });

  const before = readClaudeConfig(target.path);
  if (before.exists && !before.validJson && !force) {
    return {
      ...target,
      action: "skipped",
      validJson: false,
      error: before.error,
      nextStep: "Fix this JSON file, or rerun with `normies claude-config --write --force` to replace it after backup."
    };
  }

  const source = before.exists && before.validJson ? before.config : {};
  const config = normalizeConfigObject(source);
  config.mcpServers = normalizeConfigObject(config.mcpServers);
  config.mcpServers.normies = fragment.mcpServers.normies;

  const backup = before.exists ? createBackup(target.path) : null;
  const json = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(target.path, json, "utf8");

  const after = inspectClaudeConfig(target.path);
  return {
    ...target,
    action: before.exists ? "updated" : "created",
    backup,
    ...after
  };
}

function inspectClaudeConfig(configPath) {
  const read = readClaudeConfig(configPath);
  if (!read.exists) {
    return {
      exists: false,
      validJson: null,
      hasMcpServers: false,
      hasNormies: false
    };
  }

  if (!read.validJson) {
    return {
      exists: true,
      validJson: false,
      hasMcpServers: false,
      hasNormies: false,
      error: read.error
    };
  }

  const mcpServers = read.config?.mcpServers;
  const normies = mcpServers?.normies;
  return {
    exists: true,
    validJson: true,
    hasMcpServers: isPlainObject(mcpServers),
    hasNormies: isPlainObject(normies),
    normies: summarizeNormiesServer(normies)
  };
}

function readClaudeConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { exists: false };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const trimmed = raw.trim();
    return {
      exists: true,
      validJson: true,
      config: trimmed ? JSON.parse(trimmed) : {}
    };
  } catch (error) {
    return {
      exists: true,
      validJson: false,
      error: error.message
    };
  }
}

function summarizeNormiesServer(normies) {
  if (!isPlainObject(normies)) {
    return null;
  }

  const env = isPlainObject(normies.env) ? normies.env : {};
  return {
    command: normies.command,
    args: Array.isArray(normies.args) ? normies.args : [],
    usesShellWrapper: isShellWrapper(normies.command),
    env: {
      NORMIES_API_URL: env.NORMIES_API_URL,
      NORMIES_HOME: env.NORMIES_HOME,
      NORMIES_AUTH_MODE: env.NORMIES_AUTH_MODE
    },
    configuredAuthMode: env.NORMIES_AUTH_MODE || "normies",
    currentAuthMode: getAuthMode()
  };
}

function createBackup(configPath) {
  const backupPath = `${configPath}.bak-${timestampForFile()}`;
  fs.copyFileSync(configPath, backupPath);
  return backupPath;
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function normalizeConfigObject(value) {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isShellWrapper(command) {
  const name = path.basename(String(command || "")).toLowerCase();
  return name === "cmd.exe" || name === "cmd" || name === "sh" || name === "bash" || name === "zsh";
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = path.normalize(candidate.path).toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
