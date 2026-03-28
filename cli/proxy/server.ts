#!/usr/bin/env node
/**
 * @mcpx-io/proxy — proxy local HTTP que resolve secrets mcpx:enc:* nos headers
 * antes de encaminhar para mcpx.online
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { resolveValue } from "./secrets.js";

const UPSTREAM = "https://mcpx.online";
const PORT = parseInt(process.env.MCPX_PROXY_PORT ?? "4099");

// ─── Headers que NÃO repassar ao upstream ────────────────────────────────────

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
  "host",
]);

// ─── Proxy HTTP ───────────────────────────────────────────────────────────────

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
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
    process.stderr.write(`Porta ${PORT} em uso. Use MCPX_PROXY_PORT para mudar.\n`);
  } else {
    process.stderr.write(`Erro no proxy: ${e.message}\n`);
  }
  process.exit(1);
});

// ─── MCP Server (stdio) — mantém o processo vivo e expõe status ──────────────

const mcp = new McpServer({ name: "@mcpx-io/proxy", version: "1.0.0" });

mcp.registerTool("proxy_status", {
  description: "Retorna o status do proxy local mcpx",
}, async () => {
  return {
    content: [{
      type: "text",
      text: `mcpx-proxy ativo em http://127.0.0.1:${PORT}\nEncaminha para: ${UPSTREAM}`,
    }],
  };
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
