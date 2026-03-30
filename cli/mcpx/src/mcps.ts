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
  secretInputs?: McpSecretInput[];
}

export interface McpInput {
  key: string;
  label: string;
  placeholder: string;
  header?: string;
}

export interface McpSecretInput {
  key: string;
  label: string;
  ref: string;           // nome do secret em ~/.mcpx/secrets.json
  header: string;        // header que vai no .mcp.json como mcpx:enc:<ref>
}

export interface McpEnvInput {
  key: string;
  label: string;
  placeholder: string;
  optional?: boolean;
  env: string;
  secret?: boolean;      // se true, criptografa em ~/.mcpx/secrets.json
}

export const MCPS: McpDefinition[] = [
  {
    key: "postgres",
    name: "mcpx-postgres",
    description: "Banco de dados PostgreSQL — query, DDL, DML, vacuum e mais",
    type: "remote",
    url: "http://localhost:4099/postgres/mcp",
    headers: { Accept: "application/json, text/event-stream" },
    secretInputs: [
      {
        key: "database_url",
        label: "Connection string do banco PostgreSQL",
        ref: "postgres",
        header: "X-Database-URL",
      },
    ],
  },
  {
    key: "redis",
    name: "mcpx-redis",
    description: "Redis — get, set, hash, list, set, scan, TTL e mais",
    type: "remote",
    url: "http://localhost:4099/redis/mcp",
    headers: { Accept: "application/json, text/event-stream" },
    secretInputs: [
      {
        key: "redis_url",
        label: "Connection string do Redis",
        ref: "redis",
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
        secret: true,
        env: "VPS_PASSWORD",
      },
    ],
  },
  {
    key: "google-sheets",
    name: "mcpx-google-sheets",
    description: "Google Sheets — criar, ler, escrever, formatar planilhas",
    type: "local",
    package: "@mcpx-io/google-sheets@latest",
    envInputs: [
      {
        key: "google_sa",
        label: "Service Account JSON (Enter para pular)",
        placeholder: '{"type":"service_account",...}',
        optional: true,
        secret: true,
        env: "GOOGLE_SERVICE_ACCOUNT",
      },
    ],
  },
  {
    key: "apps-script",
    name: "mcpx-apps-script",
    description: "Google Apps Script — listar, editar scripts, versões e deployments",
    type: "local",
    package: "@mcpx-io/apps-script@latest",
    envInputs: [
      {
        key: "google_sa",
        label: "Service Account JSON (Enter para pular — reutiliza do google-sheets)",
        placeholder: '{"type":"service_account",...}',
        optional: true,
        secret: true,
        env: "GOOGLE_SERVICE_ACCOUNT",
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
