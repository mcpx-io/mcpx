import { Command } from "commander";
import select from "@inquirer/select";
import input from "@inquirer/input";
import confirm from "@inquirer/confirm";
import { execSync } from "child_process";
import { MCPS } from "./mcps.js";
import {
  addLocalMcp, addRemoteMcp, removeMcp,
  listConfigured, mcpJsonPath, readMcpJson,
} from "./mcp-json.js";

const program = new Command();

program
  .name("mcpx")
  .description("CLI para instalar e configurar MCPs do ecossistema mcpx")
  .version("1.0.0");

// ── init ─────────────────────────────────────────────────────────────────────

program.command("init")
  .description("Wizard interativo — configura todos os MCPs que quiser")
  .action(async () => {
    console.log("\n🚀 mcpx init — configuração do .mcp.json\n");
    console.log(`Projeto: ${process.cwd()}`);
    console.log(`Arquivo: ${mcpJsonPath()}\n`);

    const configured = listConfigured();
    let added = 0;

    for (const mcp of MCPS) {
      const alreadyConfigured = configured.includes(mcp.name);
      const label = alreadyConfigured ? `${mcp.key} (já configurado)` : mcp.key;

      const use = await confirm({
        message: `Adicionar ${label}? — ${mcp.description}`,
        default: !alreadyConfigured,
      });

      if (!use) continue;

      await installMcp(mcp.key);
      added++;
    }

    if (added === 0) {
      console.log("\nNenhum MCP adicionado.");
    } else {
      console.log(`\n✓ ${added} MCP(s) configurado(s) em .mcp.json`);
      console.log("Recarregue o Claude Code para aplicar.");
    }
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
  .description("Atualiza todos os CLIs locais para a última versão")
  .action(() => {
    const localMcps = MCPS.filter(m => m.type === "local" && m.package);
    if (localMcps.length === 0) {
      console.log("Nenhum CLI local para atualizar.");
      return;
    }

    for (const mcp of localMcps) {
      console.log(`Atualizando ${mcp.package}...`);
      try {
        execSync(`npm install -g ${mcp.package}`, { stdio: "inherit" });
        console.log(`✓ ${mcp.key} atualizado`);
      } catch {
        console.error(`✗ Falha ao atualizar ${mcp.key}`);
      }
    }
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

    for (const field of mcp.inputs ?? []) {
      const value = await input({
        message: field.label,
        default: field.placeholder,
        validate: (v) => v.trim().length > 0 || "Campo obrigatório",
      });
      if (field.header) headers[field.header] = value.trim();
    }

    addRemoteMcp(mcp.name, mcp.url!, headers);
    console.log(`✓ "${mcp.name}" adicionado ao .mcp.json`);

  } else {
    console.log(`Instalando ${mcp.package}...`);
    try {
      execSync(`npm install -g ${mcp.package}`, { stdio: "inherit" });
    } catch {
      console.warn(`Aviso: falha ao instalar globalmente. Será usado via npx.`);
    }
    addLocalMcp(mcp.name, mcp.package!);
    console.log(`✓ "${mcp.name}" adicionado ao .mcp.json`);
  }
}

program.parse();
