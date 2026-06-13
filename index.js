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
