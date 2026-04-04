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
import { hostname, platform, userInfo, homedir } from "os";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { writeProjectMemory, projectNameFromCwd } from "./project-memory.js";

function getGithubToken(): string {
  // 1. variável de ambiente
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN;
  // 2. ~/.npmrc
  const npmrc = join(homedir(), ".npmrc");
  if (existsSync(npmrc)) {
    const match = readFileSync(npmrc, "utf-8").match(/npm\.pkg\.github\.com\/:_authToken=(.+)/);
    if (match) return match[1].trim();
  }
  return "";
}
import { oauthSecretsExist, runOAuthFlow } from "./oauth.js";

const program = new Command();

program
  .name("mcpx")
  .description("CLI para instalar e configurar MCPs do ecossistema mcpx")
  .version("1.2.4");

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

    const cwd      = process.cwd();
    const name     = projectNameFromCwd(cwd);
    const mcpList  = Object.keys(readMcpJson().mcpServers);

    // Gera arquivo de memória do projeto em ~/.claude/projects/{encoded}/memory/
    const memFile = writeProjectMemory({ cwd, mcps: mcpList });
    console.log(`✓ Memória do projeto criada em:\n  ${memFile}`);

    // Gera CLAUDE.md se não existir
    const claudeMdPath = join(cwd, "CLAUDE.md");
    if (!existsSync(claudeMdPath)) {
      const mcpSection = mcpList
        .filter(m => m !== "mcpx-proxy")
        .map(m => `- **${m}**`)
        .join("\n");

      writeFileSync(claudeMdPath, `# ${name}

## Idioma
Sempre responda em português.

## Início de cada sessão
Ao iniciar qualquer conversa, executar obrigatoriamente:
1. \`get_profile\` (mcpx-memory) — carrega perfil do usuário
   - Se vazio: inferir stack/preferências do contexto e criar com \`save_profile\`
2. \`search_memories\` com \`project="${name}"\` — carrega contexto recente do projeto

## MCPs disponíveis
${mcpSection}

## O que salvar na memória
Usar \`save_memory\` ao final de tarefas importantes, sempre com \`project: "${name}"\`:
- Decisões de arquitetura → type: "decision"
- Bugs não-óbvios e como resolver → type: "gotcha"
- Padrões do projeto → type: "recipe"
- Contexto da sessão → type: "context", key: "last-session"

## Auto-melhoria
Este arquivo deve evoluir com o uso. Atualizar quando o usuário corrigir um comportamento, um padrão ficar claro, ou o projeto evoluir.

## Final de cada sessão
Quando o usuário disser "pode fechar", "terminamos" ou similar:
1. \`save_memory\` com key: "last-session", type: "context", project: "${name}"
2. Para cada decisão importante: \`save_memory\` com type: "decision"
3. Para cada gotcha encontrado: \`save_memory\` com type: "gotcha"
`, "utf-8");
      console.log(`✓ CLAUDE.md criado em ${claudeMdPath}`);
    } else {
      console.log(`  CLAUDE.md já existe — não sobrescrito`);
    }

    console.log("\nRecarregue o Claude Code para aplicar.");
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
  .description("Verifica novas versões dos pacotes mcpx e limpa cache npx")
  .action(async () => {
    const REGISTRY = "https://npm.pkg.github.com";
    const PACKAGES = [
      "@mcpx-io/proxy",
      "@mcpx-io/mcpx",
      "@mcpx-io/vps",
      "@mcpx-io/debug",
    ];

    console.log("\nmcpx update — verificando versões...\n");

    const NPX_CACHE = process.env.npm_config_cache
      ? `${process.env.npm_config_cache}/_npx`
      : process.platform === "win32"
        ? `${process.env.LOCALAPPDATA}\\npm-cache\\_npx`
        : `${process.env.HOME}/.npm/_npx`;

    let hasUpdate = false;

    for (const pkg of PACKAGES) {
      try {
        const token = getGithubToken();
        const res = await fetch(`${REGISTRY}/${pkg.replace("/", "%2F")}`, {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            Accept: "application/json",
          },
        });
        if (!res.ok) { console.log(`  ? ${pkg} — não foi possível verificar`); continue; }
        const data = await res.json() as { "dist-tags": { latest: string } };
        const latest = data["dist-tags"]?.latest;
        console.log(`  ✓ ${pkg}@${latest}`);
        hasUpdate = true;
      } catch {
        console.log(`  ? ${pkg} — offline ou sem acesso ao registry`);
      }
    }

    if (hasUpdate) {
      // Limpa cache npx de pacotes mcpx-io
      const { existsSync: ex, readdirSync: rd, rmSync } = await import("fs");
      if (ex(NPX_CACHE)) {
        let cleared = 0;
        for (const hash of rd(NPX_CACHE)) {
          const dir = `${NPX_CACHE}/${hash}/node_modules`;
          if (!ex(dir)) continue;
          const hasMcpx = rd(dir).some(d => d.startsWith("@mcpx-io") || d === "chrome-devtools-mcp");
          if (hasMcpx) {
            rmSync(`${NPX_CACHE}/${hash}`, { recursive: true, force: true });
            cleared++;
          }
        }
        if (cleared > 0) console.log(`\n  Cache npx limpo (${cleared} entrada(s) removida(s))`);
      }
      console.log("\nReinicie o Claude Code para aplicar as atualizações.");
    }
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
