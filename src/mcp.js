import readline from "node:readline";
import { callTool, createToolContext, toolDefinitions } from "./tools.js";

const PROTOCOL_VERSION = "2024-11-05";

export async function runMcpServer() {
  const ctx = createToolContext();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on("line", async (line) => {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      writeError(null, -32700, "Parse error", error.message);
      return;
    }

    try {
      await handleMessage(message, ctx);
    } catch (error) {
      if (message.id !== undefined) {
        writeError(message.id, -32603, error?.message || "Internal error");
      }
    }
  });
}

async function handleMessage(message, ctx) {
  if (message.id === undefined || message.id === null) {
    return;
  }

  switch (message.method) {
    case "initialize":
      writeResult(message.id, {
        protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "normies-mcp",
          version: "0.1.0"
        }
      });
      return;

    case "ping":
      writeResult(message.id, {});
      return;

    case "tools/list":
      writeResult(message.id, {
        tools: toolDefinitions.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        }))
      });
      return;

    case "tools/call": {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const result = await callTool(name, args, ctx);
      writeResult(message.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      });
      return;
    }

    case "resources/list":
      writeResult(message.id, { resources: [] });
      return;

    case "prompts/list":
      writeResult(message.id, { prompts: [] });
      return;

    default:
      writeError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id, code, message, data) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } })}\n`);
}
