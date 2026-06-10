# Veo Demo Prompt

Create a clean, modern 60-90 second tutorial video for a developer tool called
"Normies CLI".

The video should feel like a polished hackathon product demo. Use screen-recording
style shots, crisp terminal UI, Claude Desktop UI, and a wallet login browser
window. No voiceover is required, but include clear on-screen captions.

Story:

1. Open with the title: "Normies CLI - Bring Your Normie Agent Into Claude".
2. Show a GitHub page for `KAMEVETRICS/normies-CLI`.
3. Show a terminal running:
   `git clone https://github.com/KAMEVETRICS/normies-CLI.git`
   then:
   `cd normies-CLI`
   then:
   `npm install`
4. Show the terminal running:
   `node ./bin/normies.js --help`
   Caption: "Install the CLI locally."
5. Show:
   `node ./bin/normies.js login`
   A browser opens at `127.0.0.1:8787`.
   Caption: "Connect your wallet and sign a message. No transaction."
6. Show a wallet pop-up signing a readable login message.
   Caption: "The signature proves holder access only."
7. Show the terminal running:
   `node ./bin/normies.js agents owned`
   and:
   `node ./bin/normies.js use <tokenId>`
   Caption: "Pick the Normie you want Claude to use."
8. Show:
   `node ./bin/normies.js claude-config`
   Then show the JSON block being pasted into Claude Desktop config.
   Caption: "Add the MCP server to Claude Desktop."
9. Show Claude Desktop restarting, then a new chat.
10. User asks Claude:
    "Check my Normies auth status."
    Claude replies that the Normies MCP server is connected.
11. User asks:
    "Talk to my selected Normie."
    Claude displays a response labeled:
    `[NORMIE #<tokenId> | Normie Name | IN CHARACTER]`
12. Show a second label:
    `[CLAUDE | OUT OF CHARACTER]`
    Caption: "Clear labels separate Claude setup talk from Normie roleplay."
13. Show a quick memory save moment:
    "Remember that I prefer short replies."
    Caption: "Approved memories and chats save locally."
14. End with:
    "Normies CLI: holder-gated agents for Claude, with no wallet authority."

Visual style:

- Dark terminal theme.
- Clean, readable text.
- Smooth zooms on commands and important JSON.
- Minimal, modern UI.
- Use the Normies brand/name clearly.
- Avoid fake crypto transaction screens.
- Avoid showing private keys, seed phrases, or real wallet balances.
- Show that wallet signing is message-only and safe.

Final frame text:

"Clone it. Sign in. Connect Claude. Chat with your Normie."
