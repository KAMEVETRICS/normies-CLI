# Normies CLI

Local CLI and MCP server for Normies agents.

Normies CLI lets Claude Desktop fetch Normies agent data, build an in-character
chat context, and save local chat history/memories for verified Normies holders.
It uses wallet signature login for holder checks only. It does not request
transactions, approvals, transfers, private keys, or seed phrases.

GitHub repo: https://github.com/KAMEVETRICS/normies-CLI.git

## What It Does

- Fetches public Normies agent/persona data.
- Lets a holder sign in by signing a plain wallet message.
- Checks the signed-in wallet against `https://api.normies.art`.
- Connects to Claude Desktop as an MCP server.
- Lets Claude speak with a selected Normie in character.
- Saves local chat history and approved memories in SQLite.
- Keeps wallet authority outside the agent runtime.

## Requirements

- Node.js 22 or newer.
- Claude Desktop.
- A wallet-enabled browser, such as MetaMask or Rabby.
- A wallet that currently holds at least one Normie.

## Install

Clone the repo:

```bash
git clone https://github.com/KAMEVETRICS/normies-CLI.git
cd normies-CLI
```

Install dependencies:

```bash
npm install
```

Check that the CLI works:

```bash
node ./bin/normies.js --help
```

## Step 1: Sign In As A Holder

Run:

```bash
node ./bin/normies.js login
```

This opens a local login page at `http://127.0.0.1:8787`.

On the page:

1. Choose the wallet you want to use.
2. Connect that wallet.
3. Sign the login message.
4. If you own more than one Normie, choose the one you want Claude to use by default.
5. Close the browser tab after the page says you are logged in.

Important: this signature is not a transaction. It only proves wallet ownership
for local holder access.

## Step 2: Confirm Your Login

Show the current holder session:

```bash
node ./bin/normies.js whoami
```

List the Normies owned by the signed-in wallet:

```bash
node ./bin/normies.js agents owned
```

Choose a different owned Normie:

```bash
node ./bin/normies.js use <tokenId>
```

Replace `<tokenId>` with one of the tokens shown by `node ./bin/normies.js agents owned`.

Log out:

```bash
node ./bin/normies.js logout
```

Protected commands refresh holder ownership at least every five minutes. Token
selection and owned-token listing always re-check the live holder list.

## Step 3: Connect To Claude Desktop

Print the Claude Desktop MCP config:

```bash
node ./bin/normies.js claude-config
```

Copy the printed `mcpServers.normies` block into your Claude Desktop config file.

Common config locations:

```text
Windows: %APPDATA%\Claude\claude_desktop_config.json
macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
```

The `mcpServers` block must be at the top level of the JSON file, not inside
`preferences`.

Example shape:

```json
{
  "mcpServers": {
    "normies": {
      "command": "node",
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

Restart Claude Desktop after saving the config.

## Step 4: Use In Claude

Start a new Claude chat and ask:

```text
Check my Normies auth status.
```

Then ask:

```text
Talk to my selected Normie.
```

Claude should use the Normies MCP tools to fetch the selected agent context.
Responses are labeled so users can tell the difference between Claude and the
Normie persona:

```text
[NORMIE #<tokenId> | Name | IN CHARACTER]
```

```text
[CLAUDE | OUT OF CHARACTER]
```

## Useful CLI Commands

```bash
node ./bin/normies.js agent <tokenId>
node ./bin/normies.js card <tokenId>
node ./bin/normies.js context <tokenId>
node ./bin/normies.js memory add <tokenId> "Likes short replies"
node ./bin/normies.js memory list <tokenId>
node ./bin/normies.js chat <tokenId> --message "hello"
node ./bin/normies.js chats <tokenId>
node ./bin/normies.js chats --sessions
```

## Local Storage

Holder auth, chat history, memories, and audit logs are stored locally in SQLite:

```text
~/.normies/chats.db
```

You can override the storage location:

```bash
NORMIES_HOME=/path/to/local/state node ./bin/normies.js mcp
```

On Windows PowerShell:

```powershell
$env:NORMIES_HOME="C:\path\to\local\state"
node ./bin/normies.js mcp
```

## Troubleshooting

If Claude does not see the Normies tools:

- Make sure Claude Desktop was restarted after editing the config.
- Make sure `mcpServers` is at the top level of the JSON file.
- Run `node ./bin/normies.js claude-config` again and compare paths.
- Use an absolute path to `bin/normies.js`.
- Start a fresh Claude chat after changing MCP config.

If login fails:

- Make sure you opened the login page in a wallet-enabled browser.
- Make sure the wallet holds at least one Normie.
- Make sure you signed the message, not a transaction.
- Run `node ./bin/normies.js logout`, then try `node ./bin/normies.js login` again.

If a protected command says access is denied:

- Run `node ./bin/normies.js agents owned`.
- Run `node ./bin/normies.js use <tokenId>` with a token listed there.
- The live holder list may have changed if the NFT was transferred.

## Safety Boundary

Normies CLI intentionally avoids wallet authority.

Allowed:

- Fetching public agent data.
- Building Claude-ready context.
- Saving local chat history.
- Saving approved local memories.
- Checking whether the signed-in wallet holds a Normie.

Not allowed:

- Signing transactions.
- Requesting private keys or seed phrases.
- Transferring assets.
- Requesting token approvals.
- Controlling or delegating wallet authority.

## Demo Prompt

A ready-to-use Veo demo/tutorial prompt is available in
[`VEO_DEMO_PROMPT.md`](./VEO_DEMO_PROMPT.md).
