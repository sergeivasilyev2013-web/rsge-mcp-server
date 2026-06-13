import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { upsertClient, getClient, listClients, addInvoice, getClientInvoices, addPayment, getClientPayments, getClientBalance, getRevenueReport, getAllBalances, addExpense, calculatePartnerSettlement } from "./db.js";
import { rsCreateWaybill, rsLookupTin } from "./rsge.js";

function today() { return new Date().toISOString().split("T")[0]; }

function fmt(bal: { invoiced: number; paid: number; balance: number }) {
  if (bal.balance > 0) return `Долг: ${bal.balance.toFixed(2)} GEL`;
  if (bal.balance < 0) return `Переплата: ${Math.abs(bal.balance).toFixed(2)} GEL`;
  return "Расчёт закрыт";
}

const server = new Server(
  { name: "rsge-microzelen", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "add_client", description: "Добавить клиента", inputSchema: { type: "object", properties: { name: { type: "string" }, tin: { type: "string" }, type: { type: "string" }, phone: { type: "string" } }, required: ["name"] } },
    { name: "list_clients", description: "Список клиентов с балансами", inputSchema: { type: "object", properties: {} } },
    { name: "create_invoice", description: "Создать накладную и отправить в rs.ge", inputSchema: { type: "object", properties: { client_name: { type: "string" }, items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, quantity: { type: "number" }, price: { type: "number" } }, required: ["name", "quantity", "price"] } }, date: { type: "string" }, notes: { type: "string" } }, required: ["client_name", "items"] } },
    { name: "get_client_invoices", description: "Накладные клиента", inputSchema: { type: "object", properties: { client_name: { type: "string" }, date_from: { type: "string" }, date_to: { type: "string" } }, required: ["client_name"] } },
    { name: "record_payment", description: "Записать оплату от клиента", inputSchema: { type: "object", properties: { client_name: { type: "string" }, amount_gel: { type: "number" }, date: { type: "string" }, method: { type: "string" }, notes: { type: "string" } }, required: ["client_name", "amount_gel"] } },
    { name: "get_client_balance", description: "Баланс и акт сверки клиента", inputSchema: { type: "object", properties: { client_name: { type: "string" }, date_from: { type: "string" }, date_to: { type: "string" } }, required: ["client_name"] } },
    { name: "get_all_balances", description: "Долги всех клиентов", inputSchema: { type: "object", properties: {} } },
    { name: "revenue_report", description: "Выручка за период", inputSchema: { type: "object", properties: { date_from: { type: "string" }, date_to: { type: "string" } }, required: ["date_from", "date_to"] } },
    { name: "add_expense", description: "Записать расход", inputSchema: { type: "object", properties: { description: { type: "string" }, amount_gel: { type: "number" }, category: { type: "string" }, date: { type: "string" } }, required: ["description", "amount_gel", "category"] } },
    { name: "partner_settlement", description: "Расчёт с Натальей Шевченко", inputSchema: { type: "object", properties: { date_from: { type: "string" }, date_to: { type: "string" }, natalia_share_pct: { type: "number" } }, required: ["date_from", "date_to"] } },
    { name: "tax_monthly", description: "Налог за месяц 1%", inputSchema: { type: "object", properties: { year: { type: "number" }, month: { type: "number" } }, required: ["year", "month"] } },
    { name: "lookup_tin", description: "Найти компанию по ИНН", inputSchema: { type: "object", properties: { tin: { type: "string" } }, required: ["tin"] } }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const a = (rawArgs || {}) as Record<string, any>;
  try {
    let result: any;
    if (name === "add_client") {
      const c = upsertClient(a.name, a.tin, a.type || "horeca", a.phone);
      result = { success: true, client: c, message: `Клиент "${a.name}" добавлен` };
    } else if (name === "list_clients") {
      const clients = listClients().map((c) => {
        const bal = getClientBalance(c.id);
        return { ...c, balanceStr: fmt(bal) };
      });
      result = { clients, total: clients.length };
    } else if (name === "create_invoice") {
      const client = getClient(a.client_name);
      if (!client) throw new Error(`Клиент "${a.client_name}" не найден`);
      const total = a.items.reduce((s: number, i: any) => s + i.quantity * i.price, 0);
      const date = a.date || today();
      let rsId: string | undefined;
      if (process.env.RS_SERVICE_USER && process.env.RS_SERVICE_PASSWORD && client.tin) {
        try { rsId = await rsCreateWaybill(client.tin, client.name, a.items, date); } catch (e: any) { console.error("rs.ge:", e.message); }
      }
      const inv = addInvoice(client.id, date, a.items, total, rsId, a.notes);
      const bal = getClientBalance(client.id);
      result = { success: true, invoice_id: inv.id, rs_waybill_id: rsId || "локально", client: client.name, total_gel: total, date, message: `Накладная #${inv.id} создана. ${total} GEL. ${fmt(bal)}` };
    } else if (name === "get_client_invoices") {
      const client = getClient(a.client_name);
      if (!client) throw new Error(`Клиент "${a.client_name}" не найден`);
      result = { client: client.name, invoices: getClientInvoices(client.id, a.date_from, a.date_to) };
    } else if (name === "record_payment") {
      const client = getClient(a.client_name);
      if (!client) throw new Error(`Клиент "${a.client_name}" не найден`);
      const p = addPayment(client.id, a.amount_gel, a.date || today(), a.method || "transfer", a.notes);
      const bal = getClientBalance(client.id);
      result = { success: true, payment_id: p.id, client: client.name, amount: a.amount_gel, message: `Оплата ${a.amount_gel} GEL от "${client.name}". ${fmt(bal)}` };
    } else if (name === "get_client_balance") {
      const client = getClient(a.client_name);
      if (!client) throw new Error(`Клиент "${a.client_name}" не найден`);
      const bal = getClientBalance(client.id);
      const invoices = getClientInvoices(client.id, a.date_from, a.date_to);
      const payments = getClientPayments(client.id, a.date_from, a.date_to);
      const lines = [
        `АКТ СВЕРКИ — ${client.name}`,
        `НАКЛАДНЫЕ:`,
        ...invoices.map((i: any) => `  ${i.date}  #${i.id}  ${i.total_gel} GEL`),
        `Итого выставлено: ${bal.invoiced.toFixed(2)} GEL`,
        `ОПЛАТЫ:`,
        ...payments.map((p: any) => `  ${p.date}  ${p.amount_gel} GEL`),
        `Итого оплачено: ${bal.paid.toFixed(2)} GEL`,
        `БАЛАНС: ${fmt(bal)}`
      ];
      result = { client: client.name, balanceStr: fmt(bal), reconciliation: lines.join("\n") };
    } else if (name === "get_all_balances") {
      const all = getAllBalances();
      const totalDebt = all.filter((c) => c.balance > 0).reduce((s, c) => s + c.balance, 0);
      result = { clients: all.map((c) => ({ name: c.name, type: c.type, balanceStr: fmt(c) })), totalDebt: `${totalDebt.toFixed(2)} GEL` };
    } else if (name === "revenue_report") {
      const rep = getRevenueReport(a.date_from, a.date_to);
      result = { ...rep, message: `Выручка: ${rep.revenue.toFixed(2)} GEL | Оплачено: ${rep.payments.toFixed(2)} GEL | Лотков: ${rep.totalLotki}` };
    } else if (name === "add_expense") {
      const exp = addExpense(a.date || today(), a.category, a.description, a.amount_gel);
      result = { success: true, expense: exp, message: `Расход ${a.amount_gel} GEL: ${a.description}` };
    } else if (name === "partner_settlement") {
      const s = calculatePartnerSettlement(a.date_from, a.date_to, a.natalia_share_pct || 50);
      result = { ...s, message: `Выручка: ${s.grossRevenue.toFixed(2)} GEL | Наталья: ${s.nataliaShare.toFixed(2)} GEL | Сергей: ${s.sergeiShare.toFixed(2)} GEL` };
    } else if (name === "tax_monthly") {
      const dateFrom = `${a.year}-${String(a.month).padStart(2, "0")}-01`;
      const lastDay = new Date(a.year, a.month, 0).getDate();
      const dateTo = `${a.year}-${String(a.month).padStart(2, "0")}-${lastDay}`;
      const { revenue } = getRevenueReport(dateFrom, dateTo);
      const tax = Math.round(revenue * 0.01 * 100) / 100;
      result = { year: a.year, month: a.month, turnover: revenue, taxAmount: tax, message: `Налог за ${a.month}/${a.year}: оборот ${revenue.toFixed(2)} GEL → налог ${tax.toFixed(2)} GEL` };
    } else if (name === "lookup_tin") {
      const n = await rsLookupTin(a.tin);
      result = { tin: a.tin, name: n || "Не найдено" };
    } else {
      throw new Error(`Неизвестный инструмент: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error: any) {
    return { content: [{ type: "text", text: `Ошибка: ${error.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Microzelen MCP Server v2.0 запущен");
}

main().catch(console.error);
