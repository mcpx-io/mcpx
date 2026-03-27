import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import pg from "pg";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import express, { Request, Response } from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });

const { Pool } = pg;
const sqlParamSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// ─── Pool Manager ────────────────────────────────────────────────────────────

const pools = new Map<string, pg.Pool>();

function getPool(databaseUrl: string): pg.Pool {
  let pool = pools.get(databaseUrl);
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: false,
      max: 10,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on("error", (err) => console.error(`Pool error [${databaseUrl.split("@")[1]}]:`, err.message));
    pools.set(databaseUrl, pool);
  }
  return pool;
}

// ─── Session Store (in-memory only) ─────────────────────────────────────────

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  databaseUrl: string;
}

const sessions = new Map<string, Session>();

// ─── MCP Server factory ──────────────────────────────────────────────────────

function createServer(databaseUrl: string): McpServer {
  const server = new McpServer({
    name: "@mcp-tools/postgres",
    version: "1.0.0",
  });

  const pool = getPool(databaseUrl);

  function requirePool(): pg.Pool {
    return pool;
  }

  // ── list_tables ──────────────────────────────────────────────────────

  server.registerTool("list_tables", {
    description: "Lista todas as tabelas do banco de dados público",
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async () => {
    try {
      const result = await requirePool().query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      const tables = result.rows.map((r: Record<string, unknown>) => r.table_name as string);
      return { content: [{ type: "text", text: tables.join("\n") || "Nenhuma tabela encontrada." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── describe_table ───────────────────────────────────────────────────

  server.registerTool("describe_table", {
    description: "Mostra colunas, tipos, nullability e constraints de uma tabela",
    inputSchema: {
      table_name: z.string().regex(/^[a-z_][a-z0-9_]*$/i).describe("Nome da tabela"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ table_name }) => {
    try {
      const result = await requirePool().query(
        `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
          CASE WHEN pk.column_name IS NOT NULL THEN 'PK' ELSE '' END AS pk
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.column_name FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
          WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
        ) pk ON c.column_name = pk.column_name
        WHERE c.table_name = $1 AND c.table_schema = 'public'
        ORDER BY c.ordinal_position`,
        [table_name]
      );

      if (result.rows.length === 0)
        return { content: [{ type: "text", text: `Tabela '${table_name}' não encontrada.` }] };

      const lines = result.rows.map((r: Record<string, unknown>) => {
        const nullable = r.is_nullable === "YES" ? "null" : "not null";
        const pk = r.pk ? " [PK]" : "";
        const def = r.column_default != null ? ` default=${r.column_default}` : "";
        return `  ${r.column_name} ${r.data_type} ${nullable}${def}${pk}`;
      });

      return { content: [{ type: "text", text: `${table_name}\n${lines.join("\n")}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── get_table_schema ─────────────────────────────────────────────────

  server.registerTool("get_table_schema", {
    description: "Retorna o SQL CREATE TABLE completo com indexes",
    inputSchema: {
      table_name: z.string().regex(/^[a-z_][a-z0-9_]*$/i).describe("Nome da tabela"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ table_name }) => {
    try {
      const cols = await requirePool().query(
        `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default, udt_name
        FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = 'public'
        ORDER BY ordinal_position`,
        [table_name]
      );

      if (cols.rows.length === 0)
        return { content: [{ type: "text", text: `Tabela '${table_name}' não encontrada.` }] };

      const indexes = await requirePool().query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 AND schemaname = 'public'`,
        [table_name]
      );

      const colLines = cols.rows.map((c: Record<string, unknown>) => {
        const type = c.character_maximum_length
          ? `${c.data_type}(${c.character_maximum_length})`
          : c.udt_name === "uuid" ? "uuid" : String(c.data_type);
        const nullable = c.is_nullable === "NO" ? " NOT NULL" : "";
        const def = c.column_default ? ` DEFAULT ${c.column_default}` : "";
        return `  ${c.column_name} ${type}${nullable}${def}`;
      });

      const parts = [`CREATE TABLE ${table_name} (`, colLines.join(",\n"), `);`];
      if (indexes.rows.length > 0) {
        parts.push("");
        parts.push(indexes.rows.map((i: Record<string, unknown>) => `${i.indexdef};`).join("\n"));
      }

      return { content: [{ type: "text", text: parts.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── query (SELECT only) ──────────────────────────────────────────────

  server.registerTool("query", {
    description: "Executa uma consulta SQL somente leitura (SELECT/WITH). Retorna JSON.",
    inputSchema: {
      sql: z.string().describe("Query SQL (SELECT ou WITH)"),
      params: z.array(sqlParamSchema).optional().describe("Parâmetros ($1, $2, ...)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ sql, params }) => {
    const trimmed = sql.trim().toUpperCase();
    if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH"))
      return { content: [{ type: "text", text: "Apenas SELECT ou WITH." }], isError: true };

    try {
      const result = await requirePool().query(sql, (params ?? []) as unknown[]);
      const text = result.rows.length === 0
        ? "Nenhum resultado."
        : JSON.stringify(result.rows, null, 2);
      return { content: [{ type: "text", text: `${result.rowCount} linha(s):\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── get_rows ─────────────────────────────────────────────────────────

  server.registerTool("get_rows", {
    description: "Busca linhas de uma tabela com filtros, ordenação e paginação",
    inputSchema: {
      table: z.string().regex(/^[a-z_][a-z0-9_]*$/i).describe("Nome da tabela"),
      where: z.string().optional().describe("Condição WHERE (sem a palavra WHERE)"),
      order_by: z.string().optional().describe("Ordenação (sem ORDER BY)"),
      limit: z.coerce.number().int().min(1).max(1000).optional().default(50).describe("Limite (1-1000, padrão 50)"),
      offset: z.coerce.number().int().min(0).optional().default(0).describe("Offset (padrão 0)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ table, where, order_by, limit, offset }) => {
    try {
      const sql = `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""}${order_by ? ` ORDER BY ${order_by}` : ""} LIMIT ${limit} OFFSET ${offset}`;
      const result = await requirePool().query(sql);
      const text = result.rows.length === 0
        ? "Nenhum resultado."
        : JSON.stringify(result.rows, null, 2);
      return { content: [{ type: "text", text: `${result.rowCount} linha(s):\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── execute_migration (DDL) ──────────────────────────────────────────

  server.registerTool("execute_migration", {
    description: "Executa DDL: CREATE TABLE, ALTER TABLE, CREATE INDEX, etc. Rollback automático em caso de erro.",
    inputSchema: {
      sql: z.string().describe("SQL DDL a executar"),
      description: z.string().optional().describe("Descrição da migration (opcional)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ sql, description }) => {
    const trimmed = sql.trim().toUpperCase();
    const allowed = [
      "CREATE TABLE", "ALTER TABLE", "DROP TABLE",
      "CREATE INDEX", "DROP INDEX",
      "VACUUM", "ANALYZE",
      "CREATE TYPE", "DROP TYPE",
      "CREATE EXTENSION", "DROP EXTENSION",
      "CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", "DROP FUNCTION",
      "CREATE TRIGGER", "CREATE OR REPLACE TRIGGER", "DROP TRIGGER",
      "COMMENT ON",
    ];
    if (!allowed.some((p) => trimmed.startsWith(p)))
      return { content: [{ type: "text", text: `SQL não permitido. Apenas DDL: ${allowed.join(", ")}` }], isError: true };

    const client = await requirePool().connect();
    const noTransaction = trimmed.startsWith("VACUUM") || trimmed.startsWith("ANALYZE");
    try {
      if (noTransaction) {
        await client.query(sql);
      } else {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
      }
      return { content: [{ type: "text", text: `OK${description ? `: ${description}` : ""}\n\n${sql}` }] };
    } catch (err) {
      if (!noTransaction) await client.query("ROLLBACK");
      return { content: [{ type: "text", text: `Erro${noTransaction ? "" : " (rollback)"}: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    } finally {
      client.release();
    }
  });

  // ── execute_dml (INSERT/UPDATE/DELETE) ───────────────────────────────

  server.registerTool("execute_dml", {
    description: "Executa INSERT, UPDATE ou DELETE com rollback automático em caso de erro.",
    inputSchema: {
      sql: z.string().describe("SQL DML (INSERT, UPDATE, DELETE)"),
      params: z.array(sqlParamSchema).optional().describe("Parâmetros ($1, $2, ...)"),
      description: z.string().optional().describe("Descrição da operação (opcional)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ sql, params, description }) => {
    const trimmed = sql.trim().toUpperCase();
    if (!["INSERT", "UPDATE", "DELETE"].some((p) => trimmed.startsWith(p)))
      return { content: [{ type: "text", text: "Apenas INSERT, UPDATE ou DELETE." }], isError: true };

    const client = await requirePool().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(sql, (params ?? []) as unknown[]);
      await client.query("COMMIT");
      return { content: [{ type: "text", text: `OK${description ? `: ${description}` : ""}\n${result.rowCount} linha(s) afetada(s).` }] };
    } catch (err) {
      await client.query("ROLLBACK");
      return { content: [{ type: "text", text: `Erro (rollback): ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    } finally {
      client.release();
    }
  });

  // ── list_enums ───────────────────────────────────────────────────────

  server.registerTool("list_enums", {
    description: "Lista todos os tipos ENUM do banco PostgreSQL com seus valores",
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async () => {
    try {
      const result = await requirePool().query(`
        SELECT t.typname AS nome, string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS valores
        FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY t.typname
      `);
      if (result.rows.length === 0) return { content: [{ type: "text", text: "Nenhum ENUM encontrado." }] };
      const lines = result.rows.map((r: Record<string, unknown>) => `${r.nome}: ${r.valores}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── table_sizes ──────────────────────────────────────────────────────

  server.registerTool("table_sizes", {
    description: "Mostra tamanho de cada tabela (dados, indexes, total) e contagem estimada de linhas",
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async () => {
    try {
      const result = await requirePool().query(`
        SELECT relname AS tabela,
          pg_size_pretty(pg_total_relation_size(relid)) AS total,
          pg_size_pretty(pg_relation_size(relid)) AS dados,
          pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS indexes,
          n_live_tup AS linhas
        FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC
      `);
      if (result.rows.length === 0) return { content: [{ type: "text", text: "Nenhuma tabela." }] };
      const lines = result.rows.map((r: Record<string, unknown>) =>
        `${r.tabela}: ${r.total} (dados: ${r.dados}, idx: ${r.indexes}) ~${r.linhas} linhas`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── list_foreign_keys ────────────────────────────────────────────────

  server.registerTool("list_foreign_keys", {
    description: "Lista foreign keys e relacionamentos entre tabelas",
    inputSchema: {
      table_name: z.string().optional().describe("Filtrar por tabela (opcional)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ table_name }) => {
    try {
      const result = await requirePool().query(
        `SELECT tc.table_name AS tabela, kcu.column_name AS coluna,
          ccu.table_name AS ref_tabela, ccu.column_name AS ref_coluna,
          tc.constraint_name AS fk
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
          ${table_name ? "AND (tc.table_name = $1 OR ccu.table_name = $1)" : ""}
        ORDER BY tc.table_name`,
        table_name ? [table_name] : []
      );

      if (result.rows.length === 0) return { content: [{ type: "text", text: "Nenhuma FK encontrada." }] };
      const lines = result.rows.map((r: Record<string, unknown>) =>
        `${r.tabela}.${r.coluna} → ${r.ref_tabela}.${r.ref_coluna} (${r.fk})`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  return server;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "@mcp-tools/postgres",
    sessions: sessions.size,
    pools: pools.size,
  });
});

app.all("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Existing session — reuse
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // DELETE — close session
  if (req.method === "DELETE") {
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) await session.transport.close();
      sessions.delete(sessionId);
    }
    res.status(200).json({ ok: true });
    return;
  }

  // New session — requires X-Database-URL header
  const databaseUrl = req.headers["x-database-url"] as string | undefined;
  if (!databaseUrl) {
    res.status(400).json({
      error: "Missing X-Database-URL header. Add it to your .mcp.json:\n\"X-Database-URL\": \"postgresql://user:pass@host:5432/dbname\"",
    });
    return;
  }

  const newSessionId = randomUUID();
  const server = createServer(databaseUrl);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
  });

  await server.connect(transport);

  transport.onclose = () => {
    sessions.delete(newSessionId);
  };

  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    sessions.set(newSessionId, { server, transport, databaseUrl });
  }
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown() {
  console.log("Shutting down...");
  for (const [id, session] of sessions) {
    await session.transport.close();
    sessions.delete(id);
  }
  for (const [url, pool] of pools) {
    await pool.end();
    pools.delete(url);
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4010;
app.listen(PORT, () => console.log(`@mcp-tools/postgres rodando na porta ${PORT}`));
