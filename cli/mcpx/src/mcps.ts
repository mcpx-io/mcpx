export type McpType = "remote" | "local";

export interface McpDefinition {
  key: string;
  name: string;
  description: string;
  type: McpType;
  package?: string;
  packageArgs?: string[];     // args extras além do pacote
  url?: string;
  headers?: Record<string, string>;
  inputs?: McpInput[];
}

export interface McpInput {
  key: string;
  label: string;
  placeholder: string;
  header?: string;
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
  {
    key: "chrome-devtools",
    name: "chrome-devtools",
    description: "Chrome DevTools — console, network, screenshots via Chrome",
    type: "local",
    package: "chrome-devtools-mcp@latest",
    packageArgs: ["--port=9222"],
  },
];
