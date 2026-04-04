/**
 * mcpx memory MCP — memória global persistente por device
 *
 * Auth: X-Memory-Token (SHA256 do fingerprint da máquina, gerado pelo CLI)
 * DB:   memory_core (PostgreSQL compartilhado com mcp-tools)
 *
 * MCP tools:  save_memory, get_memory, search_memories, list_memories, delete_memory, ingest_session
 * REST:        POST /ingest  — usado pelo memory-watch (watcher automático)
 *              POST /register — registra device na primeira vez
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pg from "pg";
import { createHash } from "crypto";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import express, { Request, Response } from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });

const { Pool } = pg;

// ─── DB ───────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.MEMORY_DATABASE_URL,
  ssl: false,
  max: 20,
  idleTimeoutMillis: 60_000,
});

// ─── Auto-migrate ─────────────────────────────────────────────────────────────

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_devices (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token      TEXT UNIQUE NOT NULL,
      hostname   TEXT,
      platform   TEXT,
      username   TEXT,
      criado_em  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS memories (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id    UUID NOT NULL REFERENCES memory_devices(id) ON DELETE CASCADE,
      session_id   TEXT,
      project      TEXT,
      tipo         TEXT NOT NULL DEFAULT 'manual',
      chave        TEXT,
      valor        TEXT NOT NULL,
      tags         TEXT[],
      hash         TEXT,
      cursor_start BIGINT,
      cursor_end   BIGINT,
      criado_em    TIMESTAMPTZ DEFAULT now(),
      atualizado_em TIMESTAMPTZ DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_device_chave ON memories(device_id, chave) WHERE chave IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_device  ON memories(device_id);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(device_id, project);
    CREATE INDEX IF NOT EXISTS idx_memories_tipo    ON memories(device_id, tipo);
    CREATE INDEX IF NOT EXISTS idx_memories_search  ON memories USING gin(to_tsvector('portuguese', valor));
  `);
  console.log("memory: migrations OK");
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function resolveDevice(token: string | undefined): Promise<{ id: string } | null> {
  if (!token) return null;
  const r = await pool.query(
    `SELECT id FROM memory_devices WHERE token = $1`,
    [token]
  );
  return r.rows[0] ?? null;
}

async function autoRegisterDevice(
  token: string,
  meta: { hostname?: string; platform?: string; username?: string }
): Promise<string> {
  const r = await pool.query(
    `INSERT INTO memory_devices (token, hostname, platform, username)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE SET hostname = EXCLUDED.hostname
     RETURNING id`,
    [token, meta.hostname ?? null, meta.platform ?? null, meta.username ?? null]
  );
  return r.rows[0].id as string;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// ─── MCP Server factory ───────────────────────────────────────────────────────

function createServer(deviceId: string): McpServer {
  const server = new McpServer({ name: "mcpx-memory", version: "1.0.0" });

  // ── save_memory ──────────────────────────────────────────────────────────

  server.registerTool("save_memory", {
    description: "Salva ou atualiza uma memória persistente. Use para guardar decisões, contexto importante, receitas e gotchas entre sessões.",
    inputSchema: {
      key:       z.string().describe("Identificador único (ex: 'auth-pattern', 'db-schema-users')"),
      value:     z.string().describe("Conteúdo da memória"),
      type:      z.enum(["manual", "decision", "gotcha", "recipe", "context"]).optional().default("manual"),
      tags:      z.array(z.string()).optional().describe("Tags para filtrar depois"),
      project:   z.string().optional().describe("Projeto associado (ex: 'planner', 'checkout')"),
      session_id: z.string().optional(),
    },
  }, async ({ key, value, type, tags, project, session_id }) => {
    const hash = hashValue(value);
    await pool.query(
      `INSERT INTO memories (device_id, session_id, project, tipo, chave, valor, tags, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (device_id, chave)
       DO UPDATE SET valor = EXCLUDED.valor, tipo = EXCLUDED.tipo, tags = EXCLUDED.tags,
                     hash = EXCLUDED.hash, atualizado_em = now()
       WHERE memories.hash != EXCLUDED.hash`,
      [deviceId, session_id ?? null, project ?? null, type ?? "manual", key, value, tags ?? [], hash]
    );
    return { content: [{ type: "text", text: `Memória '${key}' salva.` }] };
  });

  // ── get_memory ───────────────────────────────────────────────────────────

  server.registerTool("get_memory", {
    description: "Busca uma memória pela chave exata.",
    inputSchema: {
      key: z.string().describe("Chave da memória"),
    },
  }, async ({ key }) => {
    const r = await pool.query(
      `SELECT id, chave, valor, tipo, tags, project, session_id, criado_em, atualizado_em
       FROM memories WHERE device_id = $1 AND chave = $2`,
      [deviceId, key]
    );
    if (r.rows.length === 0)
      return { content: [{ type: "text", text: `Memória '${key}' não encontrada.` }] };
    return { content: [{ type: "text", text: JSON.stringify(r.rows[0], null, 2) }] };
  });

  // ── search_memories ──────────────────────────────────────────────────────

  server.registerTool("search_memories", {
    description: "Busca memórias por texto, projeto ou tipo. Usa full-text search.",
    inputSchema: {
      query:   z.string().describe("Texto a buscar no conteúdo e na chave"),
      project: z.string().optional().describe("Filtrar por projeto"),
      type:    z.enum(["manual", "decision", "gotcha", "recipe", "context", "compact_summary", "assistant_response"]).optional(),
      limit:   z.coerce.number().int().min(1).max(50).optional().default(10),
    },
  }, async ({ query, project, type, limit }) => {
    const conditions: string[] = ["device_id = $1"];
    const params: unknown[] = [deviceId];
    let i = 2;

    if (project) { conditions.push(`project = $${i++}`); params.push(project); }
    if (type)    { conditions.push(`tipo = $${i++}`);    params.push(type); }

    conditions.push(`(chave ILIKE $${i} OR valor ILIKE $${i})`);
    params.push(`%${query}%`);
    i++;

    const r = await pool.query(
      `SELECT id, chave, valor, tipo, tags, project, session_id, criado_em
       FROM memories
       WHERE ${conditions.join(" AND ")}
       ORDER BY atualizado_em DESC
       LIMIT $${i}`,
      [...params, limit]
    );

    if (r.rows.length === 0)
      return { content: [{ type: "text", text: "Nenhuma memória encontrada." }] };

    const lines = r.rows.map((row: Record<string, unknown>) =>
      `[${row.tipo}] ${row.chave ?? "(sem chave)"} ${row.project ? `(${row.project})` : ""}\n${String(row.valor).slice(0, 300)}`
    );
    return { content: [{ type: "text", text: lines.join("\n\n---\n\n") }] };
  });

  // ── list_memories ────────────────────────────────────────────────────────

  server.registerTool("list_memories", {
    description: "Lista memórias salvas com filtros opcionais.",
    inputSchema: {
      project: z.string().optional(),
      type:    z.string().optional(),
      limit:   z.coerce.number().int().min(1).max(100).optional().default(20),
      offset:  z.coerce.number().int().min(0).optional().default(0),
    },
  }, async ({ project, type, limit, offset }) => {
    const conditions: string[] = ["device_id = $1"];
    const params: unknown[] = [deviceId];
    let i = 2;

    if (project) { conditions.push(`project = $${i++}`); params.push(project); }
    if (type)    { conditions.push(`tipo = $${i++}`);    params.push(type); }

    const r = await pool.query(
      `SELECT id, chave, tipo, project, LEFT(valor, 100) AS resumo, criado_em
       FROM memories
       WHERE ${conditions.join(" AND ")}
       ORDER BY atualizado_em DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    );

    const total = await pool.query(
      `SELECT COUNT(*) FROM memories WHERE ${conditions.join(" AND ")}`,
      params
    );

    const lines = r.rows.map((row: Record<string, unknown>) =>
      `• [${row.tipo}] ${row.chave ?? "(sem chave)"} ${row.project ? `(${row.project})` : ""}\n  ${String(row.resumo).replace(/\n/g, " ").slice(0, 100)}`
    );

    return { content: [{ type: "text", text: `${total.rows[0].count} memória(s) total:\n\n${lines.join("\n\n")}` }] };
  });

  // ── delete_memory ────────────────────────────────────────────────────────

  server.registerTool("delete_memory", {
    description: "Remove uma memória pelo id ou pela chave.",
    inputSchema: {
      id:  z.string().uuid().optional().describe("UUID da memória"),
      key: z.string().optional().describe("Chave da memória (alternativa ao id)"),
    },
  }, async ({ id, key }) => {
    if (!id && !key)
      return { content: [{ type: "text", text: "Informe id ou key." }], isError: true };

    const condition = id ? "id = $2" : "chave = $2";
    const value     = id ?? key;

    const r = await pool.query(
      `DELETE FROM memories WHERE device_id = $1 AND ${condition} RETURNING id`,
      [deviceId, value]
    );

    return r.rows.length > 0
      ? { content: [{ type: "text", text: `Memória removida.` }] }
      : { content: [{ type: "text", text: `Memória não encontrada.` }] };
  });

  // ── ingest_session ───────────────────────────────────────────────────────

  server.registerTool("ingest_session", {
    description: "Ingere em lote entradas de uma sessão Claude Code (chamado pelo watcher automático ou manualmente).",
    inputSchema: {
      session_id:   z.string(),
      project:      z.string().optional(),
      cursor_start: z.number().int(),
      cursor_end:   z.number().int(),
      entries: z.array(z.object({
        tipo:  z.enum(["compact_summary", "assistant_response", "file_edit"]),
        chave: z.string().optional(),
        valor: z.string(),
      })).min(1).max(200),
    },
  }, async ({ session_id, project, cursor_start, cursor_end, entries }) => {
    let saved = 0;
    let skipped = 0;

    for (const entry of entries) {
      const hash = hashValue(entry.valor);

      // Evita duplicatas por hash dentro da mesma sessão
      const exists = await pool.query(
        `SELECT 1 FROM memories WHERE device_id = $1 AND session_id = $2 AND hash = $3`,
        [deviceId, session_id, hash]
      );
      if (exists.rows.length > 0) { skipped++; continue; }

      await pool.query(
        `INSERT INTO memories (device_id, session_id, project, tipo, chave, valor, hash, cursor_start, cursor_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [deviceId, session_id, project ?? null, entry.tipo, entry.chave ?? null, entry.valor, hash, cursor_start, cursor_end]
      );
      saved++;
    }

    return { content: [{ type: "text", text: `${saved} entradas salvas, ${skipped} duplicatas ignoradas.` }] };
  });

  return server;
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

// Health
app.get("/health", (_req, res) => res.json({ status: "ok", service: "mcpx-memory" }));

// ── POST /register ────────────────────────────────────────────────────────────
// Registra device e retorna confirmação (chamado pelo CLI na primeira vez)
app.post("/register", async (req: Request, res: Response) => {
  const token    = req.headers["x-memory-token"] as string | undefined;
  const { hostname, platform, username } = req.body as Record<string, string>;

  if (!token) { res.status(400).json({ error: "X-Memory-Token obrigatório" }); return; }

  try {
    const id = await autoRegisterDevice(token, { hostname, platform, username });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── POST /ingest ──────────────────────────────────────────────────────────────
// REST endpoint para o memory-watch (sem overhead MCP)
app.post("/ingest", async (req: Request, res: Response) => {
  const token = req.headers["x-memory-token"] as string | undefined;
  if (!token) { res.status(401).json({ error: "X-Memory-Token obrigatório" }); return; }

  let device = await resolveDevice(token);
  if (!device) {
    const id = await autoRegisterDevice(token, {});
    device = { id };
  }

  const { session_id, project, cursor_start, cursor_end, entries } = req.body as {
    session_id: string;
    project?: string;
    cursor_start: number;
    cursor_end: number;
    entries: Array<{ tipo: string; chave?: string; valor: string }>;
  };

  if (!session_id || !Array.isArray(entries) || entries.length === 0) {
    res.status(400).json({ error: "session_id e entries[] obrigatórios" });
    return;
  }

  let saved = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.valor?.trim()) { skipped++; continue; }
    const hash = hashValue(entry.valor);

    const exists = await pool.query(
      `SELECT 1 FROM memories WHERE device_id = $1 AND session_id = $2 AND hash = $3`,
      [device.id, session_id, hash]
    );
    if (exists.rows.length > 0) { skipped++; continue; }

    await pool.query(
      `INSERT INTO memories (device_id, session_id, project, tipo, chave, valor, hash, cursor_start, cursor_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [device.id, session_id, project ?? null, entry.tipo, entry.chave ?? null, entry.valor, hash, cursor_start, cursor_end]
    );
    saved++;
  }

  res.json({ ok: true, saved, skipped });
});

// ── /mcp — MCP protocol ───────────────────────────────────────────────────────
app.all("/mcp", async (req: Request, res: Response) => {
  const token = req.headers["x-memory-token"] as string | undefined;
  if (!token) { res.status(401).json({ error: "X-Memory-Token obrigatório" }); return; }

  let device = await resolveDevice(token);
  if (!device) {
    const id = await autoRegisterDevice(token, {});
    device = { id };
  }

  const server    = createServer(device.id);
  const transport = new StreamableHTTPServerTransport({});
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ─── Startup ──────────────────────────────────────────────────────────────────

await migrate();

const PORT = process.env.PORT ?? 4005;
app.listen(PORT, () => console.log(`mcpx-memory rodando na porta ${PORT}`));

process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });
process.on("SIGINT",  async () => { await pool.end(); process.exit(0); });
