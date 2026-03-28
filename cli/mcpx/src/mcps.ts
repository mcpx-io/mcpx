export type McpType = "remote" | "local";

export interface McpDefinition {
  key: string;
  name: string;
  description: string;
  type: McpType;
  package?: string;
  packageArgs?: string[];
  env?: Record<string, string>;
  envInputs?: McpEnvInput[];
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

export interface McpEnvInput {
  key: string;
  label: string;
  placeholder: string;
  optional?: boolean;
  env: string;
}

export const MCPS: McpDefinition[] = [
  {
    key: "postgres",
    name: "mcpx-postgres",
    description: "Banco de dados PostgreSQL — query, DDL, DML, vacuum e mais",
    type: "remote",
    url: "https://mcpx.online/postgres/mcp",
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
    key: "redis",
    name: "mcpx-redis",
    description: "Redis — get, set, hash, list, set, scan, TTL e mais",
    type: "remote",
    url: "https://mcpx.online/redis/mcp",
    headers: { Accept: "application/json, text/event-stream" },
    inputs: [
      {
        key: "redis_url",
        label: "Connection string do Redis",
        placeholder: "redis://user:pass@host:6379",
        header: "X-Redis-URL",
      },
    ],
  },
  {
    key: "vps",
    name: "mcpx-vps",
    description: "VPS — SSH, PM2, nginx, docker e monitor",
    type: "local",
    package: "@mcpx-io/vps@latest",
    envInputs: [
      {
        key: "vps_ssh",
        label: "SSH da VPS",
        placeholder: "root@85.209.92.10",
        env: "VPS_SSH",
      },
      {
        key: "vps_password",
        label: "Senha SSH (Enter para pular — usa chave ~/.ssh)",
        placeholder: "",
        optional: true,
        env: "VPS_PASSWORD",
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
