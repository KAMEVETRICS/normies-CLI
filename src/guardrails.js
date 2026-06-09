const BLOCKED_ACTION_PATTERNS = [
  /private\s+key/i,
  /seed\s+phrase/i,
  /recovery\s+phrase/i,
  /sign\s+transaction/i,
  /transfer\s+(eth|token|nft|asset)/i,
  /delegate\s+wallet/i,
  /approve\s+spender/i,
  /connect\s+wallet/i
];

export function checkGuardrails({ action = "", payload = {} } = {}) {
  const serialized = `${action}\n${JSON.stringify(payload)}`;
  const reasons = [];

  for (const pattern of BLOCKED_ACTION_PATTERNS) {
    if (pattern.test(serialized)) {
      reasons.push(`Matched blocked wallet/action phrase: ${pattern.source}`);
    }
  }

  const writeLike = /register|awaken|canvas|memory|save|proposal|transaction|delegate/i.test(action);
  const allowed = reasons.length === 0;

  return {
    allowed,
    mode: writeLike ? "proposal_or_app_write_only" : "read_only",
    reasons,
    guidance: allowed
      ? "Allowed for CLI/MCP execution. Keep any wallet transaction outside the agent runtime."
      : "Blocked. Normies agents must not request secrets, pressure signing, or execute wallet actions."
  };
}
