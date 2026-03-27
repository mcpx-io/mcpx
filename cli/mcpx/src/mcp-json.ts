import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const MCP_PATH = resolve(process.cwd(), ".mcp.json");

interface McpServer {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface McpJson {
  mcpServers: Record<string, McpServer>;
}

export function readMcpJson(): McpJson {
  if (!existsSync(MCP_PATH)) return { mcpServers: {} };
  try {
    return JSON.parse(readFileSync(MCP_PATH, "utf-8"));
  } catch {
    return { mcpServers: {} };
  }
}

export function writeMcpJson(data: McpJson): void {
  writeFileSync(MCP_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function addRemoteMcp(key: string, url: string, headers: Record<string, string>): void {
  const data = readMcpJson();
  data.mcpServers[key] = { type: "http", url, headers };
  writeMcpJson(data);
}

export function addLocalMcp(key: string, pkg: string): void {
  const data = readMcpJson();
  data.mcpServers[key] = { command: "npx", args: ["-y", pkg] };
  writeMcpJson(data);
}

export function removeMcp(key: string): boolean {
  const data = readMcpJson();
  if (!data.mcpServers[key]) return false;
  delete data.mcpServers[key];
  writeMcpJson(data);
  return true;
}

export function listConfigured(): string[] {
  return Object.keys(readMcpJson().mcpServers);
}

export function mcpJsonPath(): string {
  return MCP_PATH;
}
