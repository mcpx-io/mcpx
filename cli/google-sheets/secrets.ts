import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir, hostname, cpus, platform } from "os";

// ─── Machine key (deterministico por máquina) ────────────────────────────────

function getMachineKey(): Buffer {
  const id = `${hostname()}::${cpus()[0]?.model ?? "cpu"}::${platform()}`;
  return createHash("sha256").update(id).digest();
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const SECRETS_DIR = resolve(homedir(), ".mcpx");
const SECRETS_FILE = resolve(SECRETS_DIR, "secrets.json");

interface EncryptedSecret {
  iv: string;
  tag: string;
  data: string;
}

function readStore(): Record<string, EncryptedSecret> {
  if (!existsSync(SECRETS_FILE)) return {};
  try { return JSON.parse(readFileSync(SECRETS_FILE, "utf-8")); } catch { return {}; }
}

function writeStore(store: Record<string, EncryptedSecret>): void {
  if (!existsSync(SECRETS_DIR)) mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SECRETS_FILE, JSON.stringify(store, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
}

// ─── Crypto ───────────────────────────────────────────────────────────────────

export function saveSecret(ref: string, value: string): void {
  const key = getMachineKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const store = readStore();
  store[ref] = {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
  writeStore(store);
}

export function loadSecret(ref: string): string {
  const store = readStore();
  const entry = store[ref];
  if (!entry) throw new Error(`Secret "${ref}" não encontrado. Use: mcpx secrets set ${ref}`);

  const key = getMachineKey();
  const iv = Buffer.from(entry.iv, "base64");
  const tag = Buffer.from(entry.tag, "base64");
  const data = Buffer.from(entry.data, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf-8");
}

export function deleteSecret(ref: string): boolean {
  const store = readStore();
  if (!store[ref]) return false;
  delete store[ref];
  writeStore(store);
  return true;
}

export function listSecrets(): string[] {
  return Object.keys(readStore());
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

const PREFIX = "mcpx:enc:";

export function resolveValue(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const ref = value.slice(PREFIX.length);
  return loadSecret(ref);
}

export function isEncryptedRef(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function makeRef(ref: string): string {
  return `${PREFIX}${ref}`;
}
