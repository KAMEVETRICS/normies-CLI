import { getApiUrl } from "./config.js";

export class NormiesApiError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = "NormiesApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class NormieAgentNotRegisteredError extends Error {
  constructor(tokenId, { cause } = {}) {
    super(`Normie #${tokenId} is owned by the signed-in wallet, but it is not registered as an agent yet.`);
    this.name = "NormieAgentNotRegisteredError";
    this.tokenId = Number(tokenId);
    this.registerUrl = "https://www.normies.art/lab/agentic/agents/";
    this.cause = cause;
  }
}

export class NormiesApiClient {
  constructor({ baseUrl = getApiUrl(), fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  buildUrl(path, params = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  async getJson(path, params) {
    const url = this.buildUrl(path, params);
    const response = await this.fetchImpl(url, {
      headers: {
        "User-Agent": "normies-cli/0.1.0"
      }
    });

    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      throw new NormiesApiError(`Normies API returned ${response.status}`, {
        status: response.status,
        url: String(url),
        body
      });
    }

    return body;
  }

  async postJson(path, body) {
    const url = this.buildUrl(path);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "normies-cli/0.1.0"
      },
      body: JSON.stringify(body ?? {})
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
      throw new NormiesApiError(`Normies API returned ${response.status}`, {
        status: response.status,
        url: String(url),
        body: parsed
      });
    }

    return parsed;
  }

  async getAgent({ tokenId, agentId }) {

    if (agentId !== undefined && agentId !== null) {
      return this.getJson(`/agents/by-agent-id/${encodeURIComponent(agentId)}/info`);
    }

    return this.getJson(`/agents/info/${encodeURIComponent(tokenId)}`);
  }

  async getAgentRegistrationStatus(tokenIds = []) {
    const normalizedTokenIds = normalizeTokenIds(tokenIds);
    if (normalizedTokenIds.length === 0) {
      return registrationSummary([]);
    }


    const checks = await Promise.all(normalizedTokenIds.map((tokenId) => this.checkAgentRegistration(tokenId)));
    return registrationSummary(normalizedTokenIds, checks);
  }

  async requireRegisteredAgent(tokenId) {
    const status = await this.getAgentRegistrationStatus([tokenId]);
    if (!status.registeredAgentTokenIds.includes(Number(tokenId))) {
      throw new NormieAgentNotRegisteredError(tokenId);
    }

    return status.registeredAgents[0];
  }

  async checkAgentRegistration(tokenId) {
    try {
      const agent = await this.getAgent({ tokenId });
      return {
        tokenId: Number(tokenId),
        registered: true,
        agent
      };
    } catch (error) {
      if (isAgentNotRegisteredError(error)) {
        return {
          tokenId: Number(tokenId),
          registered: false,
          error: error.message
        };
      }

      throw new Error(`Could not check whether Normie #${tokenId} is registered as an agent: ${error?.message || String(error)}`);
    }
  }

  async getAgentCard(tokenId) {
    return this.getJson(`/agents/agent-card/${encodeURIComponent(tokenId)}`);
  }

  async getPersonaPreview(tokenId) {
    return this.getJson(`/agents/persona-preview/${encodeURIComponent(tokenId)}`);
  }

  async getAgentIdentity(tokenId) {
    return this.getJson(`/agents/identity/${encodeURIComponent(tokenId)}`);
  }

  async getHolderTokens(address) {

    const result = await this.getJson(`/holders/${encodeURIComponent(address)}`);
    return {
      address: result.address,
      tokenIds: (result.tokenIds ?? []).map((tokenId) => Number(tokenId))
    };
  }

  async getAgentBindings(tokenIds) {
    return this.postJson("/agents/binding/batch", {
      tokenIds: tokenIds.map((tokenId) => String(tokenId))
    });
  }

  async listAgents({ sort = "newest", limit = 10, cursor } = {}) {
    return this.getJson("/agents/list", { sort, limit, cursor });
  }

  async searchAgents({ q, limit = 10 } = {}) {
    return this.getJson("/agents/search", { q, limit });
  }
}

export function isAgentNotRegisteredError(error) {
  return error instanceof NormieAgentNotRegisteredError
    || (error instanceof NormiesApiError && error.status === 404);
}

export function buildUnregisteredAgentMessage(tokenId) {
  const subject = tokenId ? `Normie #${tokenId}` : "This Normie";
  return `${subject} is owned by the signed-in wallet, but it is not registered as an agent yet. Register it at https://www.normies.art/lab/agentic/agents/ before using it in Claude.`;
}

function registrationSummary(tokenIds, checks = []) {
  const registeredAgents = checks
    .filter((check) => check.registered)
    .map((check) => check.agent);
  const registeredAgentTokenIds = registeredAgents
    .map((agent) => Number(agent.tokenId))
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  const unregisteredTokenIds = tokenIds
    .filter((tokenId) => !registeredAgentTokenIds.includes(tokenId))
    .sort((a, b) => a - b);

  return {
    tokenIds,
    registeredAgentTokenIds,
    unregisteredTokenIds,
    registeredAgents,
    registerUrl: "https://www.normies.art/lab/agentic/agents/",
    hasRegisteredAgents: registeredAgentTokenIds.length > 0
  };
}

function normalizeTokenIds(tokenIds = []) {
  return [...new Set((tokenIds ?? []).map(Number))]
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
}
