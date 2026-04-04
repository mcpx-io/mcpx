/**
 * memory-watch — auto-compact de sessões Claude Code
 *
 * Fluxo:
 *   1. Poll a cada 5min em ~/.claude/projects/ buscando .jsonl > 2MB
 *   2. Lê apenas linhas NOVAS desde o último cursor
 *   3. Extrai: compact_summaries, respostas finais do assistente, edições de arquivos
 *   4. POST https://mcpx.online/memory/ingest com as entradas + token do device
 *   5. Atualiza cursor em ~/.mcpx/cursors.json
 *   6. Quando sessão fecha (pid morto): trunca .jsonl → últimas 50 linhas + último compact summary
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { readdir, stat, readFile, writeFile, open } from "fs/promises";
import { join, basename } from "path";
import { homedir, hostname, platform, userInfo } from "os";
import { createHash } from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

const UPSTREAM        = "https://mcpx.online";
const MCPX_DIR        = join(homedir(), ".mcpx");
const CURSORS_FILE    = join(MCPX_DIR, "cursors.json");
const CLAUDE_DIR      = join(homedir(), ".claude");
const SESSIONS_DIR    = join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR    = join(CLAUDE_DIR, "projects");
const SIZE_THRESHOLD  = 5 * 1024 * 1024;   // 5MB
const MAX_READ_BYTES  = 2 * 1024 * 1024;   // lê no máx 2MB por vez (evita OOM)
const POLL_INTERVAL   = 5 * 60 * 1000;     // 5min
const KEEP_LINES      = 50;                 // linhas mantidas após truncar

// ─── Types ────────────────────────────────────────────────────────────────────

interface Cursor {
  bytes: number;
  lastCompact: string | null;  // último compact summary visto
  project: string | null;
}

interface IngestEntry {
  tipo: "compact_summary" | "assistant_response" | "file_edit";
  chave?: string;
  valor: string;
}

interface SessionMeta {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

// ─── Cursors ─────────────────────────────────────────────────────────────────

function loadCursors(): Record<string, Cursor> {
  if (!existsSync(CURSORS_FILE)) return {};
  try { return JSON.parse(readFileSync(CURSORS_FILE, "utf-8")); } catch { return {}; }
}

function saveCursors(cursors: Record<string, Cursor>): void {
  if (!existsSync(MCPX_DIR)) mkdirSync(MCPX_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CURSORS_FILE, JSON.stringify(cursors, null, 2), { mode: 0o600 });
}

// ─── Token ────────────────────────────────────────────────────────────────────

function getMemoryToken(): string | null {
  const secretsFile = join(MCPX_DIR, "secrets.json");
  if (!existsSync(secretsFile)) return null;
  try {
    // Gera token deterministico a partir do fingerprint da máquina
    // (mesmo que o proxy usa para criptografar secrets)
    const id = `${hostname()}::${platform()}::${userInfo().username}`;
    return createHash("sha256").update(id).digest("hex");
  } catch { return null; }
}

// ─── Project detection ────────────────────────────────────────────────────────

function decodeProjectFromPath(encoded: string): string {
  // "c--users-jadso-onedrive-desktop-mcp-tools" → "mcp-tools"
  // "c--users-jadso-onedrive-desktop-planner"   → "planner"
  const lower = encoded.toLowerCase();
  const marker = "-desktop-";
  const idx = lower.lastIndexOf(marker);
  if (idx >= 0) return encoded.slice(idx + marker.length);
  // fallback: toma o último segmento
  return encoded.split("-").at(-1) ?? encoded;
}

function loadSessionMeta(sessionId: string): SessionMeta | null {
  if (!existsSync(SESSIONS_DIR)) return null;
  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const raw = readFileSync(join(SESSIONS_DIR, f), "utf-8");
      const meta = JSON.parse(raw) as SessionMeta;
      if (meta.sessionId === sessionId) return meta;
    }
  } catch { /* ignora */ }
  return null;
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function detectProject(sessionId: string, projectDir: string): string | null {
  // Tenta via sessions file (tem o cwd real)
  const meta = loadSessionMeta(sessionId);
  if (meta?.cwd) {
    const parts = meta.cwd.replace(/\\/g, "/").split("/");
    const desktopIdx = parts.findIndex(p => p.toLowerCase() === "desktop");
    if (desktopIdx >= 0 && parts[desktopIdx + 1]) return parts[desktopIdx + 1].toLowerCase();
    return parts.at(-1)?.toLowerCase() ?? null;
  }
  // Fallback: decodifica do nome da pasta do projeto
  return decodeProjectFromPath(basename(projectDir));
}

// ─── Extraction ───────────────────────────────────────────────────────────────

function extractEntries(content: string): IngestEntry[] {
  const lines = content.split("\n").filter(Boolean);
  const entries: IngestEntry[] = [];

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }

    const type = entry.type as string;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const msgContent = message.content;

    // ── Compact summary ────────────────────────────────────────────────────
    if (
      type === "user" &&
      typeof msgContent === "string" &&
      msgContent.startsWith("This session is being continued")
    ) {
      entries.push({
        tipo: "compact_summary",
        chave: `compact:${createHash("sha256").update(msgContent.slice(0, 100)).digest("hex").slice(0, 8)}`,
        valor: msgContent.slice(0, 8000), // limita tamanho
      });
      continue;
    }

    if (!Array.isArray(msgContent)) continue;

    // ── Resposta final do assistente (sem tool calls) ─────────────────────
    if (type === "assistant") {
      const hasToolCall = msgContent.some((b: unknown) => (b as Record<string, unknown>).type === "tool_use");

      if (!hasToolCall) {
        const text = msgContent
          .filter((b: unknown) => (b as Record<string, unknown>).type === "text")
          .map((b: unknown) => (b as Record<string, unknown>).text as string)
          .join("\n")
          .trim();

        if (text.length > 50) {
          entries.push({
            tipo: "assistant_response",
            valor: text.slice(0, 4000),
          });
        }
        continue;
      }

      // ── Edições de arquivo ─────────────────────────────────────────────
      for (const block of msgContent as Array<Record<string, unknown>>) {
        if (block.type !== "tool_use") continue;
        const name = block.name as string;
        if (name !== "Write" && name !== "Edit" && name !== "str_replace_based_edit_tool") continue;
        const input = block.input as Record<string, unknown> | undefined;
        const filePath = input?.file_path as string | undefined;
        if (filePath) {
          entries.push({
            tipo: "file_edit",
            chave: `edit:${filePath}`,
            valor: `Arquivo editado: ${filePath}`,
          });
        }
      }
    }
  }

  return entries;
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

async function ingest(
  token: string,
  sessionId: string,
  project: string | null,
  cursorStart: number,
  cursorEnd: number,
  entries: IngestEntry[]
): Promise<boolean> {
  try {
    const res = await fetch(`${UPSTREAM}/memory/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Memory-Token": token,
      },
      body: JSON.stringify({ session_id: sessionId, project, cursor_start: cursorStart, cursor_end: cursorEnd, entries }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Truncate ─────────────────────────────────────────────────────────────────

async function truncateSession(jsonlPath: string): Promise<void> {
  try {
    const content = await readFile(jsonlPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    // Pega o último compact summary
    let lastCompact: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as Record<string, unknown>;
        const msg = entry.message as Record<string, unknown> | undefined;
        if (
          entry.type === "user" &&
          typeof msg?.content === "string" &&
          msg.content.startsWith("This session is being continued")
        ) {
          lastCompact = lines[i];
          break;
        }
      } catch { /* ignora */ }
    }

    // Mantém: marcador + último compact + últimas KEEP_LINES linhas
    const marker = JSON.stringify({ type: "truncated", at: new Date().toISOString(), lines_removed: Math.max(0, lines.length - KEEP_LINES) });
    const tail   = lines.slice(-KEEP_LINES);
    const kept   = [marker, ...(lastCompact ? [lastCompact] : []), ...tail];

    await writeFile(jsonlPath, kept.join("\n") + "\n", "utf-8");
  } catch { /* ignora erro no truncate */ }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function checkSessions(): Promise<void> {
  const token = getMemoryToken();
  if (!token) return; // memory não configurado

  if (!existsSync(PROJECTS_DIR)) return;

  const cursors = loadCursors();
  let changed = false;

  let projectDirs: string[];
  try { projectDirs = await readdir(PROJECTS_DIR); }
  catch { return; }

  for (const projectDir of projectDirs) {
    const dirPath = join(PROJECTS_DIR, projectDir);

    let files: string[];
    try { files = await readdir(dirPath); }
    catch { continue; }

    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));

    for (const jsonlFile of jsonlFiles) {
      const sessionId = jsonlFile.replace(".jsonl", "");
      const jsonlPath = join(dirPath, jsonlFile);

      let fileSize: number;
      try { fileSize = (await stat(jsonlPath)).size; }
      catch { continue; }

      const cursor = cursors[sessionId] ?? { bytes: 0, lastCompact: null, project: null };

      // Detecta projeto na primeira vez
      if (!cursor.project) {
        cursor.project = detectProject(sessionId, dirPath);
      }

      // ── Sessão ativa e arquivo grande → processa novas linhas ────────────
      if (fileSize > SIZE_THRESHOLD && fileSize > cursor.bytes) {
        try {
          // Lê apenas os bytes novos desde o cursor (máx MAX_READ_BYTES por vez)
          const readStart = cursor.bytes;
          const readEnd   = Math.min(fileSize, readStart + MAX_READ_BYTES);
          const readSize  = readEnd - readStart;
          const fh        = await open(jsonlPath, "r");
          const buf       = Buffer.alloc(readSize);
          await fh.read(buf, 0, readSize, readStart);
          await fh.close();
          const newContent = buf.toString("utf-8");
          if (!newContent.trim()) continue;

          const entries = extractEntries(newContent);
          if (entries.length > 0) {
            const ok = await ingest(token, sessionId, cursor.project, readStart, readEnd, entries);
            if (ok) {
              cursor.bytes = readEnd;
              changed = true;
            }
          } else {
            // Avança cursor mesmo sem entries extraídas (evita re-processar)
            cursor.bytes = readEnd;
            changed = true;
          }
        } catch { continue; }
      }

      // ── Sessão fechada (pid morto) → trunca ───────────────────────────
      const sessionMeta = loadSessionMeta(sessionId);
      const sessionClosed = sessionMeta ? !isPidAlive(sessionMeta.pid) : (cursor.bytes > 0 && fileSize <= cursor.bytes);

      if (sessionClosed && fileSize > 100 * 1024) { // só trunca se > 100KB
        await truncateSession(jsonlPath);
        delete cursors[sessionId];
        changed = true;
      } else {
        cursors[sessionId] = cursor;
      }
    }
  }

  if (changed) saveCursors(cursors);
}

// ─── Export ───────────────────────────────────────────────────────────────────

let watcherStarted = false;

export function startMemoryWatch(): void {
  if (watcherStarted) return;
  watcherStarted = true;

  // Roda imediatamente + a cada POLL_INTERVAL
  checkSessions().catch(() => {});
  setInterval(() => checkSessions().catch(() => {}), POLL_INTERVAL).unref();
}
