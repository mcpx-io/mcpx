# mcpx

CLI para instalar e configurar MCPs no Claude Code.

---

## Instalação

### Windows (PowerShell)

```powershell
irm https://mcpx.online/install.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://mcpx.online/install.sh | bash
```

---

## Uso

### 1. Inicializar no projeto

Dentro da pasta do projeto, rode:

```bash
mcpx init
```

Aparece um menu para selecionar quais MCPs configurar:

```
? Selecione os MCPs para adicionar:
❯◉ postgres          [remoto]  — Banco de dados PostgreSQL
 ◉ debug             [local]   — Browser automation, HTTP requests
 ◉ chrome-devtools   [local]   — Console, network, screenshots via Chrome
```

Navegue com as setas, marque/desmarque com **espaço**, confirme com **Enter**.

O arquivo `.mcp.json` é gerado automaticamente na pasta do projeto. Recarregue o Claude Code para aplicar.

---

## MCPs disponíveis

| MCP | Tipo | Descrição |
|-----|------|-----------|
| `postgres` | remoto | PostgreSQL — query, DDL, DML, vacuum e mais |
| `debug` | local | Browser automation, HTTP requests, parse de rotas |
| `chrome-devtools` | local | Chrome DevTools — console, network, screenshots |

MCPs locais são executados via `npx` e sempre usam a versão mais recente automaticamente.

---

## Outros comandos

```bash
mcpx add postgres       # adiciona um MCP específico
mcpx remove debug       # remove um MCP do .mcp.json
mcpx list               # lista MCPs disponíveis e status no projeto
```

---

## Atualizar o mcpx

```bash
npm install -g @mcpx-io/mcpx@latest
```

> O `.npmrc` precisa estar configurado com o token do GitHub Packages.
> Se der erro de autenticação, rode o script de instalação novamente.
