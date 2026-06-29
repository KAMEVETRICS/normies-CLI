import crypto from "node:crypto";
import http from "node:http";
import { execFile } from "node:child_process";
import { recoverMessageAddress, getAddress, isAddress } from "viem";
import { NormiesApiClient } from "./api.js";

const LOGIN_TIMEOUT_MS = 120_000;

export function createLoginMessage({ address, chainId, nonce, origin, issuedAt = new Date() }) {
  const issued = issuedAt.toISOString();
  const expires = new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString();

  return `${new URL(origin).host} wants you to sign in with your Ethereum account:

${getAddress(address)}

Sign in to Normies CLI. This proves holder access for local Normies agent chat. It does not authorize transactions, transfers, approvals, or wallet control.

URI: ${origin}
Version: 1
Chain ID: ${Number(chainId) || 1}
Nonce: ${nonce}
Issued At: ${issued}
Expiration Time: ${expires}
Resources:
- normies-cli://holder-auth`;
}

export async function verifyLoginSignature({ address, message, signature, expectedMessage }) {
  if (!isAddress(address)) {
    throw new Error("Invalid Ethereum address.");
  }

  if (message !== expectedMessage) {
    throw new Error("Signed message does not match the login challenge.");
  }

  const recovered = await recoverMessageAddress({ message, signature });
  if (getAddress(recovered) !== getAddress(address)) {
    throw new Error("Signature does not match wallet address.");
  }

  const expiration = message.match(/^Expiration Time: (.+)$/m)?.[1];
  if (expiration && Date.parse(expiration) < Date.now()) {
    throw new Error("Login challenge expired.");
  }

  return getAddress(recovered);
}

export async function runLoginFlow({
  api,
  store,
  preferredPort = 8787,
  shouldOpenBrowser = true,
  timeoutMs = LOGIN_TIMEOUT_MS
} = {}) {
  api ??= new NormiesApiClient();
  if (!store) {
    const { NormiesStore } = await import("./store.js");
    store = new NormiesStore();
  }

  const pending = new Map();
  let verified = null;
  let resolveLogin;
  let rejectLogin;

  const loginPromise = new Promise((resolve, reject) => {
    resolveLogin = resolve;
    rejectLogin = reject;
  });

  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;

      if (req.method === "GET" && req.url === "/") {
        sendHtml(res, loginPageHtml());
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "POST" && req.url === "/challenge") {
        const body = await readJson(req);
        if (!isAddress(body.address)) {
          sendJson(res, 400, { error: "Invalid address" });
          return;
        }

        const nonce = crypto.randomBytes(12).toString("base64url");
        const address = getAddress(body.address);
        const message = createLoginMessage({
          address,
          chainId: body.chainId || 1,
          nonce,
          origin
        });

        pending.set(address.toLowerCase(), {
          address,
          nonce,
          message,
          expiresAt: Date.now() + 10 * 60 * 1000
        });

        sendJson(res, 200, { message, nonce });
        return;
      }

      if (req.method === "POST" && req.url === "/verify") {
        const body = await readJson(req);
        const address = getAddress(body.address);
        const challenge = pending.get(address.toLowerCase());

        if (!challenge || challenge.expiresAt < Date.now()) {
          sendJson(res, 400, { error: "Missing or expired challenge" });
          return;
        }

        await verifyLoginSignature({
          address,
          message: body.message,
          signature: body.signature,
          expectedMessage: challenge.message
        });

        const ownership = await api.getHolderTokens(address);
        if (ownership.tokenIds.length === 0) {
          const message = "This wallet does not currently hold any Normies.";
          sendJson(res, 403, { error: message });
          rejectLogin(new Error(message));
          return;
        }
        const registration = await api.getAgentRegistrationStatus(ownership.tokenIds);

        verified = {
          address,
          tokenIds: ownership.tokenIds,
          registration,
          signedMessage: body.message,
          signature: body.signature
        };

        if (registration.registeredAgentTokenIds.length <= 1) {
          const auth = addRegistrationStatus(store.saveAuth({
            ...verified,
            selectedTokenId: registration.registeredAgentTokenIds[0] ?? null
          }), registration);
          sendJson(res, 200, {
            authenticated: true,
            requiresSelection: false,
            auth,
            ...publicRegistrationStatus(registration)
          });
          resolveLogin(auth);
          return;
        }

        sendJson(res, 200, {
          authenticated: true,
          requiresSelection: true,
          address,
          tokenIds: ownership.tokenIds,
          ...publicRegistrationStatus(registration)
        });
        return;
      }

      if (req.method === "POST" && req.url === "/select") {
        if (!verified) {
          sendJson(res, 401, { error: "Verify wallet before selecting a Normie." });
          return;
        }

        const body = await readJson(req);
        const selectedTokenId = Number(body.tokenId);
        if (!verified.tokenIds.includes(selectedTokenId)) {
          sendJson(res, 403, { error: "Selected token is not owned by this wallet." });
          return;
        }

        if (!verified.registration.registeredAgentTokenIds.includes(selectedTokenId)) {
          sendJson(res, 403, {
            error: `Normie #${selectedTokenId} is owned by this wallet, but it is not registered as an agent yet.`,
            registerUrl: verified.registration.registerUrl
          });
          return;
        }

        const auth = addRegistrationStatus(store.saveAuth({
          ...verified,
          selectedTokenId
        }), verified.registration);
        sendJson(res, 200, {
          authenticated: true,
          auth,
          ...publicRegistrationStatus(verified.registration)
        });
        resolveLogin(auth);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { error: error?.message || "Login error" });
    }
  });

  const url = await listen(server, preferredPort);
  const timer = setTimeout(() => {
    rejectLogin(new Error("Login timed out."));
  }, timeoutMs);

  if (shouldOpenBrowser) {
    openBrowser(url);
  }

  try {
    const auth = await loginPromise;
    return auth;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

function listen(server, preferredPort) {
  return new Promise((resolve, reject) => {
    let didFallback = false;

    const onError = (error) => {
      if (error.code === "EADDRINUSE" && preferredPort !== 0 && !didFallback) {
        didFallback = true;
        server.listen(0, "127.0.0.1");
        return;
      }

      server.off("error", onError);
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    };

    server.on("error", onError);
    server.once("listening", onListening);

    server.listen(preferredPort, "127.0.0.1");
  });
}

function openBrowser(url) {
  if (process.platform === "win32") {
    execFile("cmd", ["/c", "start", "", url], { windowsHide: true });
    return;
  }

  if (process.platform === "darwin") {
    execFile("open", [url], { windowsHide: true });
    return;
  }

  execFile("xdg-open", [url], { windowsHide: true });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64_000) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "http://127.0.0.1"
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function publicRegistrationStatus(registration) {
  return {
    registeredAgentTokenIds: registration.registeredAgentTokenIds,
    unregisteredTokenIds: registration.unregisteredTokenIds,
    registerUrl: registration.registerUrl
  };
}

function addRegistrationStatus(auth, registration) {
  return {
    ...auth,
    ...publicRegistrationStatus(registration)
  };
}

function loginPageHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Normies CLI Login</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111; color: #f4f4f4; }
    main { width: min(560px, calc(100vw - 32px)); border: 1px solid #3a3a3a; border-radius: 8px; padding: 24px; background: #1b1b1b; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { color: #bdbdbd; line-height: 1.5; }
    button { min-height: 42px; border: 1px solid #777; border-radius: 6px; background: #f4f4f4; color: #111; padding: 0 14px; font-weight: 700; cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    button.secondary { background: transparent; color: #f4f4f4; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .wallets { display: grid; gap: 8px; margin-top: 16px; }
    .wallet { display: flex; align-items: center; justify-content: flex-start; gap: 10px; width: 100%; min-height: 46px; background: transparent; color: #f4f4f4; text-align: left; }
    .wallet.selected { border-color: #f4f4f4; background: #2a2a2a; }
    .wallet img { width: 24px; height: 24px; border-radius: 6px; }
    .wallet .fallback-icon { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; background: #3a3a3a; color: #f4f4f4; font-size: 12px; }
    .tokens { display: grid; gap: 8px; margin-top: 16px; }
    .status { margin-top: 16px; font-size: 14px; color: #d7d7d7; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <h1>Normies CLI Login</h1>
    <p>Connect your wallet and sign a login message. This is not a transaction and does not authorize transfers, approvals, or wallet control.</p>
    <div id="wallets" class="wallets"></div>
    <div class="row">
      <button id="login" disabled>Connect and Sign</button>
      <button id="refresh" class="secondary">Refresh Wallets</button>
    </div>
    <div id="tokens" class="tokens"></div>
    <div id="status" class="status">Looking for wallets.</div>
  </main>
  <script>
    const loginButton = document.getElementById('login');
    const refreshButton = document.getElementById('refresh');
    const statusBox = document.getElementById('status');
    const walletBox = document.getElementById('wallets');
    const tokenBox = document.getElementById('tokens');
    const wallets = new Map();
    let selectedWalletKey = null;

    function setStatus(text) { statusBox.textContent = text; }

    function walletName(info, provider) {
      if (info && info.name) return info.name;
      if (provider && provider.isRabby) return 'Rabby';
      if (provider && provider.isMetaMask) return 'MetaMask';
      if (provider && provider.isCoinbaseWallet) return 'Coinbase Wallet';
      if (provider && provider.isTrust) return 'Trust Wallet';
      return 'Injected Wallet';
    }

    function walletKey(info, provider, index) {
      if (info && info.uuid) return info.uuid;
      if (info && info.rdns) return info.rdns;
      return walletName(info, provider) + '-' + index;
    }

    function addWallet(detail, index) {
      if (!detail || !detail.provider) return;
      if (Array.from(wallets.values()).some((wallet) => wallet.provider === detail.provider)) return;
      const info = detail.info || {};
      const key = walletKey(info, detail.provider, index || wallets.size);
      wallets.set(key, {
        key,
        info,
        provider: detail.provider,
        name: walletName(info, detail.provider)
      });
      if (!selectedWalletKey) selectedWalletKey = key;
      renderWallets();
    }

    function addInjectedWallets() {
      if (!window.ethereum) return;
      const providers = Array.isArray(window.ethereum.providers) && window.ethereum.providers.length
        ? window.ethereum.providers
        : [window.ethereum];
      providers.forEach((provider, index) => addWallet({ provider, info: {} }, index));
    }

    function renderWallets() {
      walletBox.innerHTML = '';
      const walletList = Array.from(wallets.values());
      loginButton.disabled = walletList.length === 0;

      if (walletList.length === 0) {
        setStatus('No injected wallet found. Open this page in a wallet-enabled browser.');
        return;
      }

      for (const wallet of walletList) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wallet' + (wallet.key === selectedWalletKey ? ' selected' : '');

        if (wallet.info.icon) {
          const icon = document.createElement('img');
          icon.src = wallet.info.icon;
          icon.alt = '';
          button.appendChild(icon);
        } else {
          const icon = document.createElement('span');
          icon.className = 'fallback-icon';
          icon.textContent = wallet.name.slice(0, 1).toUpperCase();
          button.appendChild(icon);
        }

        const label = document.createElement('span');
        label.textContent = wallet.name;
        button.appendChild(label);

        button.onclick = () => {
          selectedWalletKey = wallet.key;
          renderWallets();
          setStatus('Selected ' + wallet.name + '. Ready to connect.');
        };

        walletBox.appendChild(button);
      }

      const selectedWallet = wallets.get(selectedWalletKey);
      if (selectedWallet) {
        setStatus('Selected ' + selectedWallet.name + '. Ready to connect.');
      }
    }

    function discoverWallets() {
      wallets.clear();
      selectedWalletKey = null;
      setStatus('Looking for wallets.');
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      setTimeout(addInjectedWallets, 250);
      setTimeout(renderWallets, 400);
    }

    window.addEventListener('eip6963:announceProvider', (event) => {
      addWallet(event.detail);
    });

    refreshButton.addEventListener('click', discoverWallets);

    loginButton.addEventListener('click', async () => {
      try {
        const wallet = wallets.get(selectedWalletKey);
        if (!wallet) throw new Error('Choose a wallet before signing in.');
        const provider = wallet.provider;
        setStatus('Requesting wallet account...');
        const [address] = await provider.request({ method: 'eth_requestAccounts' });
        const chainHex = await provider.request({ method: 'eth_chainId' }).catch(() => '0x1');
        const chainId = Number.parseInt(chainHex, 16) || 1;
        const challenge = await fetch('/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, chainId })
        }).then((res) => res.json());
        if (challenge.error) throw new Error(challenge.error);
        setStatus('Please sign the login message in ' + wallet.name + '.');
        const signature = await provider.request({
          method: 'personal_sign',
          params: [challenge.message, address]
        });
        setStatus('Verifying holder status...');
        const verified = await fetch('/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, message: challenge.message, signature })
        }).then((res) => res.json());
        if (verified.error) throw new Error(verified.error);
        if (!verified.requiresSelection) {
          if ((verified.registeredAgentTokenIds || []).length === 0) {
            setStatus('Wallet verified, but none of your owned Normies are registered as agents yet. Register one at ' + verified.registerUrl + ' before using it in Claude.');
            return;
          }
          setStatus('Logged in. You can close this tab.');
          return;
        }
        setStatus('Choose which registered Normie agent Claude should use by default.');
        tokenBox.innerHTML = '';
        for (const tokenId of verified.registeredAgentTokenIds || []) {
          const button = document.createElement('button');
          button.className = 'secondary';
          button.textContent = 'Use Normie #' + tokenId;
          button.onclick = async () => {
            const selected = await fetch('/select', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tokenId })
            }).then((res) => res.json());
            if (selected.error) throw new Error(selected.error);
            setStatus('Logged in with Normie #' + tokenId + '. You can close this tab.');
            tokenBox.innerHTML = '';
          };
          tokenBox.appendChild(button);
        }
        for (const tokenId of verified.unregisteredTokenIds || []) {
          const button = document.createElement('button');
          button.className = 'secondary';
          button.disabled = true;
          button.textContent = 'Normie #' + tokenId + ' is not registered as an agent';
          tokenBox.appendChild(button);
        }
      } catch (error) {
        setStatus(error.message || String(error));
      }
    });

    discoverWallets();
  </script>
</body>
</html>`;
}
