const axios = require("axios");
const xml2js = require("xml2js");
const fs = require("fs");
const http = require("http");

const DATA_FILE = process.env.DB_PATH || "./data.json";
const SELLER_TIN = process.env.SELLER_TIN || "345685902";
const API_KEY = process.env.API_KEY || "";
const WSDL = "https://services.rs.ge/WayBillService/WayBillService.asmx";

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { clients: {}, invoices: [], payments: [], expenses: [] }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
function today() { return new Date().toISOString().split("T")[0]; }
function fmt(b) {
  if (b > 0) return `Долг: ${b.toFixed(2)} GEL`;
  if (b < 0) return `Переплата: ${Math.abs(b).toFixed(2)} GEL`;
  return "Закрыт ✅";
}
function getBalance(data, clientId) {
  const inv = data.invoices.filter(i => i.clientId === clientId && i.status !== "cancelled").reduce((s, i) => s + i.total, 0);
  const paid = data.payments.filter(p => p.clientId === clientId).reduce((s, p) => s + p.amount, 0);
  return { invoiced: inv, paid, balance: inv - paid };
}
async function soapCall(action, bodyXml) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:rs="http://tempuri.org/"><soap:Body>${bodyXml}</soap:Body></soap:Envelope>`;
  const r = await axios.post(WSDL, envelope, { headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": `http://tempuri.org/${action}` }, timeout: 30000 });
  const parsed = await xml2js.parseStringPromise(r.data, { explicitArray: false });
  return parsed["soap:Envelope"]["soap:Body"];
}

const TOOLS = [
  { name: "add_client", description: "Добавить клиента (horeca/private/wholesale)", input_schema: { type: "object", properties: { name: { type: "string" }, tin: { type: "string" }, type: { type: "string" }, phone: { type: "string" } }, required: ["name"] } },
  { name: "list_clients", description: "Список всех клиентов с балансами", input_schema: { type: "object", properties: {} } },
  { name: "create_invoice", description: "Создать накладную клиенту", input_schema: { type: "object", properties: { client_name: { type: "string" }, items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, quantity: { type: "number" }, price: { type: "number" } }, required: ["name", "quantity", "price"] } }, date: { type: "string" } }, required: ["client_name", "items"] } },
  { name: "record_payment", description: "Записать оплату от клиента", input_schema: { type: "object", properties: { client_name: { type: "string" }, amount_gel: { type: "number" }, date: { type: "string" }, method: { type: "string" } }, required: ["client_name", "amount_gel"] } },
  { name: "get_client_balance", description: "Баланс и акт сверки клиента", input_schema: { type: "object", properties: { client_name: { type: "string" } }, required: ["client_name"] } },
  { name: "get_all_balances", description: "Долги всех клиентов", input_schema: { type: "object", properties: {} } },
  { name: "revenue_report", description: "Выручка за период", input_schema: { type: "object", properties: { date_from: { type: "string" }, date_to: { type: "string" } }, required: ["date_from", "date_to"] } },
  { name: "add_expense", description: "Записать расход", input_schema: { type: "object", properties: { description: { type: "string" }, amount_gel: { type: "number" }, category: { type: "string" }, date: { type: "string" } }, required: ["description", "amount_gel", "category"] } },
  { name: "partner_settlement", description: "Расчёт с Натальей Шевченко", input_schema: { type: "object", properties: { date_from: { type: "string" }, date_to: { type: "string" } }, required: ["date_from", "date_to"] } },
  { name: "tax_monthly", description: "Налог за месяц 1%", input_schema: { type: "object", properties: { year: { type: "number" }, month: { type: "number" } }, required: ["year", "month"] } },
  { name: "check_rs_connection", description: "Проверить IP-адрес сервера для rs.ge (what_is_my_ip)", input_schema: { type: "object", properties: {} } },
  { name: "get_company_by_tin", description: "Узнать название компании по ИНН через rs.ge", input_schema: { type: "object", properties: { tin: { type: "string" } }, required: ["tin"] } },
  { name: "verify_rs_credentials", description: "Проверить логин/пароль служебного пользователя rs.ge", input_schema: { type: "object", properties: {} } },
  { name: "create_service_user", description: "Создать нового служебного пользователя rs.ge (su/sp) для программного доступа к API. Требует основной логин/пароль от rs.ge.", input_schema: { type: "object", properties: { rs_username: { type: "string" }, rs_password: { type: "string" }, ip: { type: "string" }, new_su: { type: "string" }, new_sp: { type: "string" }, description: { type: "string" } }, required: ["rs_username", "rs_password", "ip", "new_su", "new_sp"] } },
];

async function executeTool(name, args) {
  args = args || {};
  const data = loadData();
  let result;
  if (name === "add_client") {
    const id = args.tin || args.name.toLowerCase().replace(/\s/g, "_");
    data.clients[id] = { id, name: args.name, tin: args.tin || null, type: args.type || "horeca", phone: args.phone || null };
    saveData(data);
    result = { success: true, message: `✅ Клиент "${args.name}" добавлен` };
  } else if (name === "list_clients") {
    const list = Object.values(data.clients).map(c => { const b = getBalance(data, c.id); return { ...c, balanceStr: fmt(b.balance) }; });
    result = { clients: list, total: list.length };
  } else if (name === "create_invoice") {
    const client = Object.values(data.clients).find(c => c.name.toLowerCase().includes(args.client_name.toLowerCase()) || c.tin === args.client_name);
    if (!client) throw new Error(`Клиент "${args.client_name}" не найден`);
    const total = args.items.reduce((s, i) => s + i.quantity * i.price, 0);
    const inv = { id: Date.now(), clientId: client.id, client: client.name, date: args.date || today(), items: args.items, total, status: "active" };
    data.invoices.push(inv);
    saveData(data);
    const bal = getBalance(data, client.id);
    result = { success: true, invoice_id: inv.id, client: client.name, total_gel: total, date: inv.date, balance: fmt(bal.balance), message: `✅ Накладная создана. Сумма: ${total} GEL. ${fmt(bal.balance)}` };
  } else if (name === "record_payment") {
    const client = Object.values(data.clients).find(c => c.name.toLowerCase().includes(args.client_name.toLowerCase()));
    if (!client) throw new Error(`Клиент "${args.client_name}" не найден`);
    const p = { id: Date.now(), clientId: client.id, client: client.name, amount: args.amount_gel, date: args.date || today(), method: args.method || "transfer" };
    data.payments.push(p);
    saveData(data);
    const bal = getBalance(data, client.id);
    result = { success: true, client: client.name, amount: args.amount_gel, balance: fmt(bal.balance), message: `✅ Оплата ${args.amount_gel} GEL записана. ${fmt(bal.balance)}` };
  } else if (name === "get_client_balance") {
    const client = Object.values(data.clients).find(c => c.name.toLowerCase().includes(args.client_name.toLowerCase()));
    if (!client) throw new Error(`Клиент "${args.client_name}" не найден`);
    const bal = getBalance(data, client.id);
    const invs = data.invoices.filter(i => i.clientId === client.id);
    const pays = data.payments.filter(p => p.clientId === client.id);
    const lines = [`📋 АКТ СВЕРКИ — ${client.name}`, `${"─".repeat(35)}`, `НАКЛАДНЫЕ:`, ...invs.map(i => `  ${i.date}  ${i.total} GEL`), `Итого: ${bal.invoiced.toFixed(2)} GEL`, ``, `ОПЛАТЫ:`, ...pays.map(p => `  ${p.date}  ${p.amount} GEL`), `Итого: ${bal.paid.toFixed(2)} GEL`, `${"─".repeat(35)}`, `БАЛАНС: ${fmt(bal.balance)}`];
    result = { client: client.name, balanceStr: fmt(bal.balance), reconciliation: lines.join("\n") };
  } else if (name === "get_all_balances") {
    const all = Object.values(data.clients).map(c => { const b = getBalance(data, c.id); return { name: c.name, type: c.type, balance: fmt(b.balance), debt: b.balance }; }).filter(c => c.debt !== 0);
    const total = all.filter(c => c.debt > 0).reduce((s, c) => s + c.debt, 0);
    result = { clients: all, totalDebt: `${total.toFixed(2)} GEL` };
  } else if (name === "revenue_report") {
    const invs = data.invoices.filter(i => i.date >= args.date_from && i.date <= args.date_to && i.status !== "cancelled");
    const revenue = invs.reduce((s, i) => s + i.total, 0);
    const lotki = invs.reduce((s, i) => s + i.items.reduce((ss, it) => ss + it.quantity, 0), 0);
    const pays = data.payments.filter(p => p.date >= args.date_from && p.date <= args.date_to).reduce((s, p) => s + p.amount, 0);
    result = { revenue: revenue.toFixed(2), paid: pays.toFixed(2), lotki, message: `📊 Выручка: ${revenue.toFixed(2)} GEL | Оплачено: ${pays.toFixed(2)} GEL | Лотков: ${lotki}` };
  } else if (name === "add_expense") {
    const exp = { id: Date.now(), date: args.date || today(), category: args.category, description: args.description, amount: args.amount_gel };
    data.expenses.push(exp);
    saveData(data);
    result = { success: true, message: `✅ Расход ${args.amount_gel} GEL: ${args.description}` };
  } else if (name === "partner_settlement") {
    const invs = data.invoices.filter(i => i.date >= args.date_from && i.date <= args.date_to && i.status !== "cancelled");
    const revenue = invs.reduce((s, i) => s + i.total, 0);
    const expenses = data.expenses.filter(e => e.date >= args.date_from && e.date <= args.date_to).reduce((s, e) => s + e.amount, 0);
    const net = revenue - expenses;
    result = { revenue: revenue.toFixed(2), expenses: expenses.toFixed(2), net: net.toFixed(2), natalia: (net * 0.5).toFixed(2), sergei: (net * 0.5).toFixed(2), message: `💼 Выручка: ${revenue.toFixed(2)} | Расходы: ${expenses.toFixed(2)} | Чистая: ${net.toFixed(2)} | Наталья: ${(net * 0.5).toFixed(2)} | Сергей: ${(net * 0.5).toFixed(2)}` };
  } else if (name === "tax_monthly") {
    const df = `${args.year}-${String(args.month).padStart(2, "0")}-01`;
    const dt = `${args.year}-${String(args.month).padStart(2, "0")}-${new Date(args.year, args.month, 0).getDate()}`;
    const revenue = data.invoices.filter(i => i.date >= df && i.date <= dt && i.status !== "cancelled").reduce((s, i) => s + i.total, 0);
    const tax = Math.round(revenue * 0.01 * 100) / 100;
    result = { turnover: revenue.toFixed(2), tax: tax.toFixed(2), message: `📋 Налог ${args.month}/${args.year}: оборот ${revenue.toFixed(2)} GEL → налог ${tax.toFixed(2)} GEL` };
  } else if (name === "check_rs_connection") {
    try {
      const su = (process.env.RS_SERVICE_USER || "").split(":")[0];
      const sp = process.env.RS_SERVICE_PASSWORD || "";
      const body = await soapCall("what_is_my_ip", `<what_is_my_ip xmlns="http://tempuri.org/"><su>${su}</su><sp>${sp}</sp></what_is_my_ip>`);
      const ip = body?.["what_is_my_ipResponse"]?.["what_is_my_ipResult"];
      result = { success: true, ip, message: `🌐 IP сервера: ${ip}. Этот IP должен быть в белом списке служебного пользователя rs.ge.` };
    } catch (e) {
      result = { error: `Ошибка подключения к rs.ge: ${e.message}` };
    }
  } else if (name === "get_company_by_tin") {
    try {
      const su = (process.env.RS_SERVICE_USER || "").split(":")[0];
      const sp = process.env.RS_SERVICE_PASSWORD || "";
      const body = await soapCall("get_name_from_tin", `<get_name_from_tin xmlns="http://tempuri.org/"><su>${su}</su><sp>${sp}</sp><tin>${args.tin}</tin></get_name_from_tin>`);
      const companyName = body?.["get_name_from_tinResponse"]?.["get_name_from_tinResult"];
      result = { success: true, tin: args.tin, name: companyName, message: `🏢 ИНН ${args.tin}: ${companyName || "не найдено"}` };
    } catch (e) {
      result = { error: `Ошибка запроса к rs.ge: ${e.message}` };
    }
  } else if (name === "verify_rs_credentials") {
    try {
      const [su, sp_user] = (process.env.RS_SERVICE_USER || "").split(":");
      const sp = process.env.RS_SERVICE_PASSWORD || "";
      const body = await soapCall("get_service_users", `<get_service_users xmlns="http://tempuri.org/"><su>${su}:${sp_user}</su><sp>${sp}</sp></get_service_users>`);
      result = { success: true, raw: body, message: `✅ Учётные данные приняты сервером rs.ge` };
    } catch (e) {
      result = { error: `Ошибка проверки учётных данных: ${e.message}` };
    }
  } else if (name === "create_service_user") {
    try {
      const bodyXml = `<create_service_user xmlns="http://tempuri.org/"><username>${args.rs_username}</username><password>${args.rs_password}</password><ip>${args.ip}</ip><name>${args.description || "Microzelen Railway Service"}</name><su>${args.new_su}</su><sp>${args.new_sp}</sp></create_service_user>`;
      const body = await soapCall("create_service_user", bodyXml);
      const response = body?.["create_service_userResponse"]?.["create_service_userResult"];
      result = { success: true, raw: response, new_su: args.new_su, message: `Результат: ${JSON.stringify(response)}` };
    } catch (e) {
      result = { error: `Ошибка создания служебного пользователя: ${e.message}` };
    }
  } else if (name === "debug_wsdl") {
    try {
      const response = await axios.get(`${WSDL}?wsdl`, { timeout: 30000 });
      const parsed = await xml2js.parseStringPromise(response.data, { explicitArray: false });
      const methods = [];
      function findOperations(obj) {
        if (!obj || typeof obj !== "object") return;
        for (const key in obj) {
          if (key.endsWith("operation") || key === "wsdl:operation") {
            const ops = Array.isArray(obj[key]) ? obj[key] : [obj[key]];
            for (const op of ops) {
              if (op && op.$ && op.$.name) methods.push(op.$.name);
            }
          } else if (typeof obj[key] === "object") {
            findOperations(obj[key]);
          }
        }
      }
      findOperations(parsed);
      result = { wsdlUrl: `${WSDL}?wsdl`, availableMethods: [...new Set(methods)] };
    } catch (e) {
      result = { error: e.message };
    }
  } else {
    throw new Error(`Неизвестный инструмент: ${name}`);
  }
  return result;
}

function checkAuth(req) {
  if (!API_KEY) return true;
  const auth = req.headers["authorization"] || "";
  return auth === `Bearer ${API_KEY}`;
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(body, null, 2));
}

const PORT = process.env.PORT || 8080;
http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { send(res, 200, {}); return; }

  if (req.method === "GET" && req.url === "/debug-wsdl") {
    try {
      const result = await executeTool("debug_wsdl", {});
      send(res, 200, result);
    } catch (e) {
      send(res, 500, { error: e.message });
    }
    return;
  }

  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Microzelen MCP Server OK");
    return;
  }

  if (req.url === "/tools" && req.method === "GET") {
    send(res, 200, { tools: TOOLS });
    return;
  }

  if (req.url === "/execute" && req.method === "POST") {
    if (!checkAuth(req)) { send(res, 401, { error: "Unauthorized" }); return; }
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { name, arguments: args } = JSON.parse(body || "{}");
        const result = await executeTool(name, args);
        send(res, 200, { result });
      } catch (e) {
        send(res, 200, { error: e.message });
      }
    });
    return;
  }

  send(res, 404, { error: "Not found" });
}).listen(PORT, () => console.error(`Server on port ${PORT}`));
