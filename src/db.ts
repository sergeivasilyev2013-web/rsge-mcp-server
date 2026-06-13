import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "microzelen.db");
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tin TEXT UNIQUE,
    type TEXT NOT NULL DEFAULT 'horeca',
    phone TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rs_waybill_id TEXT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    date TEXT NOT NULL,
    items TEXT NOT NULL,
    total_gel REAL NOT NULL,
    status TEXT DEFAULT 'active',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    amount_gel REAL NOT NULL,
    date TEXT NOT NULL,
    method TEXT DEFAULT 'transfer',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    amount_gel REAL NOT NULL,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tax_filings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    month INTEGER,
    type TEXT NOT NULL,
    turnover REAL,
    tax_paid REAL,
    filed_at TEXT DEFAULT (datetime('now')),
    notes TEXT
  );
`);

export function upsertClient(name: string, tin?: string, type = "horeca", phone?: string, notes?: string) {
  if (tin) {
    const existing = db.prepare("SELECT * FROM clients WHERE tin = ?").get(tin) as any;
    if (existing) {
      db.prepare("UPDATE clients SET name=?, type=?, phone=?, notes=? WHERE tin=?").run(name, type, phone || existing.phone, notes || existing.notes, tin);
      return db.prepare("SELECT * FROM clients WHERE tin = ?").get(tin);
    }
  }
  const r = db.prepare("INSERT INTO clients (name, tin, type, phone, notes) VALUES (?,?,?,?,?)").run(name, tin || null, type, phone || null, notes || null);
  return db.prepare("SELECT * FROM clients WHERE id = ?").get(r.lastInsertRowid);
}

export function getClient(nameOrTin: string) {
  return db.prepare("SELECT * FROM clients WHERE tin = ? OR LOWER(name) LIKE LOWER(?)").get(nameOrTin, `%${nameOrTin}%`) as any;
}

export function listClients() {
  return db.prepare("SELECT * FROM clients ORDER BY name").all() as any[];
}

export function addInvoice(clientId: number, date: string, items: any[], totalGel: number, rsWaybillId?: string, notes?: string) {
  const r = db.prepare("INSERT INTO invoices (client_id, date, items, total_gel, rs_waybill_id, notes) VALUES (?,?,?,?,?,?)").run(clientId, date, JSON.stringify(items), totalGel, rsWaybillId || null, notes || null);
  return db.prepare("SELECT * FROM invoices WHERE id = ?").get(r.lastInsertRowid) as any;
}

export function getClientInvoices(clientId: number, dateFrom?: string, dateTo?: string) {
  let sql = "SELECT * FROM invoices WHERE client_id = ?";
  const params: any[] = [clientId];
  if (dateFrom) { sql += " AND date >= ?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND date <= ?"; params.push(dateTo); }
  return db.prepare(sql + " ORDER BY date DESC").all(...params) as any[];
}

export function addPayment(clientId: number, amountGel: number, date: string, method = "transfer", notes?: string) {
  const r = db.prepare("INSERT INTO payments (client_id, amount_gel, date, method, notes) VALUES (?,?,?,?,?)").run(clientId, amountGel, date, method, notes || null);
  return db.prepare("SELECT * FROM payments WHERE id = ?").get(r.lastInsertRowid) as any;
}

export function getClientPayments(clientId: number, dateFrom?: string, dateTo?: string) {
  let sql = "SELECT * FROM payments WHERE client_id = ?";
  const params: any[] = [clientId];
  if (dateFrom) { sql += " AND date >= ?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND date <= ?"; params.push(dateTo); }
  return db.prepare(sql + " ORDER BY date DESC").all(...params) as any[];
}

export function getClientBalance(clientId: number) {
  const invoiced = (db.prepare("SELECT COALESCE(SUM(total_gel),0) as t FROM invoices WHERE client_id = ? AND status != 'cancelled'").get(clientId) as any).t;
  const paid = (db.prepare("SELECT COALESCE(SUM(amount_gel),0) as t FROM payments WHERE client_id = ?").get(clientId) as any).t;
  return { invoiced, paid, balance: invoiced - paid };
}

export function getRevenueReport(dateFrom: string, dateTo: string) {
  const revenue = (db.prepare("SELECT COALESCE(SUM(total_gel),0) as t FROM invoices WHERE date >= ? AND date <= ? AND status != 'cancelled'").get(dateFrom, dateTo) as any).t;
  const payments = (db.prepare("SELECT COALESCE(SUM(amount_gel),0) as t FROM payments WHERE date >= ? AND date <= ?").get(dateFrom, dateTo) as any).t;
  const rows = db.prepare("SELECT items FROM invoices WHERE date >= ? AND date <= ? AND status != 'cancelled'").all(dateFrom, dateTo) as any[];
  let totalLotki = 0;
  for (const row of rows) {
    try { for (const i of JSON.parse(row.items)) totalLotki += i.quantity || 0; } catch {}
  }
  return { revenue, payments, totalLotki, dateFrom, dateTo };
}

export function getAllBalances() {
  return listClients().map(c => ({ ...c, ...getClientBalance(c.id) })).filter(c => c.invoiced > 0 || c.paid > 0);
}

export function addExpense(date: string, category: string, description: string, amountGel: number, notes?: string) {
  const r = db.prepare("INSERT INTO expenses (date, category, description, amount_gel, notes) VALUES (?,?,?,?,?)").run(date, category, description, amountGel, notes || null);
  return db.prepare("SELECT * FROM expenses WHERE id = ?").get(r.lastInsertRowid) as any;
}

export function getExpenses(dateFrom?: string, dateTo?: string) {
  let sql = "SELECT * FROM expenses WHERE 1=1";
  const params: any[] = [];
  if (dateFrom) { sql += " AND date >= ?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND date <= ?"; params.push(dateTo); }
  return db.prepare(sql + " ORDER BY date DESC").all(...params) as any[];
}

export function calculatePartnerSettlement(dateFrom: string, dateTo: string, nataliaSharePct = 50) {
  const { revenue } = getRevenueReport(dateFrom, dateTo);
  const expenses = (db.prepare("SELECT COALESCE(SUM(amount_gel),0) as t FROM expenses WHERE date >= ? AND date <= ?").get(dateFrom, dateTo) as any).t;
  const net = revenue - expenses;
  return {
    period: `${dateFrom} — ${dateTo}`,
    grossRevenue: revenue,
    expenses,
    netProfit: net,
    nataliaSharePct,
    nataliaShare: net * nataliaSharePct / 100,
    sergeiShare: net * (100 - nataliaSharePct) / 100
  };
}
 
