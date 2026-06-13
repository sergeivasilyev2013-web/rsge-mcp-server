const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const axios = require("axios");
const xml2js = require("xml2js");
const fs = require("fs");
const path = require("path");

const DATA_FILE = process.env.DB_PATH || "./data.json";
const SELLER_TIN = process.env.SELLER_TIN || "345685902";
const WSDL = "http://services.rs.ge/WayBillService/WayBillService.asmx";

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE,"utf8")); }
  catch { return { clients:{}, invoices:[], payments:[], expenses:[] }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); }
function today() { return new Date().toISOString().split("T")[0]; }
function fmt(b) {
  if(b>0) return `Долг: ${b.toFixed(2)} GEL`;
  if(b<0) return `Переплата: ${Math.abs(b).toFixed(2)} GEL`;
  return "Закрыт ✅";
}
function getBalance(data, clientId) {
  const inv = data.invoices.filter(i=>i.clientId===clientId&&i.status!=="cancelled").reduce((s,i)=>s+i.total,0);
  const paid = data.payments.filter(p=>p.clientId===clientId).reduce((s,p)=>s+p.amount,0);
  return { invoiced:inv, paid, balance:inv-paid };
}
async function soapCall(action, bodyXml) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:rs="http://tempuri.org/"><soap:Body>${bodyXml}</soap:Body></soap:Envelope>`;
  const r = await axios.post(WSDL, envelope, { headers:{"Content-Type":"text/xml; charset=utf-8","SOAPAction":`http://tempuri.org/${action}`}, timeout:30000 });
  const parsed = await xml2js.parseStringPromise(r.data, {explicitArray:false});
  return parsed["soap:Envelope"]["soap:Body"];
}

const server = new Server({name:"rsge-microzelen",version:"1.0.0"},{capabilities:{tools:{}}});

server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[
  {name:"add_client",description:"Добавить клиента (horeca/private/wholesale)",inputSchema:{type:"object",properties:{name:{type:"string"},tin:{type:"string"},type:{type:"string"},phone:{type:"string"}},required:["name"]}},
  {name:"list_clients",description:"Список всех клиентов с балансами",inputSchema:{type:"object",properties:{}}},
  {name:"create_invoice",description:"Создать накладную клиенту",inputSchema:{type:"object",properties:{client_name:{type:"string"},items:{type:"array",items:{type:"object",properties:{name:{type:"string"},quantity:{type:"number"},price:{type:"number"}},required:["name","quantity","price"]}},date:{type:"string"}},required:["client_name","items"]}},
  {name:"record_payment",description:"Записать оплату от клиента",inputSchema:{type:"object",properties:{client_name:{type:"string"},amount_gel:{type:"number"},date:{type:"string"},method:{type:"string"}},required:["client_name","amount_gel"]}},
  {name:"get_client_balance",description:"Баланс и акт сверки клиента",inputSchema:{type:"object",properties:{client_name:{type:"string"}},required:["client_name"]}},
  {name:"get_all_balances",description:"Долги всех клиентов",inputSchema:{type:"object",properties:{}}},
  {name:"revenue_report",description:"Выручка за период",inputSchema:{type:"object",properties:{date_from:{type:"string"},date_to:{type:"string"}},required:["date_from","date_to"]}},
  {name:"add_expense",description:"Записать расход",inputSchema:{type:"object",properties:{description:{type:"string"},amount_gel:{type:"number"},category:{type:"string"},date:{type:"string"}},required:["description","amount_gel","category"]}},
  {name:"partner_settlement",description:"Расчёт с Натальей Шевченко",inputSchema:{type:"object",properties:{date_from:{type:"string"},date_to:{type:"string"}},required:["date_from","date_to"]}},
  {name:"tax_monthly",description:"Налог за месяц 1%",inputSchema:{type:"object",properties:{year:{type:"number"},month:{type:"number"}},required:["year","month"]}},
]}));
server.setRequestHandler(CallToolRequestSchema, async(request)=>{
  const {name, arguments:a} = request.params;
  const args = a||{};
  try {
    let result;
    const data = loadData();
    if(name==="add_client") {
      const id = args.tin || args.name.toLowerCase().replace(/\s/g,"_");
      data.clients[id] = {id, name:args.name, tin:args.tin||null, type:args.type||"horeca", phone:args.phone||null};
      saveData(data);
      result = {success:true, message:`✅ Клиент "${args.name}" добавлен`};
    } else if(name==="list_clients") {
      const list = Object.values(data.clients).map(c=>{const b=getBalance(data,c.id);return {...c,balanceStr:fmt(b.balance)};});
      result = {clients:list, total:list.length};
    } else if(name==="create_invoice") {
      const client = Object.values(data.clients).find(c=>c.name.toLowerCase().includes(args.client_name.toLowerCase())||c.tin===args.client_name);
      if(!client) throw new Error(`Клиент "${args.client_name}" не найден`);
      const total = args.items.reduce((s,i)=>s+i.quantity*i.price,0);
      const inv = {id:Date.now(), clientId:client.id, client:client.name, date:args.date||today(), items:args.items, total, status:"active"};
      data.invoices.push(inv);
      saveData(data);
      const bal = getBalance(data, client.id);
      result = {success:true, invoice_id:inv.id, client:client.name, total_gel:total, date:inv.date, balance:fmt(bal.balance), message:`✅ Накладная создана. Сумма: ${total} GEL. ${fmt(bal.balance)}`};
    } else if(name==="record_payment") {
      const client = Object.values(data.clients).find(c=>c.name.toLowerCase().includes(args.client_name.toLowerCase()));
      if(!client) throw new Error(`Клиент "${args.client_name}" не найден`);
      const p = {id:Date.now(), clientId:client.id, client:client.name, amount:args.amount_gel, date:args.date||today(), method:args.method||"transfer"};
      data.payments.push(p);
      saveData(data);
      const bal = getBalance(data, client.id);
      result = {success:true, client:client.name, amount:args.amount_gel, balance:fmt(bal.balance), message:`✅ Оплата ${args.amount_gel} GEL записана. ${fmt(bal.balance)}`};
    } else if(name==="get_client_balance") {
      const client = Object.values(data.clients).find(c=>c.name.toLowerCase().includes(args.client_name.toLowerCase()));
      if(!client) throw new Error(`Клиент "${args.client_name}" не найден`);
      const bal = getBalance(data, client.id);
      const invs = data.invoices.filter(i=>i.clientId===client.id);
      const pays = data.payments.filter(p=>p.clientId===client.id);
      const lines = [`📋 АКТ СВЕРКИ — ${client.name}`,`${"─".repeat(35)}`,`НАКЛАДНЫЕ:`, ...invs.map(i=>`  ${i.date}  ${i.total} GEL`),`Итого: ${bal.invoiced.toFixed(2)} GEL`,``,`ОПЛАТЫ:`, ...pays.map(p=>`  ${p.date}  ${p.amount} GEL`),`Итого: ${bal.paid.toFixed(2)} GEL`,`${"─".repeat(35)}`,`БАЛАНС: ${fmt(bal.balance)}`];
      result = {client:client.name, balanceStr:fmt(bal.balance), reconciliation:lines.join("\n")};
    } else if(name==="get_all_balances") {
      const all = Object.values(data.clients).map(c=>{const b=getBalance(data,c.id);return {name:c.name,type:c.type,balance:fmt(b.balance),debt:b.balance};}).filter(c=>c.debt!==0);
      const total = all.filter(c=>c.debt>0).reduce((s,c)=>s+c.debt,0);
      result = {clients:all, totalDebt:`${total.toFixed(2)} GEL`};
    } else if(name==="revenue_report") {
      const invs = data.invoices.filter(i=>i.date>=args.date_from&&i.date<=args.date_to&&i.status!=="cancelled");
      const revenue = invs.reduce((s,i)=>s+i.total,0);
      const lotki = invs.reduce((s,i)=>s+i.items.reduce((ss,it)=>ss+it.quantity,0),0);
      const pays = data.payments.filter(p=>p.date>=args.date_from&&p.date<=args.date_to).reduce((s,p)=>s+p.amount,0);
      result = {revenue:revenue.toFixed(2), paid:pays.toFixed(2), lotki, message:`📊 Выручка: ${revenue.toFixed(2)} GEL | Оплачено: ${pays.toFixed(2)} GEL | Лотков: ${lotki}`};
    } else if(name==="add_expense") {
      const exp = {id:Date.now(), date:args.date||today(), category:args.category, description:args.description, amount:args.amount_gel};
      data.expenses.push(exp);
      saveData(data);
      result = {success:true, message:`✅ Расход ${args.amount_gel} GEL: ${args.description}`};
    } else if(name==="partner_settlement") {
      const invs = data.invoices.filter(i=>i.date>=args.date_from&&i.date<=args.date_to&&i.status!=="cancelled");
      const revenue = invs.reduce((s,i)=>s+i.total,0);
      const expenses = data.expenses.filter(e=>e.date>=args.date_from&&e.date<=args.date_to).reduce((s,e)=>s+e.amount,0);
      const net = revenue-expenses;
      result = {revenue:revenue.toFixed(2), expenses:expenses.toFixed(2), net:net.toFixed(2), natalia:(net*0.5).toFixed(2), sergei:(net*0.5).toFixed(2), message:`💼 Выручка: ${revenue.toFixed(2)} | Расходы: ${expenses.toFixed(2)} | Чистая: ${net.toFixed(2)} | Наталья: ${(net*0.5).toFixed(2)} | Сергей: ${(net*0.5).toFixed(2)}`};
    } else if(name==="tax_monthly") {
      const df=`${args.year}-${String(args.month).padStart(2,"0")}-01`;
      const dt=`${args.year}-${String(args.month).padStart(2,"0")}-${new Date(args.year,args.month,0).getDate()}`;
      const revenue = data.invoices.filter(i=>i.date>=df&&i.date<=dt&&i.status!=="cancelled").reduce((s,i)=>s+i.total,0);
      const tax = Math.round(revenue*0.01*100)/100;
      result = {turnover:revenue.toFixed(2), tax:tax.toFixed(2), message:`📋 Налог ${args.month}/${args.year}: оборот ${revenue.toFixed(2)} GEL → налог ${tax.toFixed(2)} GEL`};
    }
    return {content:[{type:"text",text:JSON.stringify(result,null,2)}]};
  } catch(e) {
    return {content:[{type:"text",text:`❌ Ошибка: ${e.message}`}],isError:true};
  }
});

server.setRequestHandler(CallToolRequestSchema, async(request)=>{
  const {name, arguments:a} = request.params;
  const args = a||{};
  try {
    let result;
    const data = loadData();
    if(name==="add_client") {
      const id = args.tin || args.name.toLowerCase().replace(/\s/g,"_");
      data.clients[id] = {id, name:args.name, tin:args.tin||null, type:args.type||"horeca", phone:args.phone||null};
      saveData(data);
      result = {success:true, message:`✅ Клиент "${args.name}" добавлен`};
    } else if(name==="list_clients") {
      const list = Object.values(data.clients).map(c=>{const b=getBalance(data,c.id);return {...c,balanceStr:fmt(b.balance)};});
      result = {clients:list, total:list.length};
    } else if(name==="create_invoice") {
      const client = Object.values(data.clients).find(c=>c.name.toLowerCase().includes(args.client_name.toLowerCase())||c.tin===args.client_name);
      if(!client) throw new Error(`Клиент "${args.client_name}" не найден`);
      const total = args.items.reduce((s,i)=>s+i.quantity*i.price,0);
      const inv = {id:Date.now(), clientId:client.id, client:client.name, date:args.date||today(), items:args.items, total, status:"active"};
      data.invoices.push(inv);
      saveData(data);
      const bal = getBalance(data, client.id);
      result = {success:true, invoice_id:inv.id, client:client.name, total_gel:total, date:inv.date, balance:fmt(bal.balance), message:`✅ Накладная создана. Сумма: ${total} GEL. ${fmt(bal.balance)}`};
    } else if(name==="record_payment") {
      const client = Object.values(data.clients).find(c=>c.name.toLowerCase().includes(args.client_name.toLowerCase()));
      if(!client) throw new Error(`Клиент "${args.client_name}" не найден`);
      const p = {id:Date.now(), clientId:client.id, client:client.name, amount:args.amount_gel, date:args.date||today(), method:args.method||"transfer"};
      data.payments.push(p);
      saveData(data);
      const bal = getBalance(data, client.id);
      result = {success:true, client:client.name, amount:args.amount_gel, balance:fmt(bal.balance), message:`✅ Оплата ${args.amount_gel} GEL записана. ${fmt(bal.balance)}`};
    } else if(name==="get_client_balance") {
      const client = Object.values(data.clients).find(c=>c.name.toLowerCase().includes(args.client_name.toLowerCase()));
      if(!client) throw new Error(`Клиент "${args.client_name}" не найден`);
      const bal = getBalance(data, client.id);
      const invs = data.invoices.filter(i=>i.clientId===client.id);
      const pays = data.payments.filter(p=>p.clientId===client.id);
      const lines = [`📋 АКТ СВЕРКИ — ${client.name}`,`${"─".repeat(35)}`,`НАКЛАДНЫЕ:`, ...invs.map(i=>`  ${i.date}  ${i.total} GEL`),`Итого: ${bal.invoiced.toFixed(2)} GEL`,``,`ОПЛАТЫ:`, ...pays.map(p=>`  ${p.date}  ${p.amount} GEL`),`Итого: ${bal.paid.toFixed(2)} GEL`,`${"─".repeat(35)}`,`БАЛАНС: ${fmt(bal.balance)}`];
      result = {client:client.name, balanceStr:fmt(bal.balance), reconciliation:lines.join("\n")};
    } else if(name==="get_all_balances") {
      const all = Object.values(data.clients).map(c=>{const b=getBalance(data,c.id);return {name:c.name,type:c.type,balance:fmt(b.balance),debt:b.balance};}).filter(c=>c.debt!==0);
      const total = all.filter(c=>c.debt>0).reduce((s,c)=>s+c.debt,0);
      result = {clients:all, totalDebt:`${total.toFixed(2)} GEL`};
    } else if(name==="revenue_report") {
      const invs = data.invoices.filter(i=>i.date>=args.date_from&&i.date<=args.date_to&&i.status!=="cancelled");
      const revenue = invs.reduce((s,i)=>s+i.total,0);
      const lotki = invs.reduce((s,i)=>s+i.items.reduce((ss,it)=>ss+it.quantity,0),0);
      const pays = data.payments.filter(p=>p.date>=args.date_from&&p.date<=args.date_to).reduce((s,p)=>s+p.amount,0);
      result = {revenue:revenue.toFixed(2), paid:pays.toFixed(2), lotki, message:`📊 Выручка: ${revenue.toFixed(2)} GEL | Оплачено: ${pays.toFixed(2)} GEL | Лотков: ${lotki}`};
    } else if(name==="add_expense") {
      const exp = {id:Date.now(), date:args.date||today(), category:args.category, description:args.description, amount:args.amount_gel};
      data.expenses.push(exp);
      saveData(data);
      result = {success:true, message:`✅ Расход ${args.amount_gel} GEL: ${args.description}`};
    } else if(name==="partner_settlement") {
      const invs = data.invoices.filter(i=>i.date>=args.date_from&&i.date<=args.date_to&&i.status!=="cancelled");
      const revenue = invs.reduce((s,i)=>s+i.total,0);
      const expenses = data.expenses.filter(e=>e.date>=args.date_from&&e.date<=args.date_to).reduce((s,e)=>s+e.amount,0);
      const net = revenue-expenses;
      result = {revenue:revenue.toFixed(2), expenses:expenses.toFixed(2), net:net.toFixed(2), natalia:(net*0.5).toFixed(2), sergei:(net*0.5).toFixed(2), message:`💼 Выручка: ${revenue.toFixed(2)} | Расходы: ${expenses.toFixed(2)} | Чистая: ${net.toFixed(2)} | Наталья: ${(net*0.5).toFixed(2)} | Сергей: ${(net*0.5).toFixed(2)}`};
    } else if(name==="tax_monthly") {
      const df=`${args.year}-${String(args.month).padStart(2,"0")}-01`;
      const dt=`${args.year}-${String(args.month).padStart(2,"0")}-${new Date(args.year,args.month,0).getDate()}`;
      const revenue = data.invoices.filter(i=>i.date>=df&&i.date<=dt&&i.status!=="cancelled").reduce((s,i)=>s+i.total,0);
      const tax = Math.round(revenue*0.01*100)/100;
      result = {turnover:revenue.toFixed(2), tax:tax.toFixed(2), message:`📋 Налог ${args.month}/${args.year}: оборот ${revenue.toFixed(2)} GEL → налог ${tax.toFixed(2)} GEL`};
    }
    return {content:[{type:"text",text:JSON.stringify(result,null,2)}]};
  } catch(e) {
    return {content:[{type:"text",text:`❌ Ошибка: ${e.message}`}],isError:true};
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("✅ Microzelen MCP Server запущен");
}
main().catch(console.error);
