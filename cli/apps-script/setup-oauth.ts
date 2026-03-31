import { createServer } from "http";
import { exec } from "child_process";
import * as readline from "readline";
import { OAuth2Client } from "google-auth-library";
import { saveSecret } from "./secrets.js";

const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/script.deployments",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); }));
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "win32" ? `cmd.exe /c start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd);
}

function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const urlObj = new URL(req.url!, "http://localhost:3000");
        const code = urlObj.searchParams.get("code");
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>✅ Autorizado! Pode fechar esta aba.</h2>");
          server.close();
          resolve(code);
        } else {
          res.writeHead(400);
          res.end("Sem código de autorização.");
        }
      } catch (e) {
        reject(e);
      }
    });
    server.listen(3000, () => {
      process.stdout.write("Aguardando callback em http://localhost:3000 ...\n");
    });
    server.on("error", reject);
  });
}

async function main() {
  process.stdout.write("\n🔐 Setup OAuth — Apps Script MCP\n\n");
  process.stdout.write("Pré-requisito: adicione http://localhost:3000/callback\n");
  process.stdout.write("nos Redirect URIs do seu cliente OAuth no GCP.\n\n");

  const clientId = await question("Client ID: ");
  const clientSecret = await question("Client Secret: ");

  if (!clientId || !clientSecret) {
    process.stderr.write("Client ID e Client Secret são obrigatórios.\n");
    process.exit(1);
  }

  const oauth2 = new OAuth2Client({ clientId, clientSecret, redirectUri: REDIRECT_URI });

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // garante que o refresh_token seja emitido
  });

  process.stdout.write("\nAbrindo browser para autorização...\n");
  process.stdout.write("Se não abrir automaticamente, acesse:\n\n" + authUrl + "\n\n");
  openBrowser(authUrl);

  const code = await waitForCode();
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    process.stderr.write("\n❌ Refresh token não recebido.\n");
    process.stderr.write("Revogue o acesso em myaccount.google.com/permissions e tente novamente.\n");
    process.exit(1);
  }

  saveSecret("apps_script_client_id", clientId);
  saveSecret("apps_script_client_secret", clientSecret);
  saveSecret("apps_script_refresh_token", tokens.refresh_token);

  process.stdout.write("\n✅ OAuth configurado!\n");
  process.stdout.write("Secrets salvos: apps_script_client_id, apps_script_client_secret, apps_script_refresh_token\n");
  process.stdout.write("\nRecarregue o Claude Code para usar o MCP de Apps Script.\n");
  process.exit(0);
}

main().catch(e => {
  process.stderr.write("\n❌ Erro: " + (e as Error).message + "\n");
  process.exit(1);
});
