import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { upsertClient, getClient, listClients, addInvoice, getClientInvoices, addPayment, getClientPayments, getClientBalance, getAllBalances, getRevenueReport, addExpense, calculatePartnerSettlement } from "./db.js";
import { rsCreateWaybill, rsLookupTin } from "./rsge.js";

const server = new Server({ name: "rsge-microzelen", version: "2.0.0" }, { capabilities: { tools: {} } });

function today() { return new Date().toISOString().split("T")[0]; }
function fmtBal(bal: any) {
  if (bal.balance > 0) return `Долг: ${bal.balance.toFixed(2)} GEL`;
  if (bal.balance < 0) return `Переплата: ${Math.abs(bal.balance).toFixed(2)} GEL`;
  return "Расчёт закрыт ✅";
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "add_client", description: "Добавить клиента", inputSchema: { type: "object", properties: { name: { type: "string" }, tin: { type: "string" }, type: { type: "string", enum: ["horeca","private","wholesale"] }, phone: { type: "string" } }, required: ["name"] } },
  { name: "list_clients", description: "Список всех клиентов с балансами", inputSchema: { type: "object", properties: {} } },
  { name: "create_invoice", description: "Создать накладную клиенту на микрозелень", inputSchema: { type: "object", properties: { client_name: { type: "string" }, items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, quantity: { type: "number" }, price: { type: "number" } }, required: ["name","quantity","price"] } }, date: { type: "string" }, notes: { type: "string" } }, required: ["client_name","items"] } },
  { name: "record_payment", description: "Записать оплату от клиента", inputSchema: { type: "object", properties: { client_name: { type: "string" }, amount_gel: { type: "number" }, date: { type: "string" }, method: { type: "string", enum: ["transfer","cash","card"] }, notes: { type: "string" } }, required: ["client_name","amount_gel"] } },
  { name: "get_client_balance", description: "Баланс и акт сверки клиента", inputSchema: { type: "object", properties: { client_name: { type: "string" }, date_from: { type: "string" }, date_to: { type: "string" } }, required: ["client_name"] } },
  { name: "get_all_balances", description: "Долги всех клиентов", inputSchema: { type: "object", properties: {} } },
  { name: "revenue_report", description: "Отчёт по выручке за период", inputSchema: { type: "object", properties: { date_from: { type: "string" }, date_to: { type: "string" } }, required: ["date_from","date_to"] } },
  { name: "add_expense", description: "Записать расход", inputSchema: { type: "object", properties: { description: { type: "string" }, amount_gel: { type: "number" }, category: { type: "string", enum: ["seeds","substrate","packaging","delivery","other"] }, date: { type: "string" } }, required: ["description","amount_gel","category"] } },
  { name: "partner_settlement", description: "Расчёт с Натальей Шевченко", inputSchema: { type: "object", properties: { date_from: { type: "string" }, date_to: { type: "string" }, natalia_share_pct: { type: "number" } }, required: ["date_from","date_to"] } },
  { name: "lookup_tin", description: "Найти компанию по ИНН в rs.ge", inputSchema: { type: "object", properties: { tin: { type: "string" } }, required: ["tin"] } },
]}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs || {}) as Record<string, any>;
  try {
    let result: any;
    if (name === "add_client") {
      const c = upsertClient(args.name, args.tin, args.type || "horeca", args.phone);
      result = { success: true, client: c, message: `✅ Клиент "${args.name}" добавлен` };
    } else if (name === "list_clients") {
      const clients = listClients().map(c => ({ ...c, ...getClientBalance(c.id) })).filter(c => true);
      result = { clients: clients.map(c => ({ name: c.name, type: c.type, tin: c.tin, balance: fmtBal(c) })) };
    } else if (name === "create_invoice") {
      const client = getClient(args.client_name);
      if (!client) throw new Error(`Клиент "${args.client_name}" не найден`);
      const date = args.date || today();
      const total = args.items.reduce((s: number, i: any) => s + i.quantity * i.price, 0);
      let rsId: string | undefined;
      if (process.env.RS_SERVICE_USER && process.env.RS_SERVICE_PASSWORD && client.tin) {
        try { rsId = await rsCreateWaybill(client.tin, client.name, args.items, date); } catch (e: any) { console.error("rs.ge:", e.message); }
      }
      const inv = addInvoice(client.id, date
