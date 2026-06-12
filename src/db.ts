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
  return db.prepare("SELECT * FROM clients WHERE tin = ? OR LOWER(name) LIKE LOWER(?)").get(nameOrTin, `
