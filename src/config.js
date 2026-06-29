import os from "node:os";
import path from "node:path";

export const DEFAULT_API_URL = "https://api.normies.art";

export function getApiUrl() {
  return (process.env.NORMIES_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

export function getNormiesHome() {
  return process.env.NORMIES_HOME || path.join(os.homedir(), ".normies");
}

export function getAuthMode() {
  return (process.env.NORMIES_AUTH_MODE || "normies").toLowerCase();
}

export function nowIso() {
  return new Date().toISOString();
}
