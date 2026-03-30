import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { google } from "googleapis";
import { JWT } from "google-auth-library";
import { resolveValue } from "./secrets.js";

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getAuth() {
  const raw = resolveValue(process.env.GOOGLE_SERVICE_ACCOUNT ?? "");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT não definido. Use: mcpx secrets set google_sa");
  const key = JSON.parse(raw);
  return new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [
      "https://www.googleapis.com/auth/script.projects",
      "https://www.googleapis.com/auth/script.deployments",
      "https://www.googleapis.com/auth/drive",
    ],
  });
}

function script() {
  return google.script({ version: "v1", auth: getAuth() });
}
function drive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const mcp = new McpServer({ name: "@mcpx-io/apps-script", version: "1.0.0" });

// ── Projetos ──────────────────────────────────────────────────────────────────

mcp.registerTool("list_scripts", {
  description: "Lista projetos de Apps Script no Google Drive",
  inputSchema: { page_size: z.number().optional(), query: z.string().optional() },
}, async ({ page_size = 20, query }) => {
  let q = "mimeType='application/vnd.google-apps.script'";
  if (query) q += ` and name contains '${query}'`;
  const res = await drive().files.list({ q, pageSize: page_size, fields: "files(id,name,modifiedTime,webViewLink)" });
  return { content: [{ type: "text", text: JSON.stringify(res.data.files ?? []) }] };
});

mcp.registerTool("get_script", {
  description: "Retorna metadados de um projeto Apps Script",
  inputSchema: { script_id: z.string() },
}, async ({ script_id }) => {
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
  description: "Retorna todos os arquivos de código de um projeto Apps Script",
  inputSchema: { script_id: z.string() },
}, async ({ script_id }) => {
  const res = await script().projects.getContent({ scriptId: script_id });
  return { content: [{ type: "text", text: JSON.stringify(res.data.files?.map(f => ({ name: f.name, type: f.type, source: f.source })) ?? []) }] };
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
}, async ({ script_id, files }) => {
  const res = await script().projects.updateContent({ scriptId: script_id, requestBody: { files } });
  return { content: [{ type: "text", text: JSON.stringify({ updated: res.data.files?.length ?? 0, files: res.data.files?.map(f => f.name) }) }] };
});

mcp.registerTool("get_file_source", {
  description: "Retorna o código-fonte de um arquivo específico do projeto",
  inputSchema: { script_id: z.string(), file_name: z.string() },
}, async ({ script_id, file_name }) => {
  const res = await script().projects.getContent({ scriptId: script_id });
  const file = res.data.files?.find(f => f.name === file_name);
  if (!file) throw new Error(`Arquivo '${file_name}' não encontrado.`);
  return { content: [{ type: "text", text: file.source ?? "" }] };
});

// ── Versões ───────────────────────────────────────────────────────────────────

mcp.registerTool("list_versions", {
  description: "Lista as versões de um projeto Apps Script",
  inputSchema: { script_id: z.string() },
}, async ({ script_id }) => {
  const res = await script().projects.versions.list({ scriptId: script_id });
  return { content: [{ type: "text", text: JSON.stringify(res.data.versions ?? []) }] };
});

mcp.registerTool("create_version", {
  description: "Cria uma nova versão imutável do projeto (necessário para deployments)",
  inputSchema: { script_id: z.string(), description: z.string().optional() },
}, async ({ script_id, description }) => {
  const res = await script().projects.versions.create({ scriptId: script_id, requestBody: { description } });
  return { content: [{ type: "text", text: JSON.stringify({ version_number: res.data.versionNumber, description: res.data.description, create_time: res.data.createTime }) }] };
});

// ── Deployments ───────────────────────────────────────────────────────────────

mcp.registerTool("list_deployments", {
  description: "Lista os deployments de um projeto Apps Script",
  inputSchema: { script_id: z.string() },
}, async ({ script_id }) => {
  const res = await script().projects.deployments.list({ scriptId: script_id });
  return { content: [{ type: "text", text: JSON.stringify(res.data.deployments ?? []) }] };
});

mcp.registerTool("create_deployment", {
  description: "Cria um novo deployment (web app ou API executable)",
  inputSchema: {
    script_id: z.string(),
    version_number: z.number(),
    description: z.string().optional(),
    access: z.enum(["MYSELF", "DOMAIN", "ANYONE", "ANYONE_ANONYMOUS"]).optional(),
  },
}, async ({ script_id, version_number, description, access = "ANYONE" }) => {
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
  inputSchema: { script_id: z.string(), deployment_id: z.string(), version_number: z.number(), description: z.string().optional() },
}, async ({ script_id, deployment_id, version_number, description }) => {
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
}, async ({ script_id, deployment_id }) => {
  await script().projects.deployments.delete({ scriptId: script_id, deploymentId: deployment_id });
  return { content: [{ type: "text", text: `Deployment '${deployment_id}' removido.` }] };
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch(console.error);
