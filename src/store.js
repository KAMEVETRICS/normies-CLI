import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getNormiesHome, nowIso } from "./config.js";

const DEFAULT_AUTH_REFRESH_MS = 5 * 60 * 1000;

export class NormiesStore {
  constructor({ home = getNormiesHome(), filename = "chats.db" } = {}) {
    this.home = home;
    fs.mkdirSync(home, { recursive: true });
    this.dbPath = path.join(home, filename);
    this.db = new DatabaseSync(this.dbPath);
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_id INTEGER NOT NULL,
        agent_id INTEGER,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        token_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_created
        ON messages(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_messages_token_created
        ON messages(token_id, created_at);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        token_id INTEGER NOT NULL,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_token_created
        ON memories(token_id, created_at);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_summary TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        address TEXT NOT NULL,
        token_ids_json TEXT NOT NULL,
        selected_token_id INTEGER,
        signed_message TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  getOrCreateSession({ sessionId, tokenId, agentId, title } = {}) {
    const id = sessionId || `chat_${crypto.randomUUID()}`;
    const timestamp = nowIso();
    const existing = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id);

    if (existing) {
      this.db
        .prepare("UPDATE sessions SET updated_at = ?, agent_id = COALESCE(?, agent_id), title = COALESCE(?, title) WHERE id = ?")
        .run(timestamp, agentId ?? null, title ?? null, id);
      return this.getSession(id);
    }

    this.db
      .prepare("INSERT INTO sessions (id, token_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, Number(tokenId), agentId ?? null, title ?? null, timestamp, timestamp);

    return this.getSession(id);
  }

  getSession(sessionId) {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  }

  addMessage({ sessionId, tokenId, role, content, metadata = {} }) {
    const session = this.getOrCreateSession({ sessionId, tokenId });
    const id = `msg_${crypto.randomUUID()}`;
    const timestamp = nowIso();
    this.db
      .prepare("INSERT INTO messages (id, session_id, token_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, session.id, Number(tokenId), role, content, JSON.stringify(metadata), timestamp);
    this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(timestamp, session.id);

    return { id, session_id: session.id, token_id: Number(tokenId), role, content, metadata, created_at: timestamp };
  }

  listMessages({ sessionId, tokenId, limit = 20 } = {}) {
    const cappedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const rows = sessionId
      ? tokenId !== undefined && tokenId !== null
        ? this.db
            .prepare("SELECT * FROM messages WHERE session_id = ? AND token_id = ? ORDER BY created_at DESC LIMIT ?")
            .all(sessionId, Number(tokenId), cappedLimit)
        : this.db
            .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
            .all(sessionId, cappedLimit)
      : this.db
          .prepare("SELECT * FROM messages WHERE token_id = ? ORDER BY created_at DESC LIMIT ?")
          .all(Number(tokenId), cappedLimit);

    return rows.reverse().map(deserializeMessage);
  }

  listSessions({ tokenId, limit = 20 } = {}) {
    const cappedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    if (tokenId !== undefined && tokenId !== null) {
      return this.db
        .prepare("SELECT * FROM sessions WHERE token_id = ? ORDER BY updated_at DESC LIMIT ?")
        .all(Number(tokenId), cappedLimit);
    }

    return this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(cappedLimit);
  }

  addMemory({ tokenId, scope = "holder", content, source = "manual" }) {
    const id = `mem_${crypto.randomUUID()}`;
    const timestamp = nowIso();
    this.db
      .prepare("INSERT INTO memories (id, token_id, scope, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, Number(tokenId), scope, content, source, timestamp);

    return { id, token_id: Number(tokenId), scope, content, source, created_at: timestamp };
  }

  listMemories({ tokenId, q, limit = 20 } = {}) {
    const cappedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    if (q) {
      return this.db
        .prepare("SELECT * FROM memories WHERE token_id = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?")
        .all(Number(tokenId), `%${q}%`, cappedLimit);
    }

    return this.db
      .prepare("SELECT * FROM memories WHERE token_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(Number(tokenId), cappedLimit);
  }

  addAuditLog({ tool, input, resultSummary }) {
    const id = `audit_${crypto.randomUUID()}`;
    const timestamp = nowIso();
    this.db
      .prepare("INSERT INTO audit_logs (id, tool, input_json, result_summary, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, tool, JSON.stringify(input ?? {}), resultSummary ?? null, timestamp);
    return { id, tool, created_at: timestamp };
  }

  saveAuth({ address, tokenIds, selectedTokenId, signedMessage, signature }) {
    const timestamp = nowIso();
    const sortedTokenIds = [...new Set((tokenIds ?? []).map(Number))].sort((a, b) => a - b);
    const selected = selectedTokenId === undefined || selectedTokenId === null
      ? null
      : Number(selectedTokenId);

    if (selected !== null && !sortedTokenIds.includes(selected)) {
      throw new Error(`Token ${selected} is not owned by ${address}.`);
    }

    this.db
      .prepare(`
        INSERT INTO auth_state (
          id, address, token_ids_json, selected_token_id, signed_message, signature, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          address = excluded.address,
          token_ids_json = excluded.token_ids_json,
          selected_token_id = excluded.selected_token_id,
          signed_message = excluded.signed_message,
          signature = excluded.signature,
          updated_at = excluded.updated_at
      `)
      .run(
        address.toLowerCase(),
        JSON.stringify(sortedTokenIds),
        selected,
        signedMessage,
        signature,
        timestamp,
        timestamp
      );

    return this.getAuth();
  }

  getAuth() {
    const row = this.db.prepare("SELECT * FROM auth_state WHERE id = 1").get();
    if (!row) {
      return null;
    }

    let tokenIds = [];
    try {
      tokenIds = JSON.parse(row.token_ids_json || "[]").map(Number);
    } catch {
      tokenIds = [];
    }

    return {
      address: row.address,
      tokenIds,
      selectedTokenId: row.selected_token_id === null ? null : Number(row.selected_token_id),
      signedMessage: row.signed_message,
      signature: row.signature,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  clearAuth() {
    this.db.prepare("DELETE FROM auth_state WHERE id = 1").run();
    return { loggedOut: true };
  }

  selectToken(tokenId) {
    const auth = this.getAuth();
    if (!auth) {
      throw new Error("Not logged in. Run `normies login` first.");
    }

    const selected = Number(tokenId);
    if (!auth.tokenIds.includes(selected)) {
      throw new Error(`Token ${selected} is not owned by ${auth.address}.`);
    }

    const timestamp = nowIso();
    this.db
      .prepare("UPDATE auth_state SET selected_token_id = ?, updated_at = ? WHERE id = 1")
      .run(selected, timestamp);

    return this.getAuth();
  }

  async refreshAuth({ api, maxAgeMs = DEFAULT_AUTH_REFRESH_MS, force = false } = {}) {
    const auth = this.getAuth();
    if (!auth) {
      throw new Error("Login required. Run `normies login`, then pick an owned Normie.");
    }

    if (!force && !isRefreshDue(auth.updatedAt, maxAgeMs)) {
      return auth;
    }

    if (!api?.getHolderTokens) {
      throw new Error("Cannot refresh holder access without a Normies API client.");
    }

    let ownership;
    try {
      ownership = await api.getHolderTokens(auth.address);
    } catch (error) {
      throw new Error(`Could not refresh Normies ownership: ${error?.message || String(error)}`);
    }

    const tokenIds = normalizeTokenIds(ownership?.tokenIds);
    if (tokenIds.length === 0) {
      this.clearAuth();
      throw new Error("Holder access expired. This wallet no longer holds any Normies.");
    }

    const selectedTokenId = tokenIds.includes(auth.selectedTokenId)
      ? auth.selectedTokenId
      : null;

    return this.saveAuth({
      address: auth.address,
      tokenIds,
      selectedTokenId,
      signedMessage: auth.signedMessage,
      signature: auth.signature
    });
  }

  async requireFreshTokenAccess(tokenId, options) {
    await this.refreshAuth(options);
    return this.requireTokenAccess(tokenId);
  }

  requireTokenAccess(tokenId) {
    const auth = this.getAuth();
    if (!auth) {
      throw new Error("Login required. Run `normies login`, then pick an owned Normie.");
    }

    const requestedTokenId = tokenId ?? auth.selectedTokenId;
    const requested = Number(requestedTokenId);
    if (requestedTokenId === undefined || requestedTokenId === null || !Number.isInteger(requested)) {
      throw new Error("No Normie selected. Run `normies use <tokenId>` or pass tokenId.");
    }

    if (!auth.tokenIds.includes(requested)) {
      throw new Error(`Access denied. Token ${requested} is not owned by ${auth.address}.`);
    }

    return { ...auth, tokenId: requested };
  }
}

function deserializeMessage(row) {
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata_json || "{}");
  } catch {
    metadata = {};
  }

  return {
    id: row.id,
    session_id: row.session_id,
    token_id: row.token_id,
    role: row.role,
    content: row.content,
    metadata,
    created_at: row.created_at
  };
}

function isRefreshDue(updatedAt, maxAgeMs) {
  const maxAge = Number(maxAgeMs);
  if (!Number.isFinite(maxAge) || maxAge <= 0) {
    return true;
  }

  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return true;
  }

  return Date.now() - timestamp > maxAge;
}

function normalizeTokenIds(tokenIds = []) {
  return [...new Set(tokenIds.map(Number))]
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
}
