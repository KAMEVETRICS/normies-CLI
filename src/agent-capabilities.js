export const AGENTROOM_JOIN_URL = "https://agentroom-navy.vercel.app/api/room/join";
export const SWARMSKILL_CREATE_URL = "https://swarm-skill.vercel.app/api/session/create";
export const SWARMSKILL_REGISTRY = "0x265bb2dbfc0a8165c9a1941eb1372f349bad2cf1";
export const SWARMSKILL_TOOL_ID = 25;
export const SWARMSKILL_CHAIN_ID = 1;
export const SWARMSKILL_TOOL_REF = `${SWARMSKILL_CHAIN_ID},${SWARMSKILL_REGISTRY},${SWARMSKILL_TOOL_ID}`;

export class AgentCapabilityClient {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async joinAgentRoom({ roomId, wallet }) {
    const body = {
      roomId: requireNonEmptyString(roomId, "roomId"),
      wallet: requireNonEmptyString(wallet, "wallet")
    };
    return this.postJson(AGENTROOM_JOIN_URL, body);
  }

  prepareSwarmSkillSession(args = {}) {
    const body = normalizeSwarmSkillBody(args);
    const bodyJson = JSON.stringify(body);

    return {
      capability: "SwarmSkill",
      endpoint: SWARMSKILL_CREATE_URL,
      method: "POST",
      body,
      state: "requires_user_x402_approval",
      requiresUserApproval: true,
      requiresWalletSignature: true,
      executesTrade: false,
      minInvestmentUsdPerAgent: 25,
      flow: [
        "15-minute coin vote",
        "Minimum $25 worth of SOL per participating agent",
        "10-minute hold-duration vote",
        "Coordinated sell",
        "On-chain buy/sell verification",
        "Profit split proportional to each agent investment"
      ],
      safetyBoundary: [
        "Normies MCP prepares the request only.",
        "Claude and the Normie agent must not sign x402 payments.",
        "Claude and the Normie agent must not execute buys, sells, transfers, or approvals.",
        "The user must review, approve, and run the x402 payment flow outside the agent runtime."
      ],
      x402: {
        protocol: "x402",
        chainId: SWARMSKILL_CHAIN_ID,
        registry: SWARMSKILL_REGISTRY,
        toolId: SWARMSKILL_TOOL_ID,
        toolRef: SWARMSKILL_TOOL_REF,
        command: `npx @opensea/tool-sdk pay "${SWARMSKILL_CREATE_URL}" --body '${bodyJson}' --tool-ref ${SWARMSKILL_TOOL_REF}`
      },
      nextStep: "Ask the user to review the trading risk and run the x402 command themselves if they want to create the session."
    };
  }

  async postJson(url, body) {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "normies-cli/0.1.0"
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throw new Error(`Agent capability request failed with HTTP ${response.status}: ${stringifyErrorBody(parsed)}`);
    }

    return parsed;
  }
}

export function normalizeSwarmSkillBody({ maxParticipants, minParticipants, joinWindowMinutes } = {}) {
  const body = {};
  const min = optionalBoundedInteger(minParticipants, "minParticipants", 2, 500);
  const max = optionalBoundedInteger(maxParticipants, "maxParticipants", 2, 500);
  const joinWindow = optionalBoundedInteger(joinWindowMinutes, "joinWindowMinutes", 5, 1440);

  if (min !== undefined) {
    body.minParticipants = min;
  }
  if (max !== undefined) {
    body.maxParticipants = max;
  }
  if (joinWindow !== undefined) {
    body.joinWindowMinutes = joinWindow;
  }
  if (body.maxParticipants !== undefined && body.minParticipants !== undefined && body.maxParticipants < body.minParticipants) {
    throw new Error("maxParticipants must be greater than or equal to minParticipants.");
  }

  return body;
}

function optionalBoundedInteger(value, name, min, max) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }

  return number;
}

function requireNonEmptyString(value, name) {
  const string = String(value ?? "").trim();
  if (!string) {
    throw new Error(`${name} is required.`);
  }

  return string;
}

function stringifyErrorBody(body) {
  if (body === null || body === undefined || body === "") {
    return "empty response";
  }

  if (typeof body === "string") {
    return body.slice(0, 500);
  }

  return JSON.stringify(body).slice(0, 500);
}
