import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveValue } from "./secrets.js";

// ─── Auth ─────────────────────────────────────────────────────────────────────

const API_VERSION = "v21.0";
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

function getToken(): string {
  const token = resolveValue(process.env.META_ACCESS_TOKEN ?? "");
  if (!token) throw new Error("META_ACCESS_TOKEN não configurado.");
  return token;
}

// ─── HTTP client ──────────────────────────────────────────────────────────────

async function metaGet(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
  const token = getToken();
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return data;
}

async function metaPost(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const token = getToken();
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return data;
}


function json(data: unknown): ReturnType<typeof text> {
  return text(JSON.stringify(data, null, 2));
}
function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const mcp = new McpServer({ name: "@mcpx-io/meta", version: "1.0.0" });

// ── Conta & Usuário ───────────────────────────────────────────────────────────

mcp.registerTool("get_me", {
  description: "Retorna informações do usuário/conta autenticada pelo token",
  inputSchema: {},
}, async () => {
  const data = await metaGet("/me", { fields: "id,name,email" });
  return json(data);
});

mcp.registerTool("list_ad_accounts", {
  description: "Lista as contas de anúncios acessíveis pelo token",
  inputSchema: { limit: z.coerce.number().optional() },
}, async ({ limit = 25 }) => {
  const data = await metaGet("/me/adaccounts", {
    fields: "id,name,account_status,currency,timezone_name,amount_spent",
    limit,
  });
  return json(data);
});

mcp.registerTool("list_pages", {
  description: "Lista as Páginas do Facebook gerenciadas pelo usuário autenticado",
  inputSchema: { limit: z.coerce.number().optional() },
}, async ({ limit = 25 }) => {
  const data = await metaGet("/me/accounts", {
    fields: "id,name,category,fan_count,access_token,instagram_business_account",
    limit,
  });
  return json(data);
});

// ── Campanhas (Marketing API) ─────────────────────────────────────────────────

mcp.registerTool("list_campaigns", {
  description: "Lista campanhas de uma conta de anúncios. account_id: ex 'act_123456'",
  inputSchema: {
    account_id: z.string(),
    status_filter: z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "ALL"]).optional(),
    limit: z.coerce.number().optional(),
  },
}, async ({ account_id, status_filter = "ALL", limit = 50 }) => {
  const filtering = status_filter !== "ALL"
    ? `[{"field":"effective_status","operator":"IN","value":["${status_filter}"]}]`
    : undefined;
  const data = await metaGet(`/${account_id}/campaigns`, {
    fields: "id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time",
    limit,
    ...(filtering ? { filtering } : {}),
  });
  return json(data);
});

mcp.registerTool("get_campaign", {
  description: "Retorna detalhes completos de uma campanha",
  inputSchema: { campaign_id: z.string() },
}, async ({ campaign_id }) => {
  const data = await metaGet(`/${campaign_id}`, {
    fields: "id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time,updated_time,budget_remaining",
  });
  return json(data);
});

mcp.registerTool("create_campaign", {
  description: "Cria uma campanha em uma conta de anúncios. Objectives: AWARENESS, TRAFFIC, ENGAGEMENT, LEADS, APP_PROMOTION, SALES",
  inputSchema: {
    account_id: z.string(),
    name: z.string(),
    objective: z.string(),
    status: z.enum(["ACTIVE", "PAUSED"]).optional(),
    daily_budget: z.coerce.number().optional(),
    special_ad_categories: z.array(z.string()).optional(),
  },
}, async ({ account_id, name, objective, status = "PAUSED", daily_budget, special_ad_categories = [] }) => {
  const body: Record<string, unknown> = { name, objective, status, special_ad_categories };
  if (daily_budget) body.daily_budget = String(daily_budget * 100); // cents
  const data = await metaPost(`/${account_id}/campaigns`, body);
  return json(data);
});

mcp.registerTool("update_campaign", {
  description: "Atualiza uma campanha — pausar, ativar, renomear ou mudar orçamento",
  inputSchema: {
    campaign_id: z.string(),
    status: z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]).optional(),
    name: z.string().optional(),
    daily_budget: z.coerce.number().optional(),
  },
}, async ({ campaign_id, status, name, daily_budget }) => {
  const body: Record<string, unknown> = {};
  if (status) body.status = status;
  if (name) body.name = name;
  if (daily_budget !== undefined) body.daily_budget = String(daily_budget * 100);
  const res = await fetch(`${BASE_URL}/${campaign_id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, access_token: getToken() }),
  });
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return json(data);
});

mcp.registerTool("list_adsets", {
  description: "Lista os conjuntos de anúncios de uma campanha ou conta",
  inputSchema: {
    campaign_id: z.string().optional(),
    account_id: z.string().optional(),
    limit: z.coerce.number().optional(),
  },
}, async ({ campaign_id, account_id, limit = 50 }) => {
  const id = campaign_id ? `/${campaign_id}/adsets` : `/${account_id}/adsets`;
  const data = await metaGet(id, {
    fields: "id,name,status,daily_budget,targeting,start_time,end_time,campaign_id",
    limit,
  });
  return json(data);
});

mcp.registerTool("list_ads", {
  description: "Lista anúncios de um conjunto de anúncios ou campanha",
  inputSchema: {
    adset_id: z.string().optional(),
    campaign_id: z.string().optional(),
    account_id: z.string().optional(),
    limit: z.coerce.number().optional(),
  },
}, async ({ adset_id, campaign_id, account_id, limit = 50 }) => {
  const id = adset_id ? `/${adset_id}/ads`
    : campaign_id ? `/${campaign_id}/ads`
    : `/${account_id}/ads`;
  const data = await metaGet(id, {
    fields: "id,name,status,adset_id,campaign_id,creative{id,name},created_time",
    limit,
  });
  return json(data);
});

// ── Insights (Métricas) ───────────────────────────────────────────────────────

mcp.registerTool("get_insights", {
  description: "Busca métricas de uma conta, campanha, conjunto ou anúncio. level: account | campaign | adset | ad. date_preset: today | yesterday | last_7d | last_30d | last_month | this_month | this_year | maximum",
  inputSchema: {
    object_id: z.string(),
    level: z.enum(["account", "campaign", "adset", "ad"]).optional(),
    date_preset: z.string().optional(),
    date_start: z.string().optional(),
    date_end: z.string().optional(),
    fields: z.string().optional(),
    limit: z.coerce.number().optional(),
  },
}, async ({ object_id, level, date_preset = "last_30d", date_start, date_end, fields, limit = 50 }) => {
  const defaultFields = "impressions,clicks,spend,reach,cpm,cpc,ctr,conversions,cost_per_conversion,account_name,campaign_name,adset_name,ad_name";
  const params: Record<string, string | number | undefined> = {
    fields: fields ?? defaultFields,
    limit,
  };
  if (level) params.level = level;
  if (date_start && date_end) {
    params.time_range = JSON.stringify({ since: date_start, until: date_end });
  } else {
    params.date_preset = date_preset;
  }
  const data = await metaGet(`/${object_id}/insights`, params);
  return json(data);
});

// ── Páginas ───────────────────────────────────────────────────────────────────

mcp.registerTool("create_post", {
  description: "Cria um post em uma Página do Facebook. Requer o page_access_token da página.",
  inputSchema: {
    page_id: z.string(),
    page_access_token: z.string(),
    message: z.string(),
    link: z.string().optional(),
    published: z.string().optional(),
  },
}, async ({ page_id, page_access_token, message, link, published = "true" }) => {
  const body: Record<string, unknown> = {
    message,
    published: published === "true",
    access_token: page_access_token,
  };
  if (link) body.link = link;
  const res = await fetch(`${BASE_URL}/${page_id}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return json(data);
});

mcp.registerTool("list_posts", {
  description: "Lista posts publicados em uma Página",
  inputSchema: {
    page_id: z.string(),
    page_access_token: z.string(),
    limit: z.coerce.number().optional(),
  },
}, async ({ page_id, page_access_token, limit = 25 }) => {
  const url = new URL(`${BASE_URL}/${page_id}/feed`);
  url.searchParams.set("access_token", page_access_token);
  url.searchParams.set("fields", "id,message,story,created_time,permalink_url,full_picture");
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString());
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return json(data);
});

mcp.registerTool("get_page_insights", {
  description: "Retorna métricas da Página (alcance, impressões, engajamento). period: day | week | days_28 | month",
  inputSchema: {
    page_id: z.string(),
    page_access_token: z.string(),
    metrics: z.string().optional(),
    period: z.string().optional(),
    date_preset: z.string().optional(),
  },
}, async ({ page_id, page_access_token, metrics, period = "day", date_preset = "last_30d" }) => {
  const defaultMetrics = "page_impressions,page_reach,page_engaged_users,page_fan_adds,page_views_total,page_posts_impressions";
  const url = new URL(`${BASE_URL}/${page_id}/insights`);
  url.searchParams.set("access_token", page_access_token);
  url.searchParams.set("metric", metrics ?? defaultMetrics);
  url.searchParams.set("period", period);
  url.searchParams.set("date_preset", date_preset);
  const res = await fetch(url.toString());
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return json(data);
});

// ── Instagram ─────────────────────────────────────────────────────────────────

mcp.registerTool("get_instagram_account", {
  description: "Retorna conta do Instagram Business vinculada a uma Página",
  inputSchema: { page_id: z.string(), page_access_token: z.string() },
}, async ({ page_id, page_access_token }) => {
  const url = new URL(`${BASE_URL}/${page_id}`);
  url.searchParams.set("access_token", page_access_token);
  url.searchParams.set("fields", "instagram_business_account{id,name,username,followers_count,media_count,profile_picture_url,biography}");
  const res = await fetch(url.toString());
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return json(data);
});

mcp.registerTool("list_instagram_media", {
  description: "Lista mídias publicadas no Instagram Business",
  inputSchema: {
    ig_account_id: z.string(),
    page_access_token: z.string(),
    limit: z.coerce.number().optional(),
  },
}, async ({ ig_account_id, page_access_token, limit = 25 }) => {
  const url = new URL(`${BASE_URL}/${ig_account_id}/media`);
  url.searchParams.set("access_token", page_access_token);
  url.searchParams.set("fields", "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count");
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString());
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return json(data);
});

mcp.registerTool("get_instagram_insights", {
  description: "Retorna métricas da conta Instagram (reach, impressions, followers). period: day | week | days_28 | month | lifetime",
  inputSchema: {
    ig_account_id: z.string(),
    page_access_token: z.string(),
    metrics: z.string().optional(),
    period: z.string().optional(),
  },
}, async ({ ig_account_id, page_access_token, metrics, period = "day" }) => {
  const defaultMetrics = "impressions,reach,profile_views,follower_count,email_contacts,website_clicks";
  const url = new URL(`${BASE_URL}/${ig_account_id}/insights`);
  url.searchParams.set("access_token", page_access_token);
  url.searchParams.set("metric", metrics ?? defaultMetrics);
  url.searchParams.set("period", period);
  const res = await fetch(url.toString());
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return json(data);
});

mcp.registerTool("get_media_insights", {
  description: "Retorna métricas de uma mídia específica do Instagram (likes, comments, shares, reach, impressions)",
  inputSchema: {
    media_id: z.string(),
    page_access_token: z.string(),
  },
}, async ({ media_id, page_access_token }) => {
  const url = new URL(`${BASE_URL}/${media_id}/insights`);
  url.searchParams.set("access_token", page_access_token);
  url.searchParams.set("metric", "impressions,reach,likes,comments,shares,saved,total_interactions");
  const res = await fetch(url.toString());
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return json(data);
});

// ── Messenger ─────────────────────────────────────────────────────────────────

mcp.registerTool("list_conversations", {
  description: "Lista conversas do Messenger em uma Página",
  inputSchema: {
    page_id: z.string(),
    page_access_token: z.string(),
    limit: z.coerce.number().optional(),
  },
}, async ({ page_id, page_access_token, limit = 25 }) => {
  const url = new URL(`${BASE_URL}/${page_id}/conversations`);
  url.searchParams.set("access_token", page_access_token);
  url.searchParams.set("fields", "id,participants,updated_time,unread_count,message_count");
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString());
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return json(data);
});

mcp.registerTool("get_conversation", {
  description: "Retorna as mensagens de uma conversa do Messenger",
  inputSchema: {
    conversation_id: z.string(),
    page_access_token: z.string(),
    limit: z.coerce.number().optional(),
  },
}, async ({ conversation_id, page_access_token, limit = 50 }) => {
  const url = new URL(`${BASE_URL}/${conversation_id}/messages`);
  url.searchParams.set("access_token", page_access_token);
  url.searchParams.set("fields", "id,message,from,to,created_time");
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString());
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return json(data);
});

mcp.registerTool("send_message", {
  description: "Envia uma mensagem via Messenger para um usuário. recipient: PSID do destinatário.",
  inputSchema: {
    page_id: z.string(),
    page_access_token: z.string(),
    recipient_id: z.string(),
    message_text: z.string(),
  },
}, async ({ page_id: _, page_access_token, recipient_id, message_text }) => {
  const res = await fetch(`${BASE_URL}/me/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipient_id },
      message: { text: message_text },
      access_token: page_access_token,
    }),
  });
  const data = await res.json() as Record<string, unknown>;
  if (data.error) throw new Error(`Meta API: ${(data.error as Record<string, unknown>).message}`);
  return json(data);
});

// ── Pixels ────────────────────────────────────────────────────────────────────

mcp.registerTool("list_pixels", {
  description: "Lista os pixels de uma conta de anúncios com status e estatísticas básicas",
  inputSchema: { account_id: z.string() },
}, async ({ account_id }) => {
  const data = await metaGet(`/${account_id}/adspixels`, {
    fields: "id,name,creation_time,last_fired_time,code,is_unavailable",
  });
  return json(data);
});

mcp.registerTool("get_pixel_stats", {
  description: "Retorna eventos recebidos por um pixel. start_date e end_date no formato YYYY-MM-DD",
  inputSchema: {
    pixel_id: z.string(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    aggregation: z.enum(["event", "device_type", "device_os", "browser"]).optional(),
    event: z.string().optional(),
  },
}, async ({ pixel_id, start_date, end_date, aggregation = "event", event }) => {
  const today = new Date().toISOString().split("T")[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  const data = await metaGet(`/${pixel_id}/stats`, {
    start_time: start_date ?? weekAgo,
    end_time: end_date ?? today,
    aggregation,
    ...(event ? { event } : {}),
  });
  return json(data);
});

mcp.registerTool("get_pixel_events", {
  description: "Lista os tipos de eventos recebidos pelo pixel nas últimas horas/dias com volume por evento",
  inputSchema: {
    pixel_id: z.string(),
    since: z.string().optional(),
    until: z.string().optional(),
  },
}, async ({ pixel_id, since, until }) => {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const data = await metaGet(`/${pixel_id}/stats`, {
    start_time: since ?? String(dayAgo),
    end_time: until ?? String(now),
    aggregation: "event",
  });
  return json(data);
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch(console.error);
