import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApiUrl, getAuthMode, getNormiesHome } from "./config.js";
import {
  buildClaudeConfigFragment,
  getClaudeConfigStatus,
  writeClaudeConfig
} from "./claude-config.js";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), "..");
const BIN_PATH = path.join(PROJECT_ROOT, "bin", "normies.js");

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const [command, ...rest] = parsed.positionals;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  switch (command) {
    case "mcp": {
      const { runMcpServer } = await import("./mcp.js");
      await runMcpServer();
      return;
    }

    case "claude-config":
      await handleClaudeConfig(parsed.options);
      return;

    case "doctor":
    case "diagnose":
      await diagnose();
      return;

    case "agent":
    case "show":
      await showAgent(rest[0], parsed.options);
      return;

    case "agents":
      if (rest[0] === "owned") {
        await listOwnedAgents(parsed.options);
        return;
      }
      await listAgents(parsed.options);
      return;

    case "list":
      await listAgents(parsed.options);
      return;

    case "login":
      await login(parsed.options);
      return;

    case "whoami":
      await whoami();
      return;

    case "logout":
      await logout();
      return;

    case "use":
      await useToken(rest[0]);
      return;

    case "card":
      await showAgentCard(rest[0]);
      return;

    case "context":
      await showChatContext(rest[0], parsed.options);
      return;

    case "memory":
      await handleMemory(rest, parsed.options);
      return;

    case "chat":
      await saveChatMessage(rest, parsed.options);
      return;

    case "chats":
      await listChats(rest[0], parsed.options);
      return;

    default:
      throw new Error(`Unknown command "${command}". Run "normies --help".`);
  }
}

async function showAgent(tokenId, options) {
  if (!tokenId && !options.agentId) {
    throw new Error("Usage: normies agent <tokenId> or normies agent --agent-id <agentId>");
  }

  const { NormiesApiClient } = await import("./api.js");
  const api = new NormiesApiClient();
  const agent = await api.getAgent({ tokenId, agentId: options.agentId });
  printJson(agent);
}

async function listAgents(options) {
  const { NormiesApiClient } = await import("./api.js");
  const api = new NormiesApiClient();
  const result = await api.listAgents({
    sort: options.sort || "newest",
    limit: Number(options.limit || 10),
    cursor: options.cursor
  });
  printJson(result);
}

async function login(options) {
  const { runLoginFlow } = await import("./auth.js");
  const timeoutSeconds = Number(options.timeout || 120);
  console.error("Opening local Normies login. Sign the message in your wallet; no transaction is requested.");
  const auth = await runLoginFlow({
    shouldOpenBrowser: !options.noOpen,
    timeoutMs: timeoutSeconds * 1000
  });
  printJson(authSummary(auth));
}

async function whoami() {
  const { NormiesStore } = await import("./store.js");
  const store = new NormiesStore();
  const auth = store.getAuth();
  printJson(auth ? authSummary(auth) : { loggedIn: false });
}

async function logout() {
  const { NormiesStore } = await import("./store.js");
  const store = new NormiesStore();
  printJson(store.clearAuth());
}

async function useToken(tokenId) {
  if (!tokenId) {
    throw new Error("Usage: normies use <tokenId>");
  }

  const { NormiesApiClient, buildUnregisteredAgentMessage } = await import("./api.js");
  const { NormiesStore } = await import("./store.js");
  const api = new NormiesApiClient();
  const store = new NormiesStore();
  const refreshedAuth = await store.refreshAuth({ api, force: true });
  const requestedTokenId = Number(tokenId);
  if (!refreshedAuth.tokenIds.includes(requestedTokenId)) {
    throw new Error(`Access denied. Token ${requestedTokenId} is not owned by ${refreshedAuth.address}.`);
  }

  const registration = await api.getAgentRegistrationStatus(refreshedAuth.tokenIds);
  if (!registration.registeredAgentTokenIds.includes(requestedTokenId)) {
    throw new Error(buildUnregisteredAgentMessage(requestedTokenId));
  }

  printJson(authSummary(store.selectToken(requestedTokenId), registration));
}

async function listOwnedAgents(options) {
  const { NormiesApiClient } = await import("./api.js");
  const { NormiesStore } = await import("./store.js");
  const api = new NormiesApiClient();

  if (options.address) {
    const ownership = await api.getHolderTokens(options.address);
    const registration = await api.getAgentRegistrationStatus(ownership.tokenIds);
    printJson(holderAgentSummary(ownership, registration));
    return;
  }

  const store = new NormiesStore();
  const auth = store.getAuth();
  if (!auth) {
    throw new Error("Not logged in. Run `normies login`, or pass `--address 0x...` to inspect a public holder.");
  }

  const refreshedAuth = await store.refreshAuth({ api, force: true });
  const registration = await api.getAgentRegistrationStatus(refreshedAuth.tokenIds);
  printJson(holderAgentSummary(refreshedAuth, registration));
}

async function showAgentCard(tokenId) {
  if (!tokenId) {
    throw new Error("Usage: normies card <tokenId>");
  }

  const { NormiesApiClient } = await import("./api.js");
  const api = new NormiesApiClient();
  printJson(await api.getAgentCard(tokenId));
}

async function showChatContext(tokenId, options) {
  if (!tokenId && !options.agentId) {
    throw new Error("Usage: normies context <tokenId> or normies context --agent-id <agentId>");
  }

  const { callTool, createToolContext } = await import("./tools.js");
  const ctx = createToolContext();
  const result = await callTool("normies_chat_context", {
    tokenId: tokenId ? Number(tokenId) : undefined,
    agentId: options.agentId ? Number(options.agentId) : undefined,
    sessionId: options.session,
    recentLimit: Number(options.recent || 20),
    memoryLimit: Number(options.memories || 10)
  }, ctx);
  printJson(result);
}

async function handleMemory(rest, options) {
  const [subcommand, tokenId, ...contentParts] = rest;
  if (!subcommand || !tokenId) {
    throw new Error("Usage: normies memory add <tokenId> <text> | normies memory list <tokenId>");
  }

  const { NormiesApiClient } = await import("./api.js");
  const { NormiesStore } = await import("./store.js");
  const api = new NormiesApiClient();
  const store = new NormiesStore();

  if (subcommand === "add") {
    const content = options.message || contentParts.join(" ");
    if (!content) {
      throw new Error("Usage: normies memory add <tokenId> <text>");
    }
    const access = await store.requireFreshTokenAccess(Number(tokenId), { api });
    printJson(store.addMemory({ tokenId: access.tokenId, content, source: "cli" }));
    return;
  }

  if (subcommand === "list" || subcommand === "search") {
    const access = await store.requireFreshTokenAccess(Number(tokenId), { api });
    printJson(store.listMemories({
      tokenId: access.tokenId,
      q: options.q || contentParts.join(" ") || undefined,
      limit: Number(options.limit || 20)
    }));
    return;
  }

  throw new Error(`Unknown memory command "${subcommand}".`);
}

async function saveChatMessage(rest, options) {
  const [tokenId, ...contentParts] = rest;
  const content = options.message || contentParts.join(" ");
  if (!tokenId || !content) {
    throw new Error("Usage: normies chat <tokenId> --role user --message \"hello\"");
  }

  const { NormiesApiClient } = await import("./api.js");
  const { NormiesStore } = await import("./store.js");
  const api = new NormiesApiClient();
  const store = new NormiesStore();
  const access = await store.requireFreshTokenAccess(Number(tokenId), { api });
  printJson(store.addMessage({
    tokenId: access.tokenId,
    sessionId: options.session,
    role: options.role || "user",
    content,
    metadata: { source: "cli" }
  }));
}

async function listChats(tokenId, options) {
  if (!tokenId && !options.session && !options.sessions) {
    throw new Error("Usage: normies chats <tokenId> or normies chats --session <sessionId>");
  }

  const { NormiesApiClient } = await import("./api.js");
  const { NormiesStore } = await import("./store.js");
  const api = new NormiesApiClient();
  const store = new NormiesStore();
  const sessionTokenId = !tokenId && options.session
    ? store.getSession(options.session)?.token_id
    : undefined;
  const requestedTokenId = tokenId ? Number(tokenId) : sessionTokenId;
  const access = await store.requireFreshTokenAccess(requestedTokenId, { api });
  if (options.sessions) {
    printJson(store.listSessions({ tokenId: access.tokenId, limit: Number(options.limit || 20) }));
    return;
  }

  printJson(store.listMessages({
    tokenId: access.tokenId,
    sessionId: options.session,
    limit: Number(options.limit || 20)
  }));
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
      const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const next = argv[i + 1];
      if (inlineValue !== undefined) {
        options[key] = inlineValue;
      } else if (next && !next.startsWith("-")) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { options, positionals };
}

async function handleClaudeConfig(options) {
  if (options.write) {
    printJson(writeClaudeConfig({
      binPath: BIN_PATH,
      targetPath: options.path,
      force: Boolean(options.force)
    }));
    return;
  }

  if (options.status || options.diagnose) {
    printJson(getClaudeConfigStatus({ targetPath: options.path }));
    return;
  }

  printJson(buildClaudeConfigFragment({ binPath: BIN_PATH }));
}

async function diagnose() {
  const { NormiesStore } = await import("./store.js");
  const store = new NormiesStore();
  const auth = store.getAuth();
  printJson({
    ok: true,
    node: {
      version: process.version,
      execPath: process.execPath
    },
    normies: {
      apiUrl: getApiUrl(),
      home: getNormiesHome(),
      authMode: getAuthMode(),
      binPath: BIN_PATH,
      loggedIn: Boolean(auth),
      session: auth ? authSummary(auth) : null
    },
    claude: getClaudeConfigStatus()
  });
}

function authSummary(auth, registration) {
  const summary = {
    loggedIn: true,
    address: auth.address,
    selectedTokenId: auth.selectedTokenId,
    tokenIds: auth.tokenIds,
    updatedAt: auth.updatedAt
  };

  const registeredAgentTokenIds = registration?.registeredAgentTokenIds ?? auth.registeredAgentTokenIds;
  const unregisteredTokenIds = registration?.unregisteredTokenIds ?? auth.unregisteredTokenIds;
  if (registeredAgentTokenIds) {
    summary.registeredAgentTokenIds = registeredAgentTokenIds;
  }
  if (unregisteredTokenIds) {
    summary.unregisteredTokenIds = unregisteredTokenIds;
  }
  if (registration?.registerUrl || auth.registerUrl) {
    summary.registerUrl = registration?.registerUrl || auth.registerUrl;
  }

  return summary;
}

function holderAgentSummary(holder, registration) {
  return {
    address: holder.address,
    selectedTokenId: holder.selectedTokenId ?? null,
    tokenIds: holder.tokenIds,
    registeredAgentTokenIds: registration.registeredAgentTokenIds,
    unregisteredTokenIds: registration.unregisteredTokenIds,
    registerUrl: registration.registerUrl,
    nextStep: registration.hasRegisteredAgents
      ? "Use `normies use <tokenId>` with a registeredAgentTokenId."
      : "Register an owned Normie as an agent before using it in Claude."
  };
}

function printHelp() {
  console.log(`Normies CLI

Usage:
  normies agent <tokenId>                  Fetch rich agent/persona info
  normies agents --limit 10                List registered agents
  normies agents owned                     List owned Normies after login
  normies login                            Sign in with wallet ownership proof
  normies whoami                           Show local holder session
  normies use <tokenId>                    Select default owned Normie
  normies logout                           Clear local holder session
  normies card <tokenId>                   Fetch A2A agent card
  normies context <tokenId>                Build Claude-ready chat context
  normies memory add <tokenId> <text>      Save a local memory
  normies memory list <tokenId>            List local memories
  normies chat <tokenId> --message <text>  Save a chat message locally
  normies chats <tokenId>                  List recent chat messages
  normies chats --sessions                 List saved sessions
  normies claude-config                    Print Claude Desktop MCP config
  normies claude-config --write            Install/update Claude MCP config
  normies claude-config --status           Diagnose Claude MCP config files
  normies doctor                           Print local setup diagnostics
  normies mcp                              Run the MCP stdio server

Environment:
  NORMIES_API_URL      Defaults to https://api.normies.art
  NORMIES_HOME         Defaults to ~/.normies
`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
