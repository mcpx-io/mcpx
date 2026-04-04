export type McpType = "remote" | "local";

export interface OAuthSetup {
  scopes: string[];
  redirectUri: string;
  secrets: { clientId: string; clientSecret: string; refreshToken: string };
}

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
  postInstallNote?: string;
  oauthSetup?: OAuthSetup;
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
  preConfigured?: boolean; // se true, adiciona mcpx:enc:<key> sem pedir ao usuário
}

const GOOGLE_OAUTH: OAuthSetup = {
  scopes: [
    "https://www.googleapis.com/auth/script.projects",
    "https://www.googleapis.com/auth/script.deployments",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
  ],
  redirectUri: "http://localhost:3000/callback",
  secrets: {
    clientId: "google_client_id",
    clientSecret: "google_client_secret",
    refreshToken: "google_refresh_token",
  },
};

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
    oauthSetup: GOOGLE_OAUTH,
    envInputs: [
      { key: "google_client_id",     env: "GOOGLE_CLIENT_ID",     label: "", placeholder: "", preConfigured: true },
      { key: "google_client_secret", env: "GOOGLE_CLIENT_SECRET", label: "", placeholder: "", preConfigured: true },
      { key: "google_refresh_token", env: "GOOGLE_REFRESH_TOKEN", label: "", placeholder: "", preConfigured: true },
    ],
  },
  {
    key: "apps-script",
    name: "mcpx-apps-script",
    description: "Google Apps Script — listar, editar scripts, versões e deployments",
    type: "local",
    package: "@mcpx-io/apps-script@latest",
    oauthSetup: GOOGLE_OAUTH,
    envInputs: [
      { key: "google_client_id",     env: "GOOGLE_CLIENT_ID",     label: "", placeholder: "", preConfigured: true },
      { key: "google_client_secret", env: "GOOGLE_CLIENT_SECRET", label: "", placeholder: "", preConfigured: true },
      { key: "google_refresh_token", env: "GOOGLE_REFRESH_TOKEN", label: "", placeholder: "", preConfigured: true },
    ],
  },
  {
    key: "meta",
    name: "mcpx-meta",
    description: "Meta API — anúncios, campanhas, insights, páginas, Instagram e Messenger",
    type: "local",
    package: "@mcpx-io/meta@latest",
    envInputs: [
      {
        key: "meta_access_token",
        label: "Meta Access Token (User ou System User Token)",
        placeholder: "EAAxxxxxxxxxx...",
        secret: true,
        env: "META_ACCESS_TOKEN",
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
  {
    key: "memory",
    name: "mcpx-memory",
    description: "Memória global — salva contexto, decisões e histórico entre sessões e projetos (auto-compact)",
    type: "remote",
    url: "http://localhost:4099/memory/mcp",
    headers: { Accept: "application/json, text/event-stream" },
    secretInputs: [
      {
        key: "memory_token",
        label: "mcpx Memory Token (gerado automaticamente — pressione Enter)",
        ref: "memory",
        header: "X-Memory-Token",
      },
    ],
    postInstallNote: "O watcher de auto-compact já está ativo via proxy. Nenhuma configuração adicional necessária.",
  },
];
