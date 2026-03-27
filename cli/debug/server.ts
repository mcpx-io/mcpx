import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve, extname } from "path";
import { config } from "dotenv";

// ─── Project auto-detect ─────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();

config({ path: resolve(PROJECT_ROOT, ".env") });
if (existsSync(resolve(PROJECT_ROOT, ".env.local"))) {
  config({ path: resolve(PROJECT_ROOT, ".env.local"), override: false });
}

// ─── Browser state ───────────────────────────────────────────────────────────

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

const consoleLogs: { type: string; text: string; time: string }[] = [];
const networkRequests: { method: string; url: string; status: number; duration: number; requestBody?: string; responseBody?: string; time: string }[] = [];

async function getPage(): Promise<Page> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    // Capture console logs
    page.on("console", (msg) => {
      consoleLogs.push({ type: msg.type(), text: msg.text(), time: new Date().toISOString() });
      if (consoleLogs.length > 500) consoleLogs.shift();
    });

    // Capture network requests + response body
    const requestTimes = new Map<string, { start: number; body?: string }>();

    page.on("request", (req) => {
      requestTimes.set(req.url(), {
        start: Date.now(),
        body: req.postData() ?? undefined,
      });
    });

    page.on("response", async (res) => {
      const info = requestTimes.get(res.url());
      const duration = info ? Date.now() - info.start : 0;
      let responseBody: string | undefined;
      const ct = res.headers()["content-type"] ?? "";
      if (ct.includes("json") || ct.includes("text")) {
        try { responseBody = await res.text(); } catch { /* ignore */ }
      }
      networkRequests.push({
        method: res.request().method(),
        url: res.url(),
        status: res.status(),
        duration,
        requestBody: info?.body,
        responseBody,
        time: new Date().toISOString(),
      });
      requestTimes.delete(res.url());
      if (networkRequests.length > 200) networkRequests.shift();
    });
  }

  if (!page || page.isClosed()) {
    page = await context!.newPage();
  }
  return page;
}

// ─── Route parsing ───────────────────────────────────────────────────────────

function parseRoutesFromContent(content: string, fileName: string): string[] {
  const routes: string[] = [];
  const patterns = [
    // Express / Fastify / Hono: app.get('/path') | router.post('/path')
    /(?:app|router|fastify|server|hono)\.(get|post|put|delete|patch|head|options)\s*\(\s*['"`](\/[^'"`]*)/gi,
    // NestJS decorators: @Get('/path') @Post('/path')
    /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`](\/[^'"`]*)/gi,
  ];

  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const method = match[1].toUpperCase().padEnd(6);
      const path = match[2];
      const entry = `${method} ${path}`;
      if (!routes.includes(entry)) routes.push(entry);
    }
  }

  return routes;
}

// ─── JWT decode ──────────────────────────────────────────────────────────────

function decodeJwt(token: string): { header: unknown; payload: unknown; exp?: string } | null {
  try {
    const parts = token.replace(/^Bearer\s+/i, "").split(".");
    if (parts.length !== 3) return null;
    const decode = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf-8"));
    const header = decode(parts[0]);
    const payload = decode(parts[1]) as Record<string, unknown>;
    const exp = payload.exp ? new Date(Number(payload.exp) * 1000).toISOString() : undefined;
    return { header, payload, exp };
  } catch {
    return null;
  }
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({ name: "@mcpx/debug", version: "1.0.0" });

// ══ PROJECT ══════════════════════════════════════════════════════════════════

server.registerTool("read_env", {
  description: "Lista as variáveis de ambiente do projeto (.env), mascarando valores sensíveis",
  inputSchema: {
    show_values: z.boolean().optional().default(false).describe("Mostrar valores reais (padrão: false — mascara senhas)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ show_values }) => {
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (!existsSync(envPath))
    return { content: [{ type: "text", text: `Arquivo .env não encontrado em: ${PROJECT_ROOT}` }], isError: true };

  const lines = readFileSync(envPath, "utf-8").split("\n").filter(l => l.trim() && !l.startsWith("#"));
  const sensitiveKeys = /password|secret|key|token|auth|credential|private/i;

  const output = lines.map(line => {
    const [key, ...rest] = line.split("=");
    const value = rest.join("=");
    if (!show_values && sensitiveKeys.test(key)) return `${key}=****`;
    return `${key}=${value}`;
  });

  return { content: [{ type: "text", text: `=== .env — ${PROJECT_ROOT} ===\n${output.join("\n")}` }] };
});

server.registerTool("parse_routes", {
  description: "Extrai rotas de arquivos do projeto (routes.ts, api.ts, app.ts, etc.)",
  inputSchema: {
    files: z.array(z.string()).optional().describe("Caminhos dos arquivos (relativos à raiz ou absolutos). Se omitido, detecta automaticamente."),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ files }) => {
  const candidates = files ?? ["server/routes.ts", "server/api.ts", "server/app.ts",
    "src/routes.ts", "src/api.ts", "src/app.ts", "routes.ts", "api.ts", "app.ts",
    "server/routes.js", "src/routes.js", "routes.js"];

  const results: string[] = [];

  for (const f of candidates) {
    const filePath = resolve(PROJECT_ROOT, f);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf-8");
    const routes = parseRoutesFromContent(content, f);
    if (routes.length > 0) {
      results.push(`=== ${f} (${routes.length} rotas) ===`);
      results.push(...routes);
      results.push("");
    }
  }

  if (results.length === 0)
    return { content: [{ type: "text", text: "Nenhuma rota encontrada. Passe os caminhos manualmente via `files`." }] };

  return { content: [{ type: "text", text: results.join("\n") }] };
});

server.registerTool("list_project_files", {
  description: "Lista a estrutura de arquivos do projeto (exclui node_modules, .git, dist)",
  inputSchema: {
    depth: z.number().int().min(1).max(5).optional().default(3).describe("Profundidade máxima (padrão 3)"),
    path: z.string().optional().describe("Subpasta relativa à raiz (opcional)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ depth, path: subPath }) => {
  const IGNORE = new Set(["node_modules", ".git", "dist", ".next", "build", ".cache", "coverage"]);

  function walk(dir: string, currentDepth: number, prefix = ""): string[] {
    if (currentDepth > depth) return [];
    let entries: string[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }

    const lines: string[] = [];
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      lines.push(`${prefix}${entry.isDirectory() ? "📁" : "📄"} ${entry.name}`);
      if (entry.isDirectory()) {
        lines.push(...walk(join(dir, entry.name), currentDepth + 1, prefix + "  "));
      }
    }
    return lines;
  }

  const rootPath = subPath ? resolve(PROJECT_ROOT, subPath) : PROJECT_ROOT;
  const lines = walk(rootPath, 1);
  return { content: [{ type: "text", text: `=== ${rootPath} ===\n${lines.join("\n")}` }] };
});

// ══ HTTP ══════════════════════════════════════════════════════════════════════

server.registerTool("http_request", {
  description: "Faz uma requisição HTTP para qualquer URL. Suporta auth, headers, body, timeout e gera curl equivalente.",
  inputSchema: {
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]).describe("Método HTTP"),
    url: z.string().describe("URL completa"),
    headers: z.record(z.string()).optional().describe("Headers customizados"),
    body: z.string().optional().describe("Body (JSON string, texto, etc.)"),
    bearer_token: z.string().optional().describe("JWT Bearer token"),
    basic_auth: z.string().optional().describe("Basic auth no formato user:password"),
    timeout_ms: z.number().int().min(100).max(60000).optional().default(10000).describe("Timeout em ms (padrão 10s)"),
    follow_redirects: z.boolean().optional().default(true).describe("Seguir redirects (padrão true)"),
    generate_curl: z.boolean().optional().default(false).describe("Incluir comando curl equivalente na resposta"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ method, url, headers, body, bearer_token, basic_auth, timeout_ms, follow_redirects, generate_curl }) => {
  const reqHeaders: Record<string, string> = { "Content-Type": "application/json" };

  if (headers) Object.assign(reqHeaders, headers);
  if (bearer_token) reqHeaders["Authorization"] = `Bearer ${bearer_token}`;
  if (basic_auth) reqHeaders["Authorization"] = `Basic ${Buffer.from(basic_auth).toString("base64")}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeout_ms);

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: reqHeaders,
      body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
      signal: controller.signal,
      redirect: follow_redirects ? "follow" : "manual",
    });
    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    const resText = await res.text();
    let resParsed: unknown;
    try { resParsed = JSON.parse(resText); } catch { resParsed = resText; }

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });

    const lines = [
      `${method} ${url}`,
      `Status: ${res.status} ${res.statusText} (${elapsed}ms)`,
      `Content-Type: ${resHeaders["content-type"] ?? "—"}`,
      ``,
      `Response:`,
      typeof resParsed === "string" ? resParsed : JSON.stringify(resParsed, null, 2),
    ];

    if (generate_curl) {
      const hFlags = Object.entries(reqHeaders).map(([k, v]) => `-H "${k}: ${v}"`).join(" ");
      const bFlag = body && method !== "GET" ? `-d '${body}'` : "";
      lines.push(``, `curl -X ${method} "${url}" ${hFlags} ${bFlag}`.trim());
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? (err.name === "AbortError" ? `Timeout após ${timeout_ms}ms` : err.message) : String(err);
    return { content: [{ type: "text", text: `Erro: ${msg}` }], isError: true };
  }
});

server.registerTool("http_batch", {
  description: "Executa vários requests HTTP em paralelo e retorna todos os resultados",
  inputSchema: {
    requests: z.array(z.object({
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
      url: z.string(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
      bearer_token: z.string().optional(),
      label: z.string().optional().describe("Nome para identificar este request nos resultados"),
    })).describe("Lista de requests a executar"),
    timeout_ms: z.number().int().optional().default(10000),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ requests, timeout_ms }) => {
  const results = await Promise.all(requests.map(async (r) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...r.headers };
    if (r.bearer_token) headers["Authorization"] = `Bearer ${r.bearer_token}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout_ms);
    const start = Date.now();
    try {
      const res = await fetch(r.url, {
        method: r.method,
        headers,
        body: r.body && r.method !== "GET" ? r.body : undefined,
        signal: controller.signal,
      });
      clearTimeout(t);
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return `[${r.label ?? r.url}] ${res.status} (${Date.now() - start}ms)\n${typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}`;
    } catch (err) {
      clearTimeout(t);
      return `[${r.label ?? r.url}] ERRO: ${err instanceof Error ? err.message : String(err)}`;
    }
  }));

  return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
});

server.registerTool("http_poll", {
  description: "Repete um request até receber o status esperado ou timeout",
  inputSchema: {
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
    url: z.string(),
    expected_status: z.number().int().optional().default(200),
    headers: z.record(z.string()).optional(),
    bearer_token: z.string().optional(),
    interval_ms: z.number().int().optional().default(2000).describe("Intervalo entre tentativas (padrão 2s)"),
    max_attempts: z.number().int().min(1).max(30).optional().default(10),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ method, url, expected_status, headers, bearer_token, interval_ms, max_attempts }) => {
  const reqHeaders: Record<string, string> = { "Content-Type": "application/json", ...headers };
  if (bearer_token) reqHeaders["Authorization"] = `Bearer ${bearer_token}`;

  for (let i = 1; i <= max_attempts; i++) {
    try {
      const res = await fetch(url, { method, headers: reqHeaders });
      const text = await res.text();
      if (res.status === expected_status) {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        return { content: [{ type: "text", text: `✓ Status ${res.status} na tentativa ${i}/${max_attempts}\n\n${typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}` }] };
      }
    } catch { /* continua */ }
    if (i < max_attempts) await new Promise(r => setTimeout(r, interval_ms));
  }

  return { content: [{ type: "text", text: `Timeout: status ${expected_status} não recebido após ${max_attempts} tentativas` }], isError: true };
});

server.registerTool("decode_jwt", {
  description: "Decodifica um JWT token e mostra header, payload e expiração",
  inputSchema: {
    token: z.string().describe("JWT token (com ou sem 'Bearer ')"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ token }) => {
  const decoded = decodeJwt(token);
  if (!decoded)
    return { content: [{ type: "text", text: "Token inválido ou não é um JWT." }], isError: true };

  const now = Date.now() / 1000;
  const payload = decoded.payload as Record<string, unknown>;
  const expired = payload.exp ? Number(payload.exp) < now : false;

  const lines = [
    `=== JWT ===`,
    `Header:  ${JSON.stringify(decoded.header, null, 2)}`,
    `Payload: ${JSON.stringify(decoded.payload, null, 2)}`,
    decoded.exp ? `Expira:  ${decoded.exp} ${expired ? "⚠️ EXPIRADO" : "✓ válido"}` : `Expira:  sem expiração`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.registerTool("diff_response", {
  description: "Compara a resposta de dois endpoints (ex: staging vs prod)",
  inputSchema: {
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
    url_a: z.string().describe("URL A (ex: staging)"),
    url_b: z.string().describe("URL B (ex: produção)"),
    headers: z.record(z.string()).optional(),
    bearer_token: z.string().optional(),
    body: z.string().optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ method, url_a, url_b, headers, bearer_token, body }) => {
  const reqHeaders: Record<string, string> = { "Content-Type": "application/json", ...headers };
  if (bearer_token) reqHeaders["Authorization"] = `Bearer ${bearer_token}`;
  const opts: RequestInit = { method, headers: reqHeaders, body: body && method !== "GET" ? body : undefined };

  const [resA, resB] = await Promise.all([fetch(url_a, opts), fetch(url_b, opts)]);
  const [textA, textB] = await Promise.all([resA.text(), resB.text()]);

  const parseJ = (t: string) => { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; } };
  const bodyA = parseJ(textA);
  const bodyB = parseJ(textB);

  const statusMatch = resA.status === resB.status ? "✓ mesmo status" : `⚠️ status diferente`;
  const bodyMatch = bodyA === bodyB ? "✓ resposta idêntica" : "⚠️ respostas diferentes";

  return {
    content: [{
      type: "text",
      text: [
        `=== A: ${url_a} === Status: ${resA.status}`,
        bodyA,
        ``,
        `=== B: ${url_b} === Status: ${resB.status}`,
        bodyB,
        ``,
        `--- Resultado ---`,
        statusMatch,
        bodyMatch,
      ].join("\n"),
    }],
  };
});

// ══ BROWSER ══════════════════════════════════════════════════════════════════

server.registerTool("browser_navigate", {
  description: "Navega para uma URL no browser headless. Limpa logs de console e rede.",
  inputSchema: {
    url: z.string().describe("URL para navegar"),
    wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).optional().default("networkidle"),
    timeout_ms: z.number().int().optional().default(30000),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ url, wait_until, timeout_ms }) => {
  try {
    consoleLogs.length = 0;
    networkRequests.length = 0;
    const p = await getPage();
    const res = await p.goto(url, { waitUntil: wait_until, timeout: timeout_ms });
    const title = await p.title();
    return { content: [{ type: "text", text: `Navegou: ${url}\nTítulo: ${title}\nStatus: ${res?.status()}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_screenshot", {
  description: "Tira screenshot da página atual ou de um elemento específico",
  inputSchema: {
    selector: z.string().optional().describe("Seletor CSS (opcional — screenshot da página inteira se omitido)"),
    full_page: z.boolean().optional().default(false).describe("Screenshot da página inteira (padrão false)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ selector, full_page }) => {
  try {
    const p = await getPage();
    const screenshot = selector
      ? await p.locator(selector).first().screenshot()
      : await p.screenshot({ fullPage: full_page });
    return { content: [{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_click", {
  description: "Clica em um elemento da página",
  inputSchema: {
    selector: z.string().describe("Seletor CSS ou texto visível do elemento"),
    wait_after_ms: z.number().int().optional().default(500).describe("Aguardar após clicar (ms)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ selector, wait_after_ms }) => {
  try {
    const p = await getPage();
    await p.locator(selector).first().click();
    if (wait_after_ms > 0) await p.waitForTimeout(wait_after_ms);
    const url = p.url();
    return { content: [{ type: "text", text: `Clicou em: ${selector}\nURL atual: ${url}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_fill", {
  description: "Preenche um campo de input na página",
  inputSchema: {
    selector: z.string().describe("Seletor CSS do input"),
    value: z.string().describe("Valor a preencher"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ selector, value }) => {
  try {
    const p = await getPage();
    await p.locator(selector).first().fill(value);
    return { content: [{ type: "text", text: `Preencheu "${selector}" com: ${value}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_select", {
  description: "Seleciona uma opção em um elemento <select>",
  inputSchema: {
    selector: z.string().describe("Seletor CSS do select"),
    value: z.string().describe("Valor ou texto da opção"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ selector, value }) => {
  try {
    const p = await getPage();
    await p.locator(selector).first().selectOption({ value });
    return { content: [{ type: "text", text: `Selecionou "${value}" em: ${selector}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_hover", {
  description: "Passa o mouse sobre um elemento (hover)",
  inputSchema: {
    selector: z.string().describe("Seletor CSS do elemento"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ selector }) => {
  try {
    const p = await getPage();
    await p.locator(selector).first().hover();
    return { content: [{ type: "text", text: `Hover em: ${selector}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_keyboard", {
  description: "Pressiona uma tecla ou atalho de teclado",
  inputSchema: {
    key: z.string().describe("Tecla ou atalho (ex: Enter, Tab, Escape, Control+A, ArrowDown)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ key }) => {
  try {
    const p = await getPage();
    await p.keyboard.press(key);
    return { content: [{ type: "text", text: `Pressionou: ${key}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_scroll", {
  description: "Faz scroll na página",
  inputSchema: {
    x: z.number().optional().default(0).describe("Scroll horizontal em pixels"),
    y: z.number().optional().default(500).describe("Scroll vertical em pixels (positivo = para baixo)"),
    selector: z.string().optional().describe("Rolar até um elemento específico (opcional)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ x, y, selector }) => {
  try {
    const p = await getPage();
    if (selector) {
      await p.locator(selector).first().scrollIntoViewIfNeeded();
      return { content: [{ type: "text", text: `Rolou até: ${selector}` }] };
    }
    await p.mouse.wheel(x, y);
    return { content: [{ type: "text", text: `Rolou: x=${x}, y=${y}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_get_text", {
  description: "Extrai o texto visível da página ou de um elemento",
  inputSchema: {
    selector: z.string().optional().describe("Seletor CSS (opcional — texto da página toda se omitido)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ selector }) => {
  try {
    const p = await getPage();
    const text = selector
      ? await p.locator(selector).first().innerText()
      : await p.evaluate(() => document.body.innerText);
    return { content: [{ type: "text", text: text.trim() }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_get_html", {
  description: "Retorna o HTML de um elemento ou da página",
  inputSchema: {
    selector: z.string().optional().describe("Seletor CSS (opcional)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ selector }) => {
  try {
    const p = await getPage();
    const html = selector
      ? await p.locator(selector).first().innerHTML()
      : await p.content();
    return { content: [{ type: "text", text: html }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_eval", {
  description: "Executa JavaScript na página e retorna o resultado",
  inputSchema: {
    script: z.string().describe("Código JavaScript a executar (ex: document.title, window.location.href)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ script }) => {
  try {
    const p = await getPage();
    const result = await p.evaluate(script);
    return { content: [{ type: "text", text: typeof result === "object" ? JSON.stringify(result, null, 2) : String(result ?? "undefined") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_wait_for", {
  description: "Aguarda um elemento aparecer, URL mudar ou rede ficar idle",
  inputSchema: {
    type: z.enum(["selector", "url", "networkidle", "timeout"]).describe("Tipo de espera"),
    value: z.string().optional().describe("Seletor CSS ou URL esperada (para tipo selector/url)"),
    timeout_ms: z.number().int().optional().default(10000),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ type, value, timeout_ms }) => {
  try {
    const p = await getPage();
    if (type === "selector" && value) {
      await p.waitForSelector(value, { timeout: timeout_ms });
      return { content: [{ type: "text", text: `Elemento "${value}" encontrado.` }] };
    }
    if (type === "url" && value) {
      await p.waitForURL(value, { timeout: timeout_ms });
      return { content: [{ type: "text", text: `URL mudou para: ${p.url()}` }] };
    }
    if (type === "networkidle") {
      await p.waitForLoadState("networkidle", { timeout: timeout_ms });
      return { content: [{ type: "text", text: `Rede idle. URL: ${p.url()}` }] };
    }
    if (type === "timeout" && value) {
      await p.waitForTimeout(parseInt(value));
      return { content: [{ type: "text", text: `Aguardou ${value}ms` }] };
    }
    return { content: [{ type: "text", text: "Parâmetros inválidos." }], isError: true };
  } catch (err) {
    return { content: [{ type: "text", text: `Timeout ou erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_console_logs", {
  description: "Retorna os logs capturados do console do browser (errors, warnings, logs)",
  inputSchema: {
    type: z.enum(["all", "error", "warning", "log", "info"]).optional().default("all").describe("Filtrar por tipo"),
    limit: z.number().int().min(1).max(200).optional().default(50),
    clear: z.boolean().optional().default(false).describe("Limpar logs após retornar"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ type, limit, clear }) => {
  const filtered = type === "all"
    ? consoleLogs
    : consoleLogs.filter(l => l.type === type);

  const recent = filtered.slice(-limit);

  if (recent.length === 0)
    return { content: [{ type: "text", text: "Nenhum log capturado. Navegue para uma página primeiro." }] };

  const lines = recent.map(l => `[${l.time}] [${l.type.toUpperCase()}] ${l.text}`);

  if (clear) consoleLogs.length = 0;

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.registerTool("browser_network_requests", {
  description: "Retorna os requests de rede capturados (XHR, fetch, etc.)",
  inputSchema: {
    filter_url: z.string().optional().describe("Filtrar por URL (substring)"),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "ALL"]).optional().default("ALL"),
    status: z.number().int().optional().describe("Filtrar por status HTTP"),
    limit: z.number().int().min(1).max(100).optional().default(30),
    include_body: z.boolean().optional().default(false).describe("Incluir request/response body"),
    clear: z.boolean().optional().default(false).describe("Limpar lista após retornar"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ filter_url, method, status, limit, include_body, clear }) => {
  let filtered = [...networkRequests];

  if (filter_url) filtered = filtered.filter(r => r.url.includes(filter_url));
  if (method !== "ALL") filtered = filtered.filter(r => r.method === method);
  if (status) filtered = filtered.filter(r => r.status === status);

  const recent = filtered.slice(-limit);

  if (recent.length === 0)
    return { content: [{ type: "text", text: "Nenhum request capturado. Navegue para uma página primeiro." }] };

  const lines = recent.map(r => {
    const statusIcon = r.status >= 400 ? "❌" : r.status >= 300 ? "↩️" : "✓";
    const line = `${statusIcon} ${r.method.padEnd(6)} ${r.status} (${r.duration}ms) ${r.url}`;
    if (!include_body) return line;
    const parts = [line];
    if (r.requestBody) parts.push(`  → Body: ${r.requestBody.slice(0, 200)}`);
    if (r.responseBody) parts.push(`  ← Response: ${r.responseBody.slice(0, 200)}`);
    return parts.join("\n");
  });

  if (clear) networkRequests.length = 0;

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.registerTool("browser_cookies", {
  description: "Lê ou define cookies da sessão do browser",
  inputSchema: {
    action: z.enum(["get", "set", "clear"]).describe("get = listar, set = criar/atualizar, clear = apagar todos"),
    name: z.string().optional().describe("Nome do cookie (para set)"),
    value: z.string().optional().describe("Valor do cookie (para set)"),
    url: z.string().optional().describe("URL para escopo do cookie (para set/get)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ action, name, value, url }) => {
  try {
    const p = await getPage();
    if (action === "get") {
      const cookies = await context!.cookies(url);
      if (cookies.length === 0) return { content: [{ type: "text", text: "Nenhum cookie." }] };
      const lines = cookies.map(c => `${c.name}=${c.value} (domain: ${c.domain})`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    if (action === "set" && name && value && url) {
      await context!.addCookies([{ name, value, url }]);
      return { content: [{ type: "text", text: `Cookie definido: ${name}=${value}` }] };
    }
    if (action === "clear") {
      await context!.clearCookies();
      return { content: [{ type: "text", text: "Cookies limpos." }] };
    }
    return { content: [{ type: "text", text: "Parâmetros inválidos." }], isError: true };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_local_storage", {
  description: "Lê ou escreve no localStorage da página",
  inputSchema: {
    action: z.enum(["get", "set", "remove", "clear"]),
    key: z.string().optional().describe("Chave (para get/set/remove)"),
    value: z.string().optional().describe("Valor (para set)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ action, key, value }) => {
  try {
    const p = await getPage();
    if (action === "get") {
      const result = key
        ? await p.evaluate((k) => localStorage.getItem(k), key)
        : await p.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage)), null, 2));
      return { content: [{ type: "text", text: String(result ?? "null") }] };
    }
    if (action === "set" && key && value !== undefined) {
      await p.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value]);
      return { content: [{ type: "text", text: `localStorage["${key}"] = ${value}` }] };
    }
    if (action === "remove" && key) {
      await p.evaluate((k) => localStorage.removeItem(k), key);
      return { content: [{ type: "text", text: `Removeu localStorage["${key}"]` }] };
    }
    if (action === "clear") {
      await p.evaluate(() => localStorage.clear());
      return { content: [{ type: "text", text: "localStorage limpo." }] };
    }
    return { content: [{ type: "text", text: "Parâmetros inválidos." }], isError: true };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.registerTool("browser_close", {
  description: "Fecha o browser e libera todos os recursos",
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async () => {
  try {
    if (page && !page.isClosed()) await page.close();
    if (context) await context.close();
    if (browser && browser.isConnected()) await browser.close();
    page = null; context = null; browser = null;
    consoleLogs.length = 0;
    networkRequests.length = 0;
    return { content: [{ type: "text", text: "Browser fechado e recursos liberados." }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
