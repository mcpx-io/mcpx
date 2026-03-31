import { createServer, IncomingMessage, ServerResponse } from "http";
import { request as httpsRequest } from "https";
import { exec } from "child_process";
import input from "@inquirer/input";
import { saveSecret, loadSecret } from "./secrets.js";
import type { OAuthSetup } from "./mcps.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32" ? `cmd.exe /c start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd);
}

function postJSON(url: string, body: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const u = new URL(url);
    const req = httpsRequest(
      { hostname: u.hostname, path: u.pathname, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); } catch { reject(new Error(buf)); }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function waitForCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        const urlObj = new URL(req.url!, `http://localhost:${port}`);
        const code = urlObj.searchParams.get("code");
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>Autorizado! Pode fechar esta aba.</h2>");
          server.close();
          resolve(code);
        } else {
          res.writeHead(400);
          res.end("Sem código.");
        }
      } catch (e) {
        reject(e);
      }
    });
    server.listen(port, () => {
      console.log(`  Aguardando autorização em http://localhost:${port} ...`);
    });
    server.on("error", reject);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

/** Retorna true se os secrets OAuth já existem */
export function oauthSecretsExist(setup: OAuthSetup): boolean {
  try {
    loadSecret(setup.secrets.clientId);
    loadSecret(setup.secrets.clientSecret);
    loadSecret(setup.secrets.refreshToken);
    return true;
  } catch {
    return false;
  }
}

/** Roda o fluxo OAuth interativo. Retorna true se configurado com sucesso. */
export async function runOAuthFlow(setup: OAuthSetup): Promise<boolean> {
  console.log("\n  🔐 Configuração OAuth do Google\n");
  console.log("  Pré-requisito: adicione o redirect URI abaixo no seu cliente OAuth no GCP:");
  console.log(`  ${setup.redirectUri}\n`);

  const clientId = await input({ message: "Client ID:" });
  if (!clientId.trim()) {
    console.log("  Pulado — configure depois com: npx @mcpx-io/apps-script@latest setup");
    return false;
  }

  const clientSecret = await input({ message: "Client Secret:" });
  if (!clientSecret.trim()) {
    console.log("  Pulado.");
    return false;
  }

  // Gera auth URL
  const params = new URLSearchParams({
    access_type: "offline",
    scope: setup.scopes.join(" "),
    prompt: "consent",
    response_type: "code",
    client_id: clientId.trim(),
    redirect_uri: setup.redirectUri,
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  console.log("\n  Abrindo browser para autorização...");
  console.log("  Se não abrir, acesse:\n");
  console.log("  " + authUrl + "\n");
  openBrowser(authUrl);

  // Extrai porta do redirect URI
  const port = new URL(setup.redirectUri).port || "3000";
  const code = await waitForCode(parseInt(port));

  // Troca code por tokens
  const tokens = await postJSON("https://oauth2.googleapis.com/token", {
    code,
    client_id: clientId.trim(),
    client_secret: clientSecret.trim(),
    redirect_uri: setup.redirectUri,
    grant_type: "authorization_code",
  });

  if (!tokens.refresh_token) {
    console.log("  ❌ Refresh token não recebido. Revogue o acesso em myaccount.google.com/permissions e tente de novo.");
    return false;
  }

  saveSecret(setup.secrets.clientId, clientId.trim());
  saveSecret(setup.secrets.clientSecret, clientSecret.trim());
  saveSecret(setup.secrets.refreshToken, tokens.refresh_token);

  console.log("  ✅ OAuth configurado!\n");
  return true;
}
