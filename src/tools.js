import { NormiesApiClient } from "./api.js";
import { checkGuardrails } from "./guardrails.js";
import { NormiesStore } from "./store.js";

export function createToolContext(overrides = {}) {
  return {
    api: overrides.api || new NormiesApiClient(),
    store: overrides.store || new NormiesStore()
  };
}

export const toolDefinitions = [
  {
    name: "normies_get_agent",
    description: "Fetch rich Normies agent/persona information by tokenId or agentId.",
    inputSchema: {
      type: "object",
      properties: {
        tokenId: { type: "integer", description: "Normie token id." },
        agentId: { type: "integer", description: "ERC-8004 agent id." }
      }
    },
    handler: async (args, ctx) => ctx.api.getAgent(args)
  },
  {
    name: "normies_list_agents",
    description: "List registered Normies agents.",
    inputSchema: {
      type: "object",
      properties: {
        sort: { type: "string", default: "newest" },
        limit: { type: "integer", default: 10 },
        cursor: { type: "string" }
      }
    },
    handler: async (args, ctx) => ctx.api.listAgents(args)
  },
  {
    name: "normies_search_agents",
    description: "Search registered Normies agents by name or text.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        limit: { type: "integer", default: 10 }
      },
      required: ["q"]
    },
    handler: async (args, ctx) => ctx.api.searchAgents(args)
  },
  {
    name: "normies_get_agent_card",
    description: "Fetch a Normies A2A agent card for a token.",
    inputSchema: {
      type: "object",
      properties: {
        tokenId: { type: "integer" }
      },
      required: ["tokenId"]
    },
    handler: async (args, ctx) => ctx.api.getAgentCard(args.tokenId)
  },
  {
    name: "normies_chat_context",
    description: "Build Claude-ready context for speaking as or with an owned Normies agent. Requires `normies login`.",
    inputSchema: {
      type: "object",
      properties: {
        tokenId: { type: "integer" },
        agentId: { type: "integer" },
        sessionId: { type: "string" },
        recentLimit: { type: "integer", default: 20 },
        memoryLimit: { type: "integer", default: 10 }
      }
    },
    handler: async (args, ctx) => {
      const requested = { ...args };
      if (!requested.tokenId && !requested.agentId) {
        const access = await ctx.store.requireFreshTokenAccess(undefined, { api: ctx.api });
        requested.tokenId = access.tokenId;
      } else if (requested.tokenId) {
        await ctx.store.requireFreshTokenAccess(requested.tokenId, { api: ctx.api });
      } else {
        const auth = ctx.store.getAuth();
        if (!auth) {
          throw new Error("Login required. Run `normies login`, then pick an owned Normie.");
        }
      }

      const agent = await ctx.api.getAgent(requested);
      const tokenId = Number(agent.tokenId ?? args.tokenId);
      await ctx.store.requireFreshTokenAccess(tokenId, { api: ctx.api });
      const memories = ctx.store.listMemories({ tokenId, limit: args.memoryLimit ?? 10 });
      const recentMessages = ctx.store.listMessages({
        tokenId,
        sessionId: args.sessionId,
        limit: args.recentLimit ?? 20
      });
      const modeLabels = {
        inCharacter: `[NORMIE #${tokenId} | ${agent.name} | IN CHARACTER]`,
        outOfCharacter: "[CLAUDE | OUT OF CHARACTER]"
      };

      return {
        tokenId,
        agentId: agent.agentId,
        name: agent.name,
        type: agent.type,
        tagline: agent.tagline,
        greeting: agent.greeting,
        systemPrompt: agent.systemPrompt,
        traits: agent.traits,
        canvas: agent.canvas,
        memories,
        recentMessages,
        modeLabels,
        responseProtocol: {
          defaultMode: "inCharacter",
          inCharacterPrefix: modeLabels.inCharacter,
          outOfCharacterPrefix: modeLabels.outOfCharacter,
          rules: [
            "When speaking as the Normie, begin the response with the inCharacterPrefix on its own line.",
            "When explaining setup, auth, tool errors, safety boundaries, or MCP behavior, begin with the outOfCharacterPrefix on its own line.",
            "Do not mix in-character and out-of-character narration in the same paragraph.",
            "If both are needed, split them into separate labeled sections."
          ]
        },
        claudeInstructions: [
          "Use the Normie's systemPrompt as the character and safety frame.",
          `When speaking as this Normie, prefix the response with: ${modeLabels.inCharacter}`,
          `When speaking as Claude about tooling, setup, auth, errors, or safety boundaries, prefix the response with: ${modeLabels.outOfCharacter}`,
          "Keep mode labels visible so users can always distinguish agent speech from Claude/system explanation.",
          "Never present out-of-character tool explanations as the Normie's own voice.",
          "Do not claim to execute wallet actions, sign transactions, transfer assets, or bypass safety rails.",
          "When the user shares durable preferences or facts, ask whether to save them before calling normies_save_memory.",
          "Use normies_save_chat_message for user and assistant turns when the user wants chat history saved."
        ]
      };
    }
  },
  {
    name: "normies_save_chat_message",
    description: "Save one chat message to the local Normies chat store for an owned token. Requires `normies login`.",
    inputSchema: {
      type: "object",
      properties: {
        tokenId: { type: "integer" },
        sessionId: { type: "string" },
        role: { type: "string", enum: ["user", "assistant", "tool", "system"] },
        content: { type: "string" },
        metadata: { type: "object" }
      },
      required: ["tokenId", "role", "content"]
    },
    handler: async (args, ctx) => {
      const access = await ctx.store.requireFreshTokenAccess(args.tokenId, { api: ctx.api });
      return ctx.store.addMessage({ ...args, tokenId: access.tokenId });
    }
  },
  {
    name: "normies_recent_chat",
    description: "Read recent locally saved chat messages for an owned Normies token or session. Requires `normies login`.",
    inputSchema: {
      type: "object",
      properties: {
        tokenId: { type: "integer" },
        sessionId: { type: "string" },
        limit: { type: "integer", default: 20 }
      }
    },
    handler: async (args, ctx) => {
      const access = await ctx.store.requireFreshTokenAccess(resolveStoredTokenId(ctx.store, args), { api: ctx.api });
      return ctx.store.listMessages({ ...args, tokenId: access.tokenId });
    }
  },
  {
    name: "normies_save_memory",
    description: "Save a small, approved memory for an owned Normies agent. Do not use for secrets. Requires `normies login`.",
    inputSchema: {
      type: "object",
      properties: {
        tokenId: { type: "integer" },
        scope: { type: "string", default: "holder" },
        content: { type: "string" },
        source: { type: "string", default: "claude" }
      },
      required: ["tokenId", "content"]
    },
    handler: async (args, ctx) => {
      const access = await ctx.store.requireFreshTokenAccess(args.tokenId, { api: ctx.api });
      return ctx.store.addMemory({ ...args, tokenId: access.tokenId });
    }
  },
  {
    name: "normies_search_memory",
    description: "Search locally saved memories for an owned Normies agent. Requires `normies login`.",
    inputSchema: {
      type: "object",
      properties: {
        tokenId: { type: "integer" },
        q: { type: "string" },
        limit: { type: "integer", default: 20 }
      },
      required: ["tokenId"]
    },
    handler: async (args, ctx) => {
      const access = await ctx.store.requireFreshTokenAccess(args.tokenId, { api: ctx.api });
      return ctx.store.listMemories({ ...args, tokenId: access.tokenId });
    }
  },
  {
    name: "normies_auth_status",
    description: "Show whether the local Normies MCP session is logged in and which token is selected.",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async (_args, ctx) => {
      const auth = await getRefreshedAuth(ctx);
      return auth
        ? {
            loggedIn: true,
            address: auth.address,
            selectedTokenId: auth.selectedTokenId,
            tokenIds: auth.tokenIds,
            updatedAt: auth.updatedAt
          }
        : { loggedIn: false, nextStep: "Run `normies login` in a terminal." };
    }
  },
  {
    name: "normies_owned_tokens",
    description: "List the Normies owned by the locally signed-in wallet.",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async (_args, ctx) => {
      const auth = await getRefreshedAuth(ctx, { force: true });
      if (!auth) {
        throw new Error("Not logged in. Run `normies login` in a terminal.");
      }

      return {
        address: auth.address,
        selectedTokenId: auth.selectedTokenId,
        tokenIds: auth.tokenIds
      };
    }
  },
  {
    name: "normies_select_token",
    description: "Select which owned Normie Claude should use by default.",
    inputSchema: {
      type: "object",
      properties: {
        tokenId: { type: "integer" }
      },
      required: ["tokenId"]
    },
    handler: async (args, ctx) => {
      await ctx.store.refreshAuth({ api: ctx.api, force: true });
      const auth = ctx.store.selectToken(args.tokenId);
      return {
        selectedTokenId: auth.selectedTokenId,
        address: auth.address,
        tokenIds: auth.tokenIds
      };
    }
  },
  {
    name: "normies_guardrail_check",
    description: "Check whether a proposed Normies action is safe for the no-wallet-authority runtime.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        payload: { type: "object" }
      },
      required: ["action"]
    },
    handler: async (args) => checkGuardrails(args)
  }
];

export async function callTool(name, args, ctx) {
  const tool = toolDefinitions.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const result = await tool.handler(args ?? {}, ctx);
  ctx.store.addAuditLog({
    tool: name,
    input: args,
    resultSummary: summarizeResult(result)
  });
  return result;
}

function summarizeResult(result) {
  if (result === null || result === undefined) {
    return "empty";
  }

  if (Array.isArray(result)) {
    return `array(${result.length})`;
  }

  if (typeof result === "object") {
    const keys = Object.keys(result).slice(0, 8).join(", ");
    return `object(${keys})`;
  }

  return String(result).slice(0, 200);
}

async function getRefreshedAuth(ctx, options) {
  const auth = ctx.store.getAuth();
  if (!auth) {
    return null;
  }

  return ctx.store.refreshAuth({ api: ctx.api, ...options });
}

function resolveStoredTokenId(store, args) {
  if (args.tokenId !== undefined && args.tokenId !== null) {
    return args.tokenId;
  }

  if (args.sessionId) {
    return store.getSession(args.sessionId)?.token_id;
  }

  return undefined;
}
