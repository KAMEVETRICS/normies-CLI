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
