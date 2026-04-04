/**
 * Gera e atualiza ~/.claude/projects/{encoded}/memory/project_{name}.md
 * Chamado pelo mcpx init e pelo memory watcher automaticamente.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Encode do caminho (mesmo algoritmo do Claude Code) ──────────────────────

export function encodeCwd(cwd: string): string {
  // C:\Users\jadso\OneDrive\Desktop\mcp-tools → c--Users-jadso-OneDrive-Desktop-mcp-tools
  return cwd
    .replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + "-") // C: → c-
    .replace(/[\\/]+/g, "-")                                    // \ ou / → -
    .replace(/^-/, "")                                          // remove leading -
    .replace(/-+/g, (m) => m.length > 1 ? "--" : "-");         // \\ → -- (separador de drive)
}

export function projectNameFromCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "project";
}

// ─── Gerador do arquivo de memória ──────────────────────────────────────────

export interface ProjectMemoryOptions {
  cwd: string;
  mcps: string[];           // lista de MCPs instalados (ex: ["mcpx-postgres", "mcpx-memory"])
  lastSession?: string;     // resumo da última sessão (opcional)
  decisions?: string[];     // decisões salvas
  gotchas?: string[];       // gotchas salvos
}

export function generateProjectMemory(opts: ProjectMemoryOptions): string {
  const { cwd, mcps, lastSession, decisions, gotchas } = opts;
  const name = projectNameFromCwd(cwd);
  const now = new Date().toISOString().slice(0, 10);

  const mcpDocs: Record<string, string> = {
    "mcpx-memory":   "Memória persistente — save_memory, search_memories, get_profile, save_profile",
    "mcpx-postgres": "Banco de dados PostgreSQL — query, execute_dml, execute_migration, get_table_schema",
    "mcpx-redis":    "Cache Redis — get, set, hset, hgetall, lpush, scan, ttl",
    "mcpx-vps":      "VPS remota — run_command, pm2_status, pm2_logs, pm2_restart, nginx_logs",
    "mcpx-debug":    "Debug local — http_request, browser_navigate, browser_screenshot, parse_routes",
    "mcpx-proxy":    "Proxy local (interno) — resolve secrets e roteamento para mcpx.online",
    "chrome-devtools": "Chrome DevTools — console, network, screenshots via Chrome",
    "mcpx-google-sheets": "Google Sheets — criar, ler, escrever planilhas",
    "mcpx-apps-script":   "Google Apps Script — listar, editar scripts e deployments",
    "mcpx-meta":          "Meta API — anúncios, campanhas, Instagram, Messenger",
  };

  const mcpLines = mcps
    .filter(m => m !== "mcpx-proxy")
    .map(m => `- **${m}** — ${mcpDocs[m] ?? "MCP instalado"}`)
    .join("\n");

  const lines: string[] = [
    `---`,
    `name: ${name}`,
    `description: Contexto e memória do projeto ${name} — MCPs instalados, decisões e histórico`,
    `type: project`,
    `updated: ${now}`,
    `---`,
    ``,
    `## Projeto: ${name}`,
    ``,
    `**Caminho local:** \`${cwd}\``,
    `**Atualizado em:** ${now}`,
    ``,
    `## MCPs instalados`,
    ``,
    mcpLines,
    ``,
    `## Como usar a memória neste projeto`,
    ``,
    `\`\`\``,
    `// Buscar contexto do projeto`,
    `search_memories({ project: "${name}", query: "contexto" })`,
    ``,
    `// Salvar uma decisão`,
    `save_memory({ key: "arch-{componente}", type: "decision", project: "${name}", value: "..." })`,
    ``,
    `// Salvar um gotcha`,
    `save_memory({ key: "gotcha-{problema}", type: "gotcha", project: "${name}", value: "..." })`,
    `\`\`\``,
    ``,
  ];

  if (lastSession) {
    lines.push(`## Última sessão`, ``, lastSession, ``);
  }

  if (decisions && decisions.length > 0) {
    lines.push(`## Decisões técnicas`, ``);
    decisions.forEach(d => lines.push(`- ${d}`));
    lines.push(``);
  }

  if (gotchas && gotchas.length > 0) {
    lines.push(`## Gotchas e armadilhas`, ``);
    gotchas.forEach(g => lines.push(`- ${g}`));
    lines.push(``);
  }

  return lines.join("\n");
}

// ─── Escreve o arquivo no caminho correto ────────────────────────────────────

export function writeProjectMemory(opts: ProjectMemoryOptions): string {
  const encoded  = encodeCwd(opts.cwd);
  const name     = projectNameFromCwd(opts.cwd);
  const memDir   = join(homedir(), ".claude", "projects", encoded, "memory");
  const memFile  = join(memDir, `project_${name}.md`);
  const indexFile = join(memDir, "MEMORY.md");

  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

  const content = generateProjectMemory(opts);
  writeFileSync(memFile, content, "utf-8");

  // Atualiza o índice MEMORY.md
  const indexEntry = `- [project_${name}.md](project_${name}.md) — Contexto do projeto ${name}: MCPs, decisões e histórico\n`;
  if (!existsSync(indexFile)) {
    writeFileSync(indexFile, `# Memory Index — ${name}\n\n${indexEntry}`, "utf-8");
  } else {
    const current = readFileSync(indexFile, "utf-8");
    if (!current.includes(`project_${name}.md`)) {
      writeFileSync(indexFile, current.trimEnd() + "\n" + indexEntry, "utf-8");
    }
  }

  return memFile;
}

// ─── Atualiza campos específicos sem reescrever tudo ─────────────────────────

export function updateProjectMemoryField(
  cwd: string,
  field: "lastSession" | "decisions" | "gotchas",
  value: string | string[]
): void {
  const encoded = encodeCwd(cwd);
  const name    = projectNameFromCwd(cwd);
  const memFile = join(homedir(), ".claude", "projects", encoded, "memory", `project_${name}.md`);

  if (!existsSync(memFile)) return;

  let content = readFileSync(memFile, "utf-8");
  const now = new Date().toISOString().slice(0, 10);

  // Atualiza data
  content = content.replace(/^updated: .+$/m, `updated: ${now}`);

  if (field === "lastSession" && typeof value === "string") {
    const section = `## Última sessão\n\n${value}\n`;
    if (content.includes("## Última sessão")) {
      content = content.replace(/## Última sessão\n[\s\S]*?(?=\n## |\n---|\s*$)/, section);
    } else {
      content = content.trimEnd() + "\n\n" + section;
    }
  }

  writeFileSync(memFile, content, "utf-8");
}
