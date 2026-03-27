export type McpType = "remote" | "local";

export interface McpDefinition {
  key: string;
  name: string;
  description: string;
  type: McpType;
  package?: string;           // npm package (local CLIs)
  url?: string;               // URL base (remote MCPs)
  headers?: Record<string, string>;
  inputs?: McpInput[];        // campos que o usuário precisa preencher
}

export interface McpInput {
  key: string;
  label: string;
  placeholder: string;
  header?: string;            // se for virar header no .mcp.json
  env?: string;               // se for virar env var
}

export const MCPS: McpDefinition[] = [
  {
    key: "postgres",
    name: "mcpx-postgres",
    description: "Banco de dados PostgreSQL — query, DDL, DML, vacuum e mais",
    type: "remote",
    url: "https://mcpx.online/mcp",
    headers: { Accept: "application/json, text/event-stream" },
    inputs: [
      {
        key: "database_url",
        label: "Connection string do banco PostgreSQL",
        placeholder: "postgresql://user:pass@host:5432/dbname",
        header: "X-Database-URL",
      },
    ],
  },
  {
    key: "debug",
    name: "mcpx-debug",
    description: "Debug local — browser automation, HTTP requests, parse de rotas",
    type: "local",
    package: "@mcpx-io/debug@latest",
  },
];
