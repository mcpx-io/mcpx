/**
 * @mcpx-io/proxy — proxy local HTTP que resolve secrets mcpx:enc:* nos headers
 * antes de encaminhar para mcpx.online
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { resolveValue } from "./secrets.js";
import { startMemoryWatch } from "./memory-watch.js";

const UPSTREAM = "https://mcpx.online";
const PORT = parseInt(process.env.MCPX_PROXY_PORT ?? "4099");

// ─── PID file — mata instância anterior para liberar a porta ─────────────────

const MCPX_DIR = join(homedir(), ".mcpx");
const PID_FILE = join(MCPX_DIR, ".proxy.pid");

if (!existsSync(MCPX_DIR)) mkdirSync(MCPX_DIR, { recursive: true, mode: 0o700 });

if (existsSync(PID_FILE)) {
  try {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    if (!isNaN(oldPid) && oldPid !== process.pid) {
      process.kill(oldPid, "SIGTERM");
      // aguarda porta liberar
      await new Promise(r => setTimeout(r, 400));
    }
  } catch { /* processo já morto, tudo bem */ }
}

writeFileSync(PID_FILE, String(process.pid));
process.on("exit", () => { try { unlinkSync(PID_FILE); } catch {} });

// ─── Health-check ─────────────────────────────────────────────────────────────

const REMOTE_SERVICES: Record<string, string> = {
  postgres: `${UPSTREAM}/postgres/health`,
  redis:    `${UPSTREAM}/redis/health`,
  memory:   `${UPSTREAM}/memory/health`,
};

const healthStatus: Record<string, { ok: boolean; latency?: number; error?: string; checkedAt: string }> = {};

async function checkHealth() {
  for (const [name, url] of Object.entries(REMOTE_SERVICES)) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      healthStatus[name] = { ok: r.ok, latency: Date.now() - t0, checkedAt: new Date().toISOString() };
    } catch (e) {
      healthStatus[name] = { ok: false, error: (e as Error).message, checkedAt: new Date().toISOString() };
    }
  }
}

// Checa na inicialização e a cada 2 minutos
checkHealth();
setInterval(checkHealth, 2 * 60 * 1000).unref();

// ─── Headers que NÃO repassar ao upstream ────────────────────────────────────

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
  "host",
]);

// ─── Proxy HTTP ───────────────────────────────────────────────────────────────

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    // ── Endpoint local de status ──────────────────────────────────────────
    if (req.url === "/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proxy: "ok", port: PORT, services: healthStatus }, null, 2));
      return;
    }

    const url = `${UPSTREAM}${req.url}`;

    // Resolve secrets nos headers
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      const raw = Array.isArray(v) ? v[0] : (v ?? "");
      headers[k] = resolveValue(raw);
    }
    headers["host"] = new URL(UPSTREAM).host;

    // Lê body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    // Encaminha para upstream
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: body?.length ? body : undefined,
      // @ts-ignore — Node 18+ fetch
      duplex: "half",
    });

    // Repassa headers de resposta
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));

    // Streaming da resposta
    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: msg }));
  }
});

httpServer.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`mcpx-proxy rodando em http://127.0.0.1:${PORT}\n`);
});

httpServer.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    // Outra instância já está rodando — não precisa crashar, MCP stdio continua ativo
    process.stderr.write(`mcpx-proxy: porta ${PORT} já em uso (outra instância ativa).\n`);
  } else {
    process.stderr.write(`Erro no proxy: ${e.message}\n`);
    process.exit(1);
  }
});

// ─── MCP Server (stdio) — mantém o processo vivo e expõe status ──────────────

const mcp = new McpServer({ name: "@mcpx-io/proxy", version: "1.0.2" });

mcp.registerTool("proxy_status", {
  description: "Retorna o status do proxy local mcpx e saúde dos serviços remotos",
}, async () => {
  const lines = [`mcpx-proxy ativo em http://127.0.0.1:${PORT}`, `Upstream: ${UPSTREAM}`, ""];
  for (const [name, s] of Object.entries(healthStatus)) {
    const icon = s.ok ? "✓" : "✗";
    const info = s.ok ? `${s.latency}ms` : s.error ?? "erro";
    lines.push(`${icon} ${name}: ${info} (${s.checkedAt})`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
});

mcp.registerTool("health_check", {
  description: "Força uma verificação imediata da saúde de todos os serviços mcpx e retorna o resultado",
}, async () => {
  await checkHealth();
  const lines: string[] = [];
  for (const [name, s] of Object.entries(healthStatus)) {
    const icon = s.ok ? "✓" : "✗";
    const info = s.ok ? `${s.latency}ms` : s.error ?? "erro";
    lines.push(`${icon} ${name}: ${info}`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
});

const transport = new StdioServerTransport();
await mcp.connect(transport);

// Inicia o watcher de sessões Claude Code (auto-compact + ingest)
startMemoryWatch();
