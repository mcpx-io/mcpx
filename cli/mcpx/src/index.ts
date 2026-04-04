import { Command } from "commander";
import checkbox from "@inquirer/checkbox";
import select from "@inquirer/select";
import input from "@inquirer/input";
import { MCPS } from "./mcps.js";
import {
  addLocalMcp, addRemoteMcp, removeMcp,
  listConfigured, mcpJsonPath, readMcpJson, ensureProxy,
} from "./mcp-json.js";
import {
  saveSecret, loadSecret, deleteSecret, listSecrets, makeRef,
} from "./secrets.js";
import { createHash } from "crypto";
import { hostname, platform, userInfo } from "os";
import { oauthSecretsExist, runOAuthFlow } from "./oauth.js";

const program = new Command();

program
  .name("mcpx")
  .description("CLI para instalar e configurar MCPs do ecossistema mcpx")
  .version("1.0.12");

// ── init ─────────────────────────────────────────────────────────────────────

program.command("init")
  .description("Wizard interativo — configura todos os MCPs que quiser")
  .action(async () => {
    console.log("\n🚀 mcpx init — configuração do .mcp.json\n");
    console.log(`Projeto: ${process.cwd()}`);
    console.log(`Arquivo: ${mcpJsonPath()}\n`);

    // Proxy sempre presente — adicionado automaticamente
    ensureProxy();

    const configured = new Set(listConfigured());

    const selected = await checkbox({
      message: "Selecione os MCPs (espaço para marcar, enter para confirmar):",
      choices: MCPS.map(m => ({
        name: `${m.key.padEnd(16)} ${m.type === "remote" ? "[remoto]" : "[local] "} — ${m.description}${configured.has(m.name) ? "  (já configurado)" : ""}`,
        short: m.key,
        value: m.key,
        checked: false,
      })),
      theme: {
        icon: {
          checked:   " ✓",
          unchecked: " ○",
          cursor:    "→",
        },
      },
    });

    if (selected.length === 0) {
      console.log("\nNenhum MCP selecionado.");
      return;
    }

    console.log("");

    let added = 0;
    for (const key of selected) {
      await installMcp(key);
      added++;
    }

    console.log(`\n✓ ${added} MCP(s) configurado(s) em .mcp.json`);
    console.log("Recarregue o Claude Code para aplicar.");
  });

// ── add ──────────────────────────────────────────────────────────────────────

program.command("add [name]")
  .description("Adiciona um MCP ao .mcp.json")
  .action(async (name?: string) => {
    let key = name;

    if (!key) {
      key = await select({
        message: "Qual MCP deseja adicionar?",
        choices: MCPS.map(m => ({
          name: `${m.key} — ${m.description}`,
          value: m.key,
        })),
      });
    }

    await installMcp(key);
  });

// ── remove ───────────────────────────────────────────────────────────────────

program.command("remove [name]")
  .description("Remove um MCP do .mcp.json")
  .action(async (name?: string) => {
    const configured = listConfigured();
    if (configured.length === 0) {
      console.log("Nenhum MCP configurado.");
      return;
    }

    let key = name;
    if (!key) {
      key = await select({
        message: "Qual MCP deseja remover?",
        choices: configured.map(k => ({ name: k, value: k })),
      });
    }

    const ok = removeMcp(key);
    if (ok) console.log(`✓ "${key}" removido do .mcp.json`);
    else console.log(`"${key}" não encontrado no .mcp.json`);
  });

// ── list ─────────────────────────────────────────────────────────────────────

program.command("list")
  .description("Lista MCPs disponíveis e status no projeto atual")
  .action(() => {
    const configured = new Set(listConfigured());

    console.log("\nMCPs disponíveis:\n");
    for (const mcp of MCPS) {
      const status = configured.has(mcp.name) ? "✓ configurado" : "○ não configurado";
      const type = mcp.type === "remote" ? "[remoto]" : "[local] ";
      console.log(`  ${type} ${mcp.key.padEnd(12)} ${status.padEnd(18)} — ${mcp.description}`);
    }

    console.log(`\n.mcp.json: ${mcpJsonPath()}`);
    const data = readMcpJson();
    const total = Object.keys(data.mcpServers).length;
    console.log(`Total configurados: ${total}\n`);
  });

// ── update ───────────────────────────────────────────────────────────────────

program.command("update")
  .description("MCPs locais são sempre atualizados automaticamente via npx")
  .action(() => {
    console.log("MCPs locais usam npx -y @latest — sempre baixam a versão mais recente ao iniciar.");
    console.log("Nenhuma ação necessária.");
  });

// ── secrets ──────────────────────────────────────────────────────────────────

const secrets = program.command("secrets")
  .description("Gerencia secrets criptografados (~/.mcpx/secrets.json)");

secrets.command("set <ref>")
  .description("Salva ou atualiza um secret criptografado")
  .action(async (ref: string) => {
    const value = await input({
      message: `Valor para "${ref}":`,
      validate: (v) => v.trim().length > 0 || "Campo obrigatório",
    });
    saveSecret(ref, value.trim());
    console.log(`✓ Secret "${ref}" salvo em ~/.mcpx/secrets.json`);
  });

secrets.command("get <ref>")
  .description("Mostra o valor decriptado de um secret")
  .action((ref: string) => {
    try {
      const value = loadSecret(ref);
      console.log(value);
    } catch (e) {
      console.error((e as Error).message);
    }
  });

secrets.command("list")
  .description("Lista todos os secrets salvos (sem valores)")
  .action(() => {
    const refs = listSecrets();
    if (refs.length === 0) {
      console.log("Nenhum secret salvo.");
      return;
    }
    console.log("\nSecrets em ~/.mcpx/secrets.json:\n");
    refs.forEach(r => console.log(`  mcpx:enc:${r}`));
    console.log("");
  });

secrets.command("delete <ref>")
  .description("Remove um secret")
  .action((ref: string) => {
    const ok = deleteSecret(ref);
    if (ok) console.log(`✓ Secret "${ref}" removido`);
    else console.log(`Secret "${ref}" não encontrado`);
  });

// ── helpers ──────────────────────────────────────────────────────────────────

async function installMcp(key: string): Promise<void> {
  const mcp = MCPS.find(m => m.key === key);
  if (!mcp) {
    console.error(`MCP "${key}" não encontrado. Use: mcpx list`);
    return;
  }

  if (mcp.type === "remote") {
    const headers: Record<string, string> = { ...mcp.headers };

    // Campos normais (sem criptografia)
    for (const field of mcp.inputs ?? []) {
      const value = await input({
        message: field.label,
        default: field.placeholder,
        validate: (v) => v.trim().length > 0 || "Campo obrigatório",
      });
      if (field.header) headers[field.header] = value.trim();
    }

    // Campos com secret — salva criptografado, coloca referência no header
    for (const field of mcp.secretInputs ?? []) {
      // memory: token gerado automaticamente do fingerprint da máquina
      if (key === "memory" && field.ref === "memory") {
        const id = `${hostname()}::${platform()}::${userInfo().username}`;
        const token = createHash("sha256").update(id).digest("hex");
        saveSecret(field.ref, token);
        headers[field.header] = makeRef(field.ref);
        console.log(`  Token de memória gerado automaticamente.`);
        continue;
      }

      const value = await input({
        message: `${field.label} (Enter para pular):`,
      });
      if (!value.trim()) {
        console.log(`  Pulado — use "mcpx add ${key}" para configurar depois`);
        return;
      }
      saveSecret(field.ref, value.trim());
      headers[field.header] = makeRef(field.ref);
    }

    // Se tem secretInputs, garante que o proxy está no .mcp.json
    if ((mcp.secretInputs ?? []).length > 0) ensureProxy();

    addRemoteMcp(mcp.name, mcp.url!, headers);
    console.log(`✓ "${mcp.name}" adicionado ao .mcp.json`);

  } else {
    const env: Record<string, string> = {};
    let mcpName = mcp.name;

    // OAuth: roda fluxo interativo se secrets não existem ainda
    if (mcp.oauthSetup && !oauthSecretsExist(mcp.oauthSetup)) {
      await runOAuthFlow(mcp.oauthSetup);
    }

    for (const field of mcp.envInputs ?? []) {
      // preConfigured: só adiciona a ref, sem prompt (setup externo cuida do secret)
      if (field.preConfigured) {
        env[field.env] = makeRef(field.key);
        continue;
      }

      if (field.secret) {
        const ref = field.key;
        // Reutiliza secret já salvo (ex: google_sa compartilhado entre google-sheets e apps-script)
        try {
          loadSecret(ref);
          env[field.env] = makeRef(ref);
          continue; // já existe, pula a pergunta
        } catch { /* não existe ainda, pede ao usuário */ }
      }

      const value = await input({
        message: field.label,
        default: field.placeholder || undefined,
        validate: (v) => field.optional || v.trim().length > 0 || "Campo obrigatório",
      });

      if (!value.trim()) continue;

      if (field.secret) {
        const ref = field.key;
        saveSecret(ref, value.trim());
        env[field.env] = makeRef(ref);
      } else {
        env[field.env] = value.trim();
      }
    }

    // VPS: permite múltiplas instâncias com nome customizado
    if (mcp.key === "vps" && env["VPS_SSH"]) {
      const sshVal = env["VPS_SSH"];
      const host = sshVal.split("@")[1] ?? sshVal;
      mcpName = `mcpx-vps-${host}`;
    }

    addLocalMcp(mcpName, mcp.package!, mcp.packageArgs ?? [], env);
    console.log(`✓ "${mcpName}" adicionado ao .mcp.json (via npx — sempre @latest)`);
    if (mcp.postInstallNote) {
      console.log(`  ⚠  ${mcp.postInstallNote}`);
    }
  }
}

program.parse();
