import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import Redis from "ioredis";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import express, { Request, Response } from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });

// ─── Client Manager ──────────────────────────────────────────────────────────

const clients = new Map<string, Redis>();

function getClient(redisUrl: string): Redis {
  let client = clients.get(redisUrl);
  if (!client) {
    client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 5_000,
      commandTimeout: 10_000,
      maxRetriesPerRequest: 1,
    });
    client.on("error", (err) => console.error(`Redis error [${redisUrl.split("@")[1] ?? redisUrl}]:`, err.message));
    clients.set(redisUrl, client);
  }
  return client;
}

// ─── Session Store ───────────────────────────────────────────────────────────

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  redisUrl: string;
}

const sessions = new Map<string, Session>();

// ─── MCP Server factory ──────────────────────────────────────────────────────

function createServer(redisUrl: string): McpServer {
  const server = new McpServer({ name: "@mcpx/redis", version: "1.0.0" });
  const r = getClient(redisUrl);

  function ok(text: string) {
    return { content: [{ type: "text" as const, text }] };
  }
  function err(e: unknown) {
    return { content: [{ type: "text" as const, text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }

  // ── get ──────────────────────────────────────────────────────────────

  server.registerTool("get", {
    description: "GET key — retorna o valor de uma chave",
    inputSchema: { key: z.string().describe("Chave") },
    annotations: { readOnlyHint: true },
  }, async ({ key }) => {
    try {
      const val = await r.get(key);
      return ok(val === null ? "(nil)" : val);
    } catch (e) { return err(e); }
  });

  // ── set ──────────────────────────────────────────────────────────────

  server.registerTool("set", {
    description: "SET key value — define o valor de uma chave, com TTL opcional",
    inputSchema: {
      key: z.string().describe("Chave"),
      value: z.string().describe("Valor"),
      ttl_seconds: z.coerce.number().int().min(1).optional().describe("TTL em segundos (opcional)"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ key, value, ttl_seconds }) => {
    try {
      if (ttl_seconds) {
        await r.set(key, value, "EX", ttl_seconds);
      } else {
        await r.set(key, value);
      }
      return ok(`OK — ${key} = ${value}${ttl_seconds ? ` (expira em ${ttl_seconds}s)` : ""}`);
    } catch (e) { return err(e); }
  });

  // ── del ──────────────────────────────────────────────────────────────

  server.registerTool("del", {
    description: "DEL key [key ...] — remove uma ou mais chaves",
    inputSchema: { keys: z.array(z.string()).min(1).describe("Lista de chaves") },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ keys }) => {
    try {
      const count = await r.del(...keys);
      return ok(`${count} chave(s) removida(s)`);
    } catch (e) { return err(e); }
  });

  // ── exists ───────────────────────────────────────────────────────────

  server.registerTool("exists", {
    description: "EXISTS key — verifica se uma chave existe",
    inputSchema: { key: z.string().describe("Chave") },
    annotations: { readOnlyHint: true },
  }, async ({ key }) => {
    try {
      const exists = await r.exists(key);
      return ok(exists ? `"${key}" existe` : `"${key}" não existe`);
    } catch (e) { return err(e); }
  });

  // ── scan ─────────────────────────────────────────────────────────────

  server.registerTool("scan", {
    description: "SCAN — lista chaves por padrão (seguro para produção, não bloqueia o servidor)",
    inputSchema: {
      pattern: z.string().default("*").describe("Padrão glob (ex: user:*, session:*)"),
      count: z.coerce.number().int().min(1).max(10000).optional().default(100).describe("Quantidade aproximada por iteração (padrão 100)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ pattern, count }) => {
    try {
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await r.scan(cursor, "MATCH", pattern, "COUNT", count);
        cursor = next;
        keys.push(...batch);
        if (keys.length >= 1000) break;
      } while (cursor !== "0");
      return ok(keys.length === 0 ? "Nenhuma chave encontrada." : `${keys.length} chave(s):\n${keys.join("\n")}`);
    } catch (e) { return err(e); }
  });

  // ── ttl ──────────────────────────────────────────────────────────────

  server.registerTool("ttl", {
    description: "TTL key — retorna o tempo de vida restante da chave em segundos (-1 = sem expiração, -2 = não existe)",
    inputSchema: { key: z.string().describe("Chave") },
    annotations: { readOnlyHint: true },
  }, async ({ key }) => {
    try {
      const ttl = await r.ttl(key);
      const msg = ttl === -2 ? `"${key}" não existe`
        : ttl === -1 ? `"${key}" não tem expiração`
        : `"${key}" expira em ${ttl}s`;
      return ok(msg);
    } catch (e) { return err(e); }
  });

  // ── expire ───────────────────────────────────────────────────────────

  server.registerTool("expire", {
    description: "EXPIRE key seconds — define TTL para uma chave existente",
    inputSchema: {
      key: z.string().describe("Chave"),
      seconds: z.coerce.number().int().min(1).describe("TTL em segundos"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ key, seconds }) => {
    try {
      const result = await r.expire(key, seconds);
      return ok(result === 1 ? `TTL definido: ${key} expira em ${seconds}s` : `"${key}" não existe`);
    } catch (e) { return err(e); }
  });

  // ── type ─────────────────────────────────────────────────────────────

  server.registerTool("type", {
    description: "TYPE key — retorna o tipo do valor (string, list, set, zset, hash, stream)",
    inputSchema: { key: z.string().describe("Chave") },
    annotations: { readOnlyHint: true },
  }, async ({ key }) => {
    try {
      const t = await r.type(key);
      return ok(`"${key}": ${t}`);
    } catch (e) { return err(e); }
  });

  // ── incr ─────────────────────────────────────────────────────────────

  server.registerTool("incr", {
    description: "INCR / INCRBY key — incrementa o valor numérico de uma chave",
    inputSchema: {
      key: z.string().describe("Chave"),
      by: z.coerce.number().int().optional().default(1).describe("Incremento (padrão 1)"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ key, by }) => {
    try {
      const val = by === 1 ? await r.incr(key) : await r.incrby(key, by);
      return ok(`${key} = ${val}`);
    } catch (e) { return err(e); }
  });

  // ── hget ─────────────────────────────────────────────────────────────

  server.registerTool("hget", {
    description: "HGET key field — retorna o valor de um campo em um hash",
    inputSchema: {
      key: z.string().describe("Chave do hash"),
      field: z.string().describe("Campo"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ key, field }) => {
    try {
      const val = await r.hget(key, field);
      return ok(val === null ? "(nil)" : val);
    } catch (e) { return err(e); }
  });

  // ── hset ─────────────────────────────────────────────────────────────

  server.registerTool("hset", {
    description: "HSET key — define um ou mais campos em um hash",
    inputSchema: {
      key: z.string().describe("Chave do hash"),
      fields: z.record(z.string()).describe("Objeto com campo: valor"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ key, fields }) => {
    try {
      const args = Object.entries(fields).flat();
      await r.hset(key, ...args);
      return ok(`OK — ${Object.keys(fields).length} campo(s) definido(s) em "${key}"`);
    } catch (e) { return err(e); }
  });

  // ── hgetall ──────────────────────────────────────────────────────────

  server.registerTool("hgetall", {
    description: "HGETALL key — retorna todos os campos e valores de um hash",
    inputSchema: { key: z.string().describe("Chave do hash") },
    annotations: { readOnlyHint: true },
  }, async ({ key }) => {
    try {
      const data = await r.hgetall(key);
      if (!data || Object.keys(data).length === 0) return ok(`"${key}" não existe ou está vazio`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  });

  // ── hdel ─────────────────────────────────────────────────────────────

  server.registerTool("hdel", {
    description: "HDEL key field [field ...] — remove campos de um hash",
    inputSchema: {
      key: z.string().describe("Chave do hash"),
      fields: z.array(z.string()).min(1).describe("Campos a remover"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ key, fields }) => {
    try {
      const count = await r.hdel(key, ...fields);
      return ok(`${count} campo(s) removido(s) de "${key}"`);
    } catch (e) { return err(e); }
  });

  // ── lpush ─────────────────────────────────────────────────────────────

  server.registerTool("lpush", {
    description: "LPUSH key value [value ...] — insere valores no início de uma lista",
    inputSchema: {
      key: z.string().describe("Chave da lista"),
      values: z.array(z.string()).min(1).describe("Valores a inserir"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ key, values }) => {
    try {
      const len = await r.lpush(key, ...values);
      return ok(`Lista "${key}" tem agora ${len} elemento(s)`);
    } catch (e) { return err(e); }
  });

  // ── rpush ─────────────────────────────────────────────────────────────

  server.registerTool("rpush", {
    description: "RPUSH key value [value ...] — insere valores no fim de uma lista",
    inputSchema: {
      key: z.string().describe("Chave da lista"),
      values: z.array(z.string()).min(1).describe("Valores a inserir"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ key, values }) => {
    try {
      const len = await r.rpush(key, ...values);
      return ok(`Lista "${key}" tem agora ${len} elemento(s)`);
    } catch (e) { return err(e); }
  });

  // ── lrange ────────────────────────────────────────────────────────────

  server.registerTool("lrange", {
    description: "LRANGE key start stop — retorna elementos de uma lista (0 = primeiro, -1 = último)",
    inputSchema: {
      key: z.string().describe("Chave da lista"),
      start: z.coerce.number().int().optional().default(0).describe("Índice inicial (padrão 0)"),
      stop: z.coerce.number().int().optional().default(-1).describe("Índice final (padrão -1 = todos)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ key, start, stop }) => {
    try {
      const items = await r.lrange(key, start, stop);
      return ok(items.length === 0 ? `"${key}" vazio ou não existe` : items.join("\n"));
    } catch (e) { return err(e); }
  });

  // ── llen ──────────────────────────────────────────────────────────────

  server.registerTool("llen", {
    description: "LLEN key — retorna o tamanho de uma lista",
    inputSchema: { key: z.string().describe("Chave da lista") },
    annotations: { readOnlyHint: true },
  }, async ({ key }) => {
    try {
      const len = await r.llen(key);
      return ok(`"${key}": ${len} elemento(s)`);
    } catch (e) { return err(e); }
  });

  // ── sadd ──────────────────────────────────────────────────────────────

  server.registerTool("sadd", {
    description: "SADD key member [member ...] — adiciona membros a um set",
    inputSchema: {
      key: z.string().describe("Chave do set"),
      members: z.array(z.string()).min(1).describe("Membros a adicionar"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ key, members }) => {
    try {
      const count = await r.sadd(key, ...members);
      return ok(`${count} membro(s) adicionado(s) a "${key}"`);
    } catch (e) { return err(e); }
  });

  // ── smembers ──────────────────────────────────────────────────────────

  server.registerTool("smembers", {
    description: "SMEMBERS key — retorna todos os membros de um set",
    inputSchema: { key: z.string().describe("Chave do set") },
    annotations: { readOnlyHint: true },
  }, async ({ key }) => {
    try {
      const members = await r.smembers(key);
      return ok(members.length === 0 ? `"${key}" vazio ou não existe` : members.join("\n"));
    } catch (e) { return err(e); }
  });

  // ── srem ──────────────────────────────────────────────────────────────

  server.registerTool("srem", {
    description: "SREM key member [member ...] — remove membros de um set",
    inputSchema: {
      key: z.string().describe("Chave do set"),
      members: z.array(z.string()).min(1).describe("Membros a remover"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ key, members }) => {
    try {
      const count = await r.srem(key, ...members);
      return ok(`${count} membro(s) removido(s) de "${key}"`);
    } catch (e) { return err(e); }
  });

  // ── info ──────────────────────────────────────────────────────────────

  server.registerTool("info", {
    description: "INFO — retorna estatísticas do servidor Redis (memória, clientes, keyspace, etc.)",
    inputSchema: {
      section: z.enum(["all", "server", "clients", "memory", "stats", "keyspace"]).optional().default("all").describe("Seção do INFO"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ section }) => {
    try {
      const raw = section === "all" ? await r.info() : await r.info(section);
      return ok(raw);
    } catch (e) { return err(e); }
  });

  // ── dbsize ────────────────────────────────────────────────────────────

  server.registerTool("dbsize", {
    description: "DBSIZE — retorna o número total de chaves no banco atual",
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const size = await r.dbsize();
      return ok(`${size} chave(s) no banco`);
    } catch (e) { return err(e); }
  });

  return server;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "@mcpx/redis", sessions: sessions.size, clients: clients.size });
});

app.all("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  if (req.method === "DELETE") {
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) await session.transport.close();
      sessions.delete(sessionId);
    }
    res.status(200).json({ ok: true });
    return;
  }

  const redisUrl = req.headers["x-redis-url"] as string | undefined;
  if (!redisUrl) {
    res.status(400).json({
      error: "Missing X-Redis-URL header. Add it to your .mcp.json:\n\"X-Redis-URL\": \"redis://user:pass@host:6379\"",
    });
    return;
  }

  const newSessionId = randomUUID();
  const server = createServer(redisUrl);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
  });

  await server.connect(transport);

  transport.onclose = () => sessions.delete(newSessionId);

  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    sessions.set(newSessionId, { server, transport, redisUrl });
  }
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  console.log("Shutting down...");
  for (const [id, session] of sessions) {
    await session.transport.close();
    sessions.delete(id);
  }
  for (const [url, client] of clients) {
    client.disconnect();
    clients.delete(url);
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4020;
app.listen(PORT, () => console.log(`@mcpx/redis rodando na porta ${PORT}`));
