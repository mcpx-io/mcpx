import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { resolveValue } from "./secrets.js";

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getAuth() {
  const clientId = resolveValue(process.env.GOOGLE_CLIENT_ID ?? "");
  const clientSecret = resolveValue(process.env.GOOGLE_CLIENT_SECRET ?? "");
  const refreshToken = resolveValue(process.env.GOOGLE_REFRESH_TOKEN ?? "");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "OAuth não configurado. Execute: npx @mcpx-io/apps-script@latest setup"
    );
  }

  const auth = new OAuth2Client({ clientId, clientSecret });
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

function sheets() {
  return google.sheets({ version: "v4", auth: getAuth() });
}
function drive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseSpreadsheetId(input: string): string {
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : input;
}

async function getSheetId(spreadsheetId: string, sheetName: string): Promise<number> {
  const res = await sheets().spreadsheets.get({ spreadsheetId });
  const sheet = res.data.sheets?.find(s => s.properties?.title === sheetName);
  if (!sheet) throw new Error(`Aba '${sheetName}' não encontrada.`);
  return sheet.properties!.sheetId!;
}

function a1ToGrid(a1: string) {
  const parts = a1.toUpperCase().split(":");
  function parseCell(cell: string) {
    const m = cell.match(/^([A-Z]+)(\d+)$/);
    if (!m) throw new Error(`Referência inválida: ${cell}`);
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { r: parseInt(m[2]) - 1, c: col - 1 };
  }
  const start = parseCell(parts[0]);
  const end = parts[1] ? parseCell(parts[1]) : start;
  return { r1: start.r, r2: end.r + 1, c1: start.c, c2: end.c + 1 };
}

function colLetter(idx: number): string {
  let s = "";
  let n = idx;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const mcp = new McpServer({ name: "@mcpx-io/google-sheets", version: "1.0.0" });

// ── Planilhas ────────────────────────────────────────────────────────────────

mcp.registerTool("create_spreadsheet", {
  description: "Cria uma nova planilha no Google Sheets",
  inputSchema: { title: z.string() },
}, async ({ title }) => {
  const res = await sheets().spreadsheets.create({ requestBody: { properties: { title } } });
  return { content: [{ type: "text", text: JSON.stringify({ spreadsheet_id: res.data.spreadsheetId, url: res.data.spreadsheetUrl, title: res.data.properties?.title }) }] };
});

mcp.registerTool("list_spreadsheets", {
  description: "Lista planilhas no Google Drive",
  inputSchema: { query: z.string().optional() },
}, async ({ query }) => {
  const mime = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
  const nameFilter = query ? ` and name contains '${query}'` : "";
  const d = drive();
  const fields = "nextPageToken,files(id,name,modifiedTime,webViewLink,owners)";

  async function fetchAll(q: string): Promise<any[]> {
    const results: any[] = [];
    let pageToken: string | undefined;
    do {
      const res: any = await d.files.list({ q, pageSize: 100, fields, pageToken });
      results.push(...(res.data.files ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return results;
  }

  const [owned, shared] = await Promise.all([
    fetchAll(`${mime}${nameFilter}`),
    fetchAll(`sharedWithMe=true and ${mime}${nameFilter}`),
  ]);

  const seen = new Set<string>();
  const all = [...owned, ...shared].filter(f => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });

  return { content: [{ type: "text", text: JSON.stringify(all) }] };
});

mcp.registerTool("get_spreadsheet_info", {
  description: "Retorna informações de uma planilha (título, abas, url)",
  inputSchema: { spreadsheet_id: z.string() },
}, async ({ spreadsheet_id: _sid }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const res = await sheets().spreadsheets.get({ spreadsheetId: spreadsheet_id });
  const data = res.data;
  return { content: [{ type: "text", text: JSON.stringify({
    title: data.properties?.title,
    spreadsheet_id: data.spreadsheetId,
    url: data.spreadsheetUrl,
    sheets: data.sheets?.map(s => ({
      title: s.properties?.title,
      sheet_id: s.properties?.sheetId,
      index: s.properties?.index,
      row_count: s.properties?.gridProperties?.rowCount,
      column_count: s.properties?.gridProperties?.columnCount,
    })),
  }) }] };
});

// ── Abas ─────────────────────────────────────────────────────────────────────

mcp.registerTool("list_sheets", {
  description: "Lista as abas de uma planilha",
  inputSchema: { spreadsheet_id: z.string() },
}, async ({ spreadsheet_id: _sid }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const res = await sheets().spreadsheets.get({ spreadsheetId: spreadsheet_id });
  return { content: [{ type: "text", text: JSON.stringify(res.data.sheets?.map(s => ({ title: s.properties?.title, sheet_id: s.properties?.sheetId }))) }] };
});

mcp.registerTool("add_sheet", {
  description: "Adiciona uma nova aba à planilha",
  inputSchema: { spreadsheet_id: z.string(), sheet_title: z.string() },
}, async ({ spreadsheet_id: _sid, sheet_title }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const res = await sheets().spreadsheets.batchUpdate({ spreadsheetId: spreadsheet_id, requestBody: { requests: [{ addSheet: { properties: { title: sheet_title } } }] } });
  const props = res.data.replies?.[0]?.addSheet?.properties;
  return { content: [{ type: "text", text: JSON.stringify({ sheet_id: props?.sheetId, title: props?.title }) }] };
});

mcp.registerTool("delete_sheet", {
  description: "Remove uma aba da planilha",
  inputSchema: { spreadsheet_id: z.string(), sheet_name: z.string() },
}, async ({ spreadsheet_id: _sid, sheet_name }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const sheetId = await getSheetId(spreadsheet_id, sheet_name);
  await sheets().spreadsheets.batchUpdate({ spreadsheetId: spreadsheet_id, requestBody: { requests: [{ deleteSheet: { sheetId } }] } });
  return { content: [{ type: "text", text: `Aba '${sheet_name}' removida.` }] };
});

mcp.registerTool("rename_sheet", {
  description: "Renomeia uma aba da planilha",
  inputSchema: { spreadsheet_id: z.string(), old_name: z.string(), new_name: z.string() },
}, async ({ spreadsheet_id: _sid, old_name, new_name }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const sheetId = await getSheetId(spreadsheet_id, old_name);
  await sheets().spreadsheets.batchUpdate({ spreadsheetId: spreadsheet_id, requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId, title: new_name }, fields: "title" } }] } });
  return { content: [{ type: "text", text: `Aba renomeada para '${new_name}'.` }] };
});

// ── Dados ─────────────────────────────────────────────────────────────────────

mcp.registerTool("read_range", {
  description: "Lê um range de células (ex: 'Sheet1!A1:C10')",
  inputSchema: { spreadsheet_id: z.string(), range: z.string() },
}, async ({ spreadsheet_id: _sid, range }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: spreadsheet_id, range });
  return { content: [{ type: "text", text: JSON.stringify({ range: res.data.range, values: res.data.values ?? [] }) }] };
});

mcp.registerTool("write_range", {
  description: "Escreve valores em um range (ex: 'Sheet1!A1')",
  inputSchema: { spreadsheet_id: z.string(), range: z.string(), values: z.array(z.array(z.any())), value_input_option: z.string().optional() },
}, async ({ spreadsheet_id: _sid, range, values, value_input_option = "USER_ENTERED" }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const res = await sheets().spreadsheets.values.update({ spreadsheetId: spreadsheet_id, range, valueInputOption: value_input_option, requestBody: { values } });
  return { content: [{ type: "text", text: JSON.stringify({ updated_range: res.data.updatedRange, updated_rows: res.data.updatedRows, updated_cells: res.data.updatedCells }) }] };
});

mcp.registerTool("append_rows", {
  description: "Adiciona linhas ao final de um range",
  inputSchema: { spreadsheet_id: z.string(), range: z.string(), values: z.array(z.array(z.any())), value_input_option: z.string().optional() },
}, async ({ spreadsheet_id: _sid, range, values, value_input_option = "USER_ENTERED" }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const res = await sheets().spreadsheets.values.append({ spreadsheetId: spreadsheet_id, range, valueInputOption: value_input_option, insertDataOption: "INSERT_ROWS", requestBody: { values } });
  return { content: [{ type: "text", text: JSON.stringify(res.data.updates ?? {}) }] };
});

mcp.registerTool("clear_range", {
  description: "Limpa todos os valores de um range",
  inputSchema: { spreadsheet_id: z.string(), range: z.string() },
}, async ({ spreadsheet_id: _sid, range }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  await sheets().spreadsheets.values.clear({ spreadsheetId: spreadsheet_id, range, requestBody: {} });
  return { content: [{ type: "text", text: `Range '${range}' limpo.` }] };
});

// ── Células ───────────────────────────────────────────────────────────────────

mcp.registerTool("get_cell", {
  description: "Lê o valor de uma célula específica (ex: 'Sheet1!A1')",
  inputSchema: { spreadsheet_id: z.string(), cell: z.string() },
}, async ({ spreadsheet_id: _sid, cell }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: spreadsheet_id, range: cell });
  const value = res.data.values?.[0]?.[0] ?? null;
  return { content: [{ type: "text", text: JSON.stringify({ cell, value }) }] };
});

mcp.registerTool("set_cell", {
  description: "Define o valor de uma célula específica",
  inputSchema: { spreadsheet_id: z.string(), cell: z.string(), value: z.any(), value_input_option: z.string().optional() },
}, async ({ spreadsheet_id: _sid, cell, value, value_input_option = "USER_ENTERED" }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  await sheets().spreadsheets.values.update({ spreadsheetId: spreadsheet_id, range: cell, valueInputOption: value_input_option, requestBody: { values: [[value]] } });
  return { content: [{ type: "text", text: `Célula '${cell}' atualizada.` }] };
});

// ── Fórmulas ──────────────────────────────────────────────────────────────────

mcp.registerTool("set_formula", {
  description: "Insere uma fórmula em uma célula",
  inputSchema: { spreadsheet_id: z.string(), cell: z.string(), formula: z.string() },
}, async ({ spreadsheet_id: _sid, cell, formula }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const f = formula.startsWith("=") ? formula : `=${formula}`;
  await sheets().spreadsheets.values.update({ spreadsheetId: spreadsheet_id, range: cell, valueInputOption: "USER_ENTERED", requestBody: { values: [[f]] } });
  return { content: [{ type: "text", text: `Fórmula '${f}' inserida em '${cell}'.` }] };
});

mcp.registerTool("get_formula", {
  description: "Retorna a fórmula de uma célula (não o valor calculado)",
  inputSchema: { spreadsheet_id: z.string(), cell: z.string() },
}, async ({ spreadsheet_id: _sid, cell }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: spreadsheet_id, range: cell, valueRenderOption: "FORMULA" });
  return { content: [{ type: "text", text: JSON.stringify({ cell, formula: res.data.values?.[0]?.[0] ?? null }) }] };
});

mcp.registerTool("list_formulas", {
  description: "Lista todas as fórmulas em um range com seus valores calculados",
  inputSchema: { spreadsheet_id: z.string(), range: z.string() },
}, async ({ spreadsheet_id: _sid, range }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const [resF, resV] = await Promise.all([
    sheets().spreadsheets.values.get({ spreadsheetId: spreadsheet_id, range, valueRenderOption: "FORMULA" }),
    sheets().spreadsheets.values.get({ spreadsheetId: spreadsheet_id, range, valueRenderOption: "FORMATTED_VALUE" }),
  ]);
  const fGrid = resF.data.values ?? [];
  const vGrid = resV.data.values ?? [];
  const rawRange = resF.data.range ?? "";
  const startRef = rawRange.includes("!") ? rawRange.split("!")[1].split(":")[0] : rawRange.split(":")[0];
  const m = startRef.toUpperCase().match(/^([A-Z]+)(\d+)$/);
  let startCol = 0;
  if (m) for (const ch of m[1]) startCol = startCol * 26 + (ch.charCodeAt(0) - 64);
  const startRow = m ? parseInt(m[2]) : 1;
  const found: object[] = [];
  fGrid.forEach((row, ri) => {
    row.forEach((cell, ci) => {
      if (typeof cell === "string" && cell.startsWith("=")) {
        found.push({ cell: `${colLetter(startCol + ci)}${startRow + ri}`, formula: cell, calculated_value: vGrid[ri]?.[ci] ?? null });
      }
    });
  });
  return { content: [{ type: "text", text: JSON.stringify({ total_formulas: found.length, formulas: found }) }] };
});

mcp.registerTool("review_formulas", {
  description: "Revisa fórmulas de uma aba, identificando erros (#REF!, #DIV/0!, etc.)",
  inputSchema: { spreadsheet_id: z.string(), sheet_name: z.string() },
}, async ({ spreadsheet_id: _sid, sheet_name }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const [resF, resV] = await Promise.all([
    sheets().spreadsheets.values.get({ spreadsheetId: spreadsheet_id, range: sheet_name, valueRenderOption: "FORMULA" }),
    sheets().spreadsheets.values.get({ spreadsheetId: spreadsheet_id, range: sheet_name, valueRenderOption: "FORMATTED_VALUE" }),
  ]);
  const fGrid = resF.data.values ?? [];
  const vGrid = resV.data.values ?? [];
  const ERRORS = new Set(["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!"]);
  const report = fGrid.flatMap((row, ri) =>
    row.flatMap((cell, ci) => {
      if (typeof cell !== "string" || !cell.startsWith("=")) return [];
      const calc = vGrid[ri]?.[ci] ?? null;
      const issues: string[] = [];
      if (ERRORS.has(String(calc))) issues.push(`Erro: ${calc}`);
      return [{ cell: `${colLetter(ci + 1)}${ri + 1}`, formula: cell, calculated_value: calc, issues, status: issues.length ? "ERROR" : "OK" }];
    })
  );
  const errors = report.filter(r => (r as any).status === "ERROR");
  return { content: [{ type: "text", text: JSON.stringify({ sheet: sheet_name, total_formulas: report.length, total_errors: errors.length, formulas: report }) }] };
});

// ── Formatação ────────────────────────────────────────────────────────────────

mcp.registerTool("format_cells", {
  description: "Formata células: bold, italic, font_size, text_color (RGB 0-1), background_color, horizontal_alignment, borders",
  inputSchema: {
    spreadsheet_id: z.string(), sheet_name: z.string(), range: z.string(),
    bold: z.boolean().optional(), italic: z.boolean().optional(), font_size: z.number().optional(),
    text_color: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional(),
    background_color: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional(),
    horizontal_alignment: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
    borders: z.boolean().optional(),
  },
}, async ({ spreadsheet_id: _sid, sheet_name, range, bold, italic, font_size, text_color, background_color, horizontal_alignment, borders }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const sheetId = await getSheetId(spreadsheet_id, sheet_name);
  const { r1, r2, c1, c2 } = a1ToGrid(range);
  const gridRange = { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 };
  const requests: object[] = [];
  const fmt: Record<string, unknown> = {};
  const fields: string[] = [];
  const textFmt: Record<string, unknown> = {};
  if (bold !== undefined) textFmt.bold = bold;
  if (italic !== undefined) textFmt.italic = italic;
  if (font_size !== undefined) textFmt.fontSize = font_size;
  if (text_color) textFmt.foregroundColor = text_color;
  if (Object.keys(textFmt).length) { fmt.textFormat = textFmt; fields.push("userEnteredFormat.textFormat"); }
  if (background_color) { fmt.backgroundColor = background_color; fields.push("userEnteredFormat.backgroundColor"); }
  if (horizontal_alignment) { fmt.horizontalAlignment = horizontal_alignment; fields.push("userEnteredFormat.horizontalAlignment"); }
  if (fields.length) requests.push({ repeatCell: { range: gridRange, cell: { userEnteredFormat: fmt }, fields: fields.join(",") } });
  if (borders) {
    const bs = { style: "SOLID", width: 1, color: { red: 0, green: 0, blue: 0 } };
    requests.push({ updateBorders: { range: gridRange, top: bs, bottom: bs, left: bs, right: bs, innerHorizontal: bs, innerVertical: bs } });
  }
  if (requests.length) await sheets().spreadsheets.batchUpdate({ spreadsheetId: spreadsheet_id, requestBody: { requests } });
  return { content: [{ type: "text", text: `Formatação aplicada em '${range}'.` }] };
});

mcp.registerTool("set_column_width", {
  description: "Define a largura de colunas (índices 0-based)",
  inputSchema: { spreadsheet_id: z.string(), sheet_name: z.string(), start_column: z.coerce.number(), end_column: z.coerce.number(), width: z.coerce.number() },
}, async ({ spreadsheet_id: _sid, sheet_name, start_column, end_column, width }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const sheetId = await getSheetId(spreadsheet_id, sheet_name);
  await sheets().spreadsheets.batchUpdate({ spreadsheetId: spreadsheet_id, requestBody: { requests: [{ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: start_column, endIndex: end_column }, properties: { pixelSize: width }, fields: "pixelSize" } }] } });
  return { content: [{ type: "text", text: "Largura atualizada." }] };
});

mcp.registerTool("set_row_height", {
  description: "Define a altura de linhas (índices 0-based)",
  inputSchema: { spreadsheet_id: z.string(), sheet_name: z.string(), start_row: z.coerce.number(), end_row: z.coerce.number(), height: z.coerce.number() },
}, async ({ spreadsheet_id: _sid, sheet_name, start_row, end_row, height }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const sheetId = await getSheetId(spreadsheet_id, sheet_name);
  await sheets().spreadsheets.batchUpdate({ spreadsheetId: spreadsheet_id, requestBody: { requests: [{ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: start_row, endIndex: end_row }, properties: { pixelSize: height }, fields: "pixelSize" } }] } });
  return { content: [{ type: "text", text: "Altura atualizada." }] };
});

mcp.registerTool("merge_cells", {
  description: "Mescla células em um range",
  inputSchema: { spreadsheet_id: z.string(), sheet_name: z.string(), range: z.string(), merge_type: z.enum(["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"]).optional() },
}, async ({ spreadsheet_id: _sid, sheet_name, range, merge_type = "MERGE_ALL" }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const sheetId = await getSheetId(spreadsheet_id, sheet_name);
  const { r1, r2, c1, c2 } = a1ToGrid(range);
  await sheets().spreadsheets.batchUpdate({ spreadsheetId: spreadsheet_id, requestBody: { requests: [{ mergeCells: { range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 }, mergeType: merge_type } }] } });
  return { content: [{ type: "text", text: `Células '${range}' mescladas.` }] };
});

mcp.registerTool("unmerge_cells", {
  description: "Desfaz a mesclagem de células em um range",
  inputSchema: { spreadsheet_id: z.string(), sheet_name: z.string(), range: z.string() },
}, async ({ spreadsheet_id: _sid, sheet_name, range }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const sheetId = await getSheetId(spreadsheet_id, sheet_name);
  const { r1, r2, c1, c2 } = a1ToGrid(range);
  await sheets().spreadsheets.batchUpdate({ spreadsheetId: spreadsheet_id, requestBody: { requests: [{ unmergeCells: { range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 } } }] } });
  return { content: [{ type: "text", text: `Mesclagem desfeita em '${range}'.` }] };
});

mcp.registerTool("copy_sheet", {
  description: "Duplica uma aba dentro da mesma planilha ou para outra planilha",
  inputSchema: {
    spreadsheet_id: z.string(),
    sheet_name: z.string(),
    destination_spreadsheet_id: z.string().optional(),
  },
}, async ({ spreadsheet_id: _sid, sheet_name, destination_spreadsheet_id: _dest }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const destination_spreadsheet_id = _dest ? parseSpreadsheetId(_dest) : spreadsheet_id;
  const sheetId = await getSheetId(spreadsheet_id, sheet_name);
  const res = await sheets().spreadsheets.sheets.copyTo({
    spreadsheetId: spreadsheet_id,
    sheetId,
    requestBody: { destinationSpreadsheetId: destination_spreadsheet_id },
  });
  return { content: [{ type: "text", text: JSON.stringify({ new_sheet_id: res.data.sheetId, new_title: res.data.title }) }] };
});

mcp.registerTool("sort_range", {
  description: "Ordena um range por uma ou mais colunas. sort_specs: array de {column_index (0-based), ascending}",
  inputSchema: {
    spreadsheet_id: z.string(),
    sheet_name: z.string(),
    range: z.string(),
    sort_specs: z.array(z.object({ column_index: z.coerce.number(), ascending: z.boolean().optional() })),
  },
}, async ({ spreadsheet_id: _sid, sheet_name, range, sort_specs }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const sheetId = await getSheetId(spreadsheet_id, sheet_name);
  const { r1, r2, c1, c2 } = a1ToGrid(range);
  await sheets().spreadsheets.batchUpdate({
    spreadsheetId: spreadsheet_id,
    requestBody: {
      requests: [{
        sortRange: {
          range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 },
          sortSpecs: sort_specs.map(s => ({
            dimensionIndex: s.column_index,
            sortOrder: s.ascending === false ? "DESCENDING" : "ASCENDING",
          })),
        },
      }],
    },
  });
  return { content: [{ type: "text", text: `Range '${range}' ordenado.` }] };
});

mcp.registerTool("find_replace", {
  description: "Busca e substitui valores em uma planilha. Pode ser limitado a uma aba ou aplicado em toda a planilha.",
  inputSchema: {
    spreadsheet_id: z.string(),
    find: z.string(),
    replace: z.string(),
    sheet_name: z.string().optional(),
    match_case: z.boolean().optional(),
    match_entire_cell: z.boolean().optional(),
    search_by_regex: z.boolean().optional(),
  },
}, async ({ spreadsheet_id: _sid, find, replace, sheet_name, match_case, match_entire_cell, search_by_regex }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const range: Record<string, unknown> = {};
  if (sheet_name) range.sheetId = await getSheetId(spreadsheet_id, sheet_name);
  const res = await sheets().spreadsheets.batchUpdate({
    spreadsheetId: spreadsheet_id,
    requestBody: {
      requests: [{
        findReplace: {
          find,
          replacement: replace,
          matchCase: match_case ?? false,
          matchEntireCell: match_entire_cell ?? false,
          searchByRegex: search_by_regex ?? false,
          allSheets: !sheet_name,
          ...(sheet_name ? { range } : {}),
        },
      }],
    },
  });
  const fr = res.data.replies?.[0]?.findReplace;
  return { content: [{ type: "text", text: JSON.stringify({ occurrences_changed: fr?.occurrencesChanged ?? 0 }) }] };
});

mcp.registerTool("freeze", {
  description: "Congela linhas e/ou colunas em uma aba. Use frozen_rows=0 e frozen_columns=0 para descongelar.",
  inputSchema: {
    spreadsheet_id: z.string(),
    sheet_name: z.string(),
    frozen_rows: z.coerce.number().optional(),
    frozen_columns: z.coerce.number().optional(),
  },
}, async ({ spreadsheet_id: _sid, sheet_name, frozen_rows, frozen_columns }) => { const spreadsheet_id = parseSpreadsheetId(_sid);
  const sheetId = await getSheetId(spreadsheet_id, sheet_name);
  const gridProperties: Record<string, number> = {};
  const fields: string[] = [];
  if (frozen_rows !== undefined) { gridProperties.frozenRowCount = frozen_rows; fields.push("gridProperties.frozenRowCount"); }
  if (frozen_columns !== undefined) { gridProperties.frozenColumnCount = frozen_columns; fields.push("gridProperties.frozenColumnCount"); }
  if (!fields.length) throw new Error("Informe frozen_rows e/ou frozen_columns.");
  await sheets().spreadsheets.batchUpdate({
    spreadsheetId: spreadsheet_id,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: { sheetId, gridProperties },
          fields: fields.join(","),
        },
      }],
    },
  });
  return { content: [{ type: "text", text: `Congelamento aplicado na aba '${sheet_name}'.` }] };
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch(console.error);
