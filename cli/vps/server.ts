import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Client } from "ssh2";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { resolveValue } from "./secrets.js";

// ─── SSH Config ───────────────────────────────────────────────────────────────

const VPS_SSH = resolveValue((process.env.VPS_SSH ?? "").replace(/^ssh\s+/, "").trim());
const VPS_PASSWORD = resolveValue(process.env.VPS_PASSWORD ?? "");

if (!VPS_SSH) {
  console.error("Erro: VPS_SSH é obrigatório. Ex: root@85.209.92.10");
  process.exit(1);
}

const [VPS_USER, VPS_HOST] = VPS_SSH.includes("@")
  ? VPS_SSH.split("@")
  : ["root", VPS_SSH];

const VPS_PORT = parseInt(process.env.VPS_PORT ?? "22");

// Tenta carregar chave privada automaticamente
function getPrivateKey(): Buffer | null {
  const candidates = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"];
  for (const name of candidates) {
    const path = resolve(homedir(), ".ssh", name);
    if (existsSync(path)) {
      try { return readFileSync(path); } catch { continue; }
    }
  }
  return null;
}

const privateKey = VPS_PASSWORD ? null : getPrivateKey();

// ─── SSH exec helper ──────────────────────────────────────────────────────────

function sshExec(command: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = "";
    let errOutput = "";

    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`Timeout após ${timeoutMs / 1000}s`));
    }, timeoutMs);

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); return reject(err); }

        stream.on("data", (d: Buffer) => { output += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { errOutput += d.toString(); });
        stream.on("close", () => {
          clearTimeout(timer);
          conn.end();
          resolve((output + (errOutput ? `\n[stderr]\n${errOutput}` : "")).trim());
        });
      });
    });

    conn.on("error", (err) => { clearTimeout(timer); reject(err); });

    const connectConfig: Record<string, unknown> = {
      host: VPS_HOST,
      port: VPS_PORT,
      username: VPS_USER,
      readyTimeout: 10_000,
    };

    if (VPS_PASSWORD) {
      connectConfig.password = VPS_PASSWORD;
    } else if (privateKey) {
      connectConfig.privateKey = privateKey;
    } else {
      connectConfig.agent = process.env.SSH_AUTH_SOCK;
    }

    conn.connect(connectConfig as Parameters<Client["connect"]>[0]);
  });
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function err(e: unknown) {
  return { content: [{ type: "text" as const, text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "@mcpx/vps",
  version: "1.0.0",
});

// ── run_command ───────────────────────────────────────────────────────────────

server.registerTool("run_command", {
  description: "Executa qualquer comando shell na VPS via SSH",
  inputSchema: {
    command: z.string().describe("Comando shell a executar"),
    timeout: z.coerce.number().int().min(1).max(300).optional().default(30).describe("Timeout em segundos (padrão 30)"),
  },
}, async ({ command, timeout }) => {
  try {
    const result = await sshExec(command, timeout * 1000);
    return ok(result || "(sem output)");
  } catch (e) { return err(e); }
});

// ── pm2_status ────────────────────────────────────────────────────────────────

server.registerTool("pm2_status", {
  description: "Lista todos os processos PM2 e seus status",
}, async () => {
  try {
    const result = await sshExec("pm2 jlist");
    const list = JSON.parse(result) as Array<Record<string, unknown>>;
    const lines = list.map((p) => {
      const name = p.name as string;
      const status = (p.pm2_env as Record<string, unknown>)?.status as string;
      const pid = p.pid as number;
      const mem = Math.round(((p.monit as Record<string, unknown>)?.memory as number) / 1024 / 1024);
      const restarts = (p.pm2_env as Record<string, unknown>)?.restart_time as number;
      return `${name} [${status}] pid=${pid} mem=${mem}MB restarts=${restarts}`;
    });
    return ok(lines.join("\n") || "Nenhum processo PM2.");
  } catch (e) { return err(e); }
});

// ── pm2_logs ──────────────────────────────────────────────────────────────────

server.registerTool("pm2_logs", {
  description: "Retorna as últimas linhas de log de um processo PM2",
  inputSchema: {
    name: z.string().describe("Nome do processo PM2"),
    lines: z.coerce.number().int().min(1).max(500).optional().default(50).describe("Número de linhas (padrão 50)"),
  },
}, async ({ name, lines }) => {
  try {
    const result = await sshExec(`pm2 logs ${name} --lines ${lines} --nostream 2>&1 | tail -${lines}`);
    return ok(result || "(sem logs)");
  } catch (e) { return err(e); }
});

// ── pm2_restart ───────────────────────────────────────────────────────────────

server.registerTool("pm2_restart", {
  description: "Reinicia um processo PM2",
  inputSchema: {
    name: z.string().describe("Nome do processo PM2"),
  },
}, async ({ name }) => {
  try {
    const result = await sshExec(`pm2 restart ${name} && pm2 show ${name} | grep status`);
    return ok(result);
  } catch (e) { return err(e); }
});

// ── pm2_stop ──────────────────────────────────────────────────────────────────

server.registerTool("pm2_stop", {
  description: "Para um processo PM2",
  inputSchema: {
    name: z.string().describe("Nome do processo PM2"),
  },
}, async ({ name }) => {
  try {
    const result = await sshExec(`pm2 stop ${name}`);
    return ok(result);
  } catch (e) { return err(e); }
});

// ── nginx_logs ────────────────────────────────────────────────────────────────

server.registerTool("nginx_logs", {
  description: "Retorna logs do nginx (access ou error)",
  inputSchema: {
    type: z.enum(["access", "error"]).optional().default("error").describe("Tipo de log"),
    lines: z.coerce.number().int().min(1).max(500).optional().default(50).describe("Número de linhas"),
    filter: z.string().optional().describe("Filtro grep (opcional)"),
  },
}, async ({ type, lines, filter }) => {
  try {
    const logPath = type === "access"
      ? "/var/log/nginx/access.log"
      : "/var/log/nginx/error.log";
    const cmd = filter
      ? `tail -${lines} ${logPath} | grep "${filter}"`
      : `tail -${lines} ${logPath}`;
    const result = await sshExec(cmd);
    return ok(result || "(sem logs)");
  } catch (e) { return err(e); }
});

// ── nginx_reload ──────────────────────────────────────────────────────────────

server.registerTool("nginx_reload", {
  description: "Testa e recarrega a configuração do nginx/openresty",
}, async () => {
  try {
    const result = await sshExec("nginx -t 2>&1 && systemctl reload nginx 2>/dev/null || openresty -t 2>&1 && systemctl reload openresty 2>/dev/null || echo 'reload enviado'");
    return ok(result);
  } catch (e) { return err(e); }
});

// ── docker_ps ─────────────────────────────────────────────────────────────────

server.registerTool("docker_ps", {
  description: "Lista containers Docker em execução",
}, async () => {
  try {
    const result = await sshExec("docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'");
    return ok(result || "Nenhum container em execução.");
  } catch (e) { return err(e); }
});

// ── docker_logs ───────────────────────────────────────────────────────────────

server.registerTool("docker_logs", {
  description: "Retorna logs de um container Docker",
  inputSchema: {
    name: z.string().describe("Nome ou ID do container"),
    lines: z.coerce.number().int().min(1).max(500).optional().default(50).describe("Número de linhas"),
  },
}, async ({ name, lines }) => {
  try {
    const result = await sshExec(`docker logs --tail ${lines} ${name} 2>&1`);
    return ok(result || "(sem logs)");
  } catch (e) { return err(e); }
});

// ── docker_restart ────────────────────────────────────────────────────────────

server.registerTool("docker_restart", {
  description: "Reinicia um container Docker",
  inputSchema: {
    name: z.string().describe("Nome ou ID do container"),
  },
}, async ({ name }) => {
  try {
    const result = await sshExec(`docker restart ${name} && docker ps --filter name=${name} --format '{{.Names}} {{.Status}}'`);
    return ok(result);
  } catch (e) { return err(e); }
});

// ── monitor ───────────────────────────────────────────────────────────────────

server.registerTool("monitor", {
  description: "Mostra uso de CPU, memória, disco e uptime da VPS",
}, async () => {
  try {
    const result = await sshExec(`
      echo "=== CPU ===" && top -bn1 | grep "Cpu(s)" | awk '{print $2+$4"% usado"}' &&
      echo "=== Memória ===" && free -h | grep Mem &&
      echo "=== Disco ===" && df -h / &&
      echo "=== Uptime ===" && uptime
    `);
    return ok(result);
  } catch (e) { return err(e); }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
