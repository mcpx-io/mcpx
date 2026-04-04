import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { resolveValue } from "./secrets.js";

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getAuth() {
  const clientId = resolveValue(process.env.GOOGLE_CLIENT_ID ?? "");
  const clientSecret = resolveValue(process.env.GOOGLE_CLIENT_SECRET ?? "");
  const refreshToken = resolveValue(process.env.GOOGLE_REFRESH_TOKEN ?? "");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "OAuth não configurado. Execute: npx @mcpx-io/apps-script@latest setup"
    );
  }

  const auth = new OAuth2Client({ clientId, clientSecret });
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

function script() {
  return google.script({ version: "v1", auth: getAuth() });
}
function drive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseScriptId(input: string): string {
  const m = input.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : input;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const mcp = new McpServer({ name: "@mcpx-io/apps-script", version: "1.0.0" });

// ── Projetos ──────────────────────────────────────────────────────────────────

mcp.registerTool("list_scripts", {
  description: "Lista projetos de Apps Script no Google Drive",
  inputSchema: { query: z.string().optional() },
}, async ({ query }) => {
  const mime = "mimeType='application/vnd.google-apps.script' and trashed=false";
  const nameFilter = query ? ` and name contains '${query}'` : "";
  const d = drive();
  const fields = "nextPageToken,files(id,name,modifiedTime,webViewLink,owners)";

  async function fetchAll(q: string): Promise<any[]> {
    const results: any[] = [];
    let pageToken: string | undefined;
    do {
      const res: any = await d.files.list({ q, pageSize: 100, fields, pageToken });
      results.push(...(res.data.files ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return results;
  }

  const [owned, shared] = await Promise.all([
    fetchAll(`${mime}${nameFilter}`),
    fetchAll(`sharedWithMe=true and ${mime}${nameFilter}`),
  ]);

  const seen = new Set<string>();
  const all = [...owned, ...shared].filter(f => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });

  return { content: [{ type: "text", text: JSON.stringify(all) }] };
});

mcp.registerTool("get_script", {
  description: "Retorna metadados de um projeto Apps Script",
  inputSchema: { script_id: z.string() },
}, async ({ script_id: _sid }) => { const script_id = parseScriptId(_sid);
  const res = await script().projects.get({ scriptId: script_id });
  return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
});

mcp.registerTool("create_script", {
  description: "Cria um novo projeto Apps Script (opcionalmente vinculado a uma planilha)",
  inputSchema: { title: z.string(), parent_id: z.string().optional() },
}, async ({ title, parent_id }) => {
  const res = await script().projects.create({ requestBody: { title, parentId: parent_id } });
  return { content: [{ type: "text", text: JSON.stringify({ script_id: res.data.scriptId, title: res.data.title }) }] };
});

// ── Arquivos (código-fonte) ───────────────────────────────────────────────────

mcp.registerTool("get_script_files", {
  description: "Lista arquivos de um projeto Apps Script. names_only=true retorna só nomes/tipos (sem código-fonte).",
  inputSchema: { script_id: z.string(), names_only: z.string().optional() },
}, async ({ script_id: _sid, names_only }) => { const script_id = parseScriptId(_sid);
  const onlyNames = names_only === "true" || names_only === true as any;
  const res = await script().projects.getContent({ scriptId: script_id });
  const files = res.data.files ?? [];
  const result = onlyNames
    ? files.map((f: any) => ({ name: f.name, type: f.type }))
    : files.map((f: any) => ({ name: f.name, type: f.type, source: f.source }));
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

mcp.registerTool("update_script_files", {
  description: "Atualiza os arquivos de código de um projeto (substitui todo o conteúdo)",
  inputSchema: {
    script_id: z.string(),
    files: z.array(z.object({
      name: z.string(),
      type: z.enum(["SERVER_JS", "HTML", "JSON"]),
      source: z.string(),
    })),
  },
}, async ({ script_id: _sid, files }) => { const script_id = parseScriptId(_sid);
  const res = await script().projects.updateContent({ scriptId: script_id, requestBody: { files } });
  return { content: [{ type: "text", text: JSON.stringify({ updated: res.data.files?.length ?? 0, files: res.data.files?.map(f => f.name) }) }] };
});

mcp.registerTool("get_file_source", {
  description: "Retorna o código-fonte de um arquivo específico do projeto",
  inputSchema: { script_id: z.string(), file_name: z.string() },
}, async ({ script_id: _sid, file_name }) => { const script_id = parseScriptId(_sid);
  const res = await script().projects.getContent({ scriptId: script_id });
  const file = res.data.files?.find(f => f.name === file_name);
  if (!file) throw new Error(`Arquivo '${file_name}' não encontrado.`);
  return { content: [{ type: "text", text: file.source ?? "" }] };
});

// ── Versões ───────────────────────────────────────────────────────────────────

mcp.registerTool("list_versions", {
  description: "Lista as versões de um projeto Apps Script",
  inputSchema: { script_id: z.string() },
}, async ({ script_id: _sid }) => { const script_id = parseScriptId(_sid);
  const res = await script().projects.versions.list({ scriptId: script_id });
  return { content: [{ type: "text", text: JSON.stringify(res.data.versions ?? []) }] };
});

mcp.registerTool("create_version", {
  description: "Cria uma nova versão imutável do projeto (necessário para deployments)",
  inputSchema: { script_id: z.string(), description: z.string().optional() },
}, async ({ script_id: _sid, description }) => { const script_id = parseScriptId(_sid);
  const res = await script().projects.versions.create({ scriptId: script_id, requestBody: { description } });
  return { content: [{ type: "text", text: JSON.stringify({ version_number: res.data.versionNumber, description: res.data.description, create_time: res.data.createTime }) }] };
});

// ── Deployments ───────────────────────────────────────────────────────────────

mcp.registerTool("list_deployments", {
  description: "Lista os deployments de um projeto Apps Script",
  inputSchema: { script_id: z.string() },
}, async ({ script_id: _sid }) => { const script_id = parseScriptId(_sid);
  const res = await script().projects.deployments.list({ scriptId: script_id });
  return { content: [{ type: "text", text: JSON.stringify(res.data.deployments ?? []) }] };
});

mcp.registerTool("create_deployment", {
  description: "Cria um novo deployment (web app ou API executable)",
  inputSchema: {
    script_id: z.string(),
    version_number: z.coerce.number(),
    description: z.string().optional(),
    access: z.enum(["MYSELF", "DOMAIN", "ANYONE", "ANYONE_ANONYMOUS"]).optional(),
  },
}, async ({ script_id: _sid, version_number, description, access = "ANYONE" }) => { const script_id = parseScriptId(_sid);
  const res = await script().projects.deployments.create({
    scriptId: script_id,
    requestBody: {
      versionNumber: version_number,
      description,
      manifestFileName: "appsscript",
    },
  });
  return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
});

mcp.registerTool("update_deployment", {
  description: "Atualiza um deployment existente para uma nova versão",
  inputSchema: { script_id: z.string(), deployment_id: z.string(), version_number: z.coerce.number(), description: z.string().optional() },
}, async ({ script_id: _sid, deployment_id, version_number, description }) => { const script_id = parseScriptId(_sid);
  const res = await script().projects.deployments.update({
    scriptId: script_id,
    deploymentId: deployment_id,
    requestBody: { deploymentConfig: { versionNumber: version_number, description, manifestFileName: "appsscript" } },
  });
  return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
});

mcp.registerTool("delete_deployment", {
  description: "Remove um deployment de um projeto Apps Script",
  inputSchema: { script_id: z.string(), deployment_id: z.string() },
}, async ({ script_id: _sid, deployment_id }) => { const script_id = parseScriptId(_sid);
  await script().projects.deployments.delete({ scriptId: script_id, deploymentId: deployment_id });
  return { content: [{ type: "text", text: `Deployment '${deployment_id}' removido.` }] };
});

// ── Execução de Funções ───────────────────────────────────────────────────────

mcp.registerTool("run_function", {
  description: "Executa uma função de um projeto Apps Script remotamente. O script deve ter um deployment do tipo API_EXECUTABLE. Retorna o resultado da função.",
  inputSchema: {
    script_id: z.string(),
    function_name: z.string(),
    parameters: z.array(z.any()).optional(),
    dev_mode: z.string().optional(),
  },
}, async ({ script_id: _sid, function_name, parameters, dev_mode }) => { const script_id = parseScriptId(_sid);
  const res = await script().scripts.run({
    scriptId: script_id,
    requestBody: {
      function: function_name,
      parameters: parameters ?? [],
      devMode: dev_mode === "true",
    },
  });
  const response = res.data.response;
  const error = res.data.error;
  if (error) {
    return { content: [{ type: "text", text: JSON.stringify({ error: error.message, details: error.details }) }] };
  }
  return { content: [{ type: "text", text: JSON.stringify({ result: response?.result ?? null, done: res.data.done }) }] };
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (process.argv[2] === "setup") {
  require("./setup-oauth.js");
} else {
  async function main() {
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
  }
  main().catch(console.error);
}
