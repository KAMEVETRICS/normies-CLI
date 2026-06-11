# Claude Desktop Config Setup

Use this guide if Claude Desktop does not show the Normies tools, cannot load
its app settings, or keeps reading the wrong Normies session.

## Quick Setup

From the Normies CLI project folder, run:

```bash
node ./bin/normies.js claude-config --write
```

Then check what the CLI found:

```bash
node ./bin/normies.js claude-config --status
```

After that:

1. Fully quit Claude Desktop.
2. Reopen Claude Desktop.
3. Start a fresh chat.
4. Ask: `Check my Normies auth status.`

## Config File Paths

Claude Desktop can read different config files depending on how it was installed.

Common Windows path:

```text
C:\Users\YOU\AppData\Roaming\Claude\claude_desktop_config.json
```

Windows Store Claude path:

```text
C:\Users\YOU\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
```

macOS path:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

In our Windows Store test, the working file was:

```text
C:\Users\HP\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
```

## Manual Config Shape

If automatic setup does not work, add the Normies MCP server at the top level of
`claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "normies": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\path\\to\\normies-CLI\\bin\\normies.js",
        "mcp"
      ],
      "env": {
        "NORMIES_API_URL": "https://api.normies.art",
        "NORMIES_HOME": "C:\\Users\\YOU\\.normies"
      }
    }
  }
}
```

If the file already has other settings, keep them. Only add or replace the
`mcpServers.normies` block.

## Important Rules

- `mcpServers` must be at the top level of the JSON file.
- Use absolute paths for `command`, `args`, and `NORMIES_HOME`.
- Do not put `mcpServers` inside `preferences`.
- Restart Claude Desktop after every config change.
- Start a fresh Claude chat after restarting.

## If Claude Says The JSON Is Invalid

This usually means there is a missing comma, extra comma, or pasted config block
in the wrong place.

Run:

```bash
node ./bin/normies.js claude-config --status
```

If the config is broken and you want the CLI to replace it after making a backup:

```bash
node ./bin/normies.js claude-config --write --force
```

## If Claude Is Logged Out But The CLI Is Logged In

Check that Claude and the CLI are using the same `NORMIES_HOME`.

Run:

```bash
node ./bin/normies.js whoami
node ./bin/normies.js claude-config --status
```

The `NORMIES_HOME` shown in Claude config should point to the same local state
folder used by the CLI.

## Expected Claude Test

In Claude, ask:

```text
Check my Normies auth status.
```

If setup is correct, Claude should call the Normies MCP tool and return either:

- `loggedIn: true` with your wallet and selected token, or
- `loggedIn: false` with a next step telling you to run `normies login`.

If Claude says it has no Normies MCP tools, it is still reading a config file
without the Normies MCP server. Re-run `claude-config --status`, confirm the
right config path, then restart Claude Desktop.
