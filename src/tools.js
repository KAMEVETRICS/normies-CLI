import { NormiesApiClient, buildUnregisteredAgentMessage } from "./api.js";
import { AgentCapabilityClient } from "./agent-capabilities.js";
import { checkGuardrails } from "./guardrails.js";
import { getAuthMode } from "./config.js";
import { NormiesStore } from "./store.js";

export function createToolContext(overrides = {}) {
  return {
    api: overrides.api || new NormiesApiClient(),
    capabilities: overrides.capabilities || new AgentCapabilityClient(),
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
      let registration = null;
      if (!requested.agentId) {
        const auth = await getRefreshedAuth(ctx);
        if (!auth) {
          throw new Error("Login required. Run `normies login`, then pick an owned Normie.");
        }
        registration = await ctx.api.getAgentRegistrationStatus(auth.tokenIds);
        const tokenId = requested.tokenId ?? auth.selectedTokenId;
        if (tokenId === undefined || tokenId === null) {
          return unavailableAgentContext({
            auth,
            registration,
            message: registration.hasRegisteredAgents
              ? "No registered Normie agent is selected. Run `normies use <tokenId>` with a registeredAgentTokenId."
              : "You own Normie(s), but none of them are registered as agents yet."
          });
        }

        const requestedTokenId = Number(tokenId);
        if (!auth.tokenIds.includes(requestedTokenId)) {
          throw new Error(`Access denied. Token ${requestedTokenId} is not owned by ${auth.address}.`);
        }
        if (!registration.registeredAgentTokenIds.includes(requestedTokenId)) {
          return unavailableAgentContext({
            auth,
            registration,
            tokenId: requestedTokenId,
            message: buildUnregisteredAgentMessage(requestedTokenId)
          });
        }

        requested.tokenId = requestedTokenId;
      }

      const agent = await ctx.api.getAgent(requested);
      const tokenId = Number(agent.tokenId ?? requested.tokenId ?? args.tokenId);
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
        registeredAgentTokenIds: registration?.registeredAgentTokenIds,
        unregisteredTokenIds: registration?.unregisteredTokenIds,
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
      const registration = auth ? await ctx.api.getAgentRegistrationStatus(auth.tokenIds) : null;
      return auth
        ? {
            loggedIn: true,
            address: auth.address,
            selectedTokenId: auth.selectedTokenId,
            tokenIds: auth.tokenIds,
            ...registrationFields(registration),
            updatedAt: auth.updatedAt,
            diagnostics: authDiagnostics(ctx)
          }
        : {
            loggedIn: false,
            nextStep: "Run `normies login` in a terminal.",
            diagnostics: authDiagnostics(ctx)
          };
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
      const registration = await ctx.api.getAgentRegistrationStatus(auth.tokenIds);

      return {
        address: auth.address,
        selectedTokenId: auth.selectedTokenId,
        tokenIds: auth.tokenIds,
        ...registrationFields(registration)
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
      const refreshedAuth = await ctx.store.refreshAuth({ api: ctx.api, force: true });
      const requestedTokenId = Number(args.tokenId);
      if (!refreshedAuth.tokenIds.includes(requestedTokenId)) {
        throw new Error(`Access denied. Token ${requestedTokenId} is not owned by ${refreshedAuth.address}.`);
      }

      const registration = await ctx.api.getAgentRegistrationStatus(refreshedAuth.tokenIds);
      if (!registration.registeredAgentTokenIds.includes(requestedTokenId)) {
        throw new Error(buildUnregisteredAgentMessage(requestedTokenId));
      }

      const auth = ctx.store.selectToken(args.tokenId);
      return {
        selectedTokenId: auth.selectedTokenId,
        address: auth.address,
        tokenIds: auth.tokenIds,
        ...registrationFields(registration)
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
  },
  {
    name: "normies_agentroom_join",
    description: "Join an AgentRoom coordination room using the logged-in holder wallet address. No wallet signing or payment is performed.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: {
          type: "string",
          description: "Named AgentRoom room id to join for coordination."
        }
      },
      required: ["roomId"]
    },
    handler: async (args, ctx) => {
      const auth = await getRequiredAuth(ctx);
      const result = await getCapabilities(ctx).joinAgentRoom({
        roomId: args.roomId,
        wallet: auth.address
      });

      return {
        capability: "AgentRoom",
        roomId: args.roomId,
        wallet: auth.address,
        result,
        safetyBoundary: [
          "AgentRoom coordination does not grant wallet authority.",
          "Do not share private keys, seed phrases, or transaction-signing instructions in rooms.",
          "Use the room for coordination, voting, and signals only."
        ]
      };
    }
  },
  {
    name: "normies_swarmskill_prepare_session",
    description: "Prepare a SwarmSkill coin-trading session request. This does not sign x402, spend funds, buy, or sell; the user must approve and run the payment flow outside Claude.",
    inputSchema: {
      type: "object",
      properties: {
        minParticipants: {
          type: "integer",
          minimum: 2,
          maximum: 500,
          description: "Quorum for the session. Defaults to SwarmSkill service default."
        },
        maxParticipants: {
          type: "integer",
          minimum: 2,
          maximum: 500,
          description: "Participant cap. Must be greater than or equal to minParticipants when both are provided."
        },
        joinWindowMinutes: {
          type: "integer",
          minimum: 5,
          maximum: 1440,
          description: "How long agents may join before activation or expiry."
        }
      }
    },
    handler: async (args, ctx) => {
      const auth = await getRequiredAuth(ctx);
      const prepared = getCapabilities(ctx).prepareSwarmSkillSession(args);
      return {
        ...prepared,
        holderAddress: auth.address,
        claudeInstructions: [
          "Present this as a prepared trading-session request, not an executed trade.",
          "Require explicit user review before any x402 wallet action.",
          "Do not claim the Normie has bought, sold, voted, joined, or funded the session.",
          "Tell the user that all trading risk and wallet signing must happen outside Claude."
        ]
      };
    }
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

async function getRequiredAuth(ctx, options) {
  const auth = await getRefreshedAuth(ctx, options);
  if (!auth) {
    throw new Error("Login required. Run `normies login` before using external agent capabilities.");
  }

  return auth;
}

function getCapabilities(ctx) {
  return ctx.capabilities || new AgentCapabilityClient();
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

function authDiagnostics(ctx) {
  return {
    authMode: getAuthMode(),
    normiesHome: ctx.store.home
  };
}

function registrationFields(registration) {
  if (!registration) {
    return {};
  }

  return {
    registeredAgentTokenIds: registration.registeredAgentTokenIds,
    unregisteredTokenIds: registration.unregisteredTokenIds,
    registerUrl: registration.registerUrl,
    hasRegisteredAgents: registration.hasRegisteredAgents
  };
}

function unavailableAgentContext({ auth, registration, tokenId, message }) {
  return {
    agentRegistered: false,
    tokenId: tokenId ?? null,
    address: auth.address,
    selectedTokenId: auth.selectedTokenId,
    tokenIds: auth.tokenIds,
    ...registrationFields(registration),
    nextStep: message,
    responseProtocol: {
      defaultMode: "outOfCharacter",
      outOfCharacterPrefix: "[CLAUDE | OUT OF CHARACTER]",
      rules: [
        "Do not speak as the Normie because no registered agent context is available.",
        "Tell the user they own the token but must register it as an agent before Claude can use it.",
        "Share the registerUrl when helpful."
      ]
    },
    claudeInstructions: [
      "Begin with [CLAUDE | OUT OF CHARACTER].",
      message,
      `Agent registration page: ${registration?.registerUrl || "https://www.normies.art/lab/agentic/agents/"}`
    ]
  };
}
