const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'stock.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode       TEXT UNIQUE,
    name          TEXT NOT NULL,
    brand         TEXT,
    category      TEXT,
    quantity      REAL NOT NULL DEFAULT 0,
    unit          TEXT NOT NULL DEFAULT 'items',
    min_quantity  REAL NOT NULL DEFAULT 1,
    package_size  TEXT,
    image_url     TEXT,
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
  CREATE INDEX IF NOT EXISTS idx_items_name    ON items(name);

  CREATE TABLE IF NOT EXISTS usage_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    delta      REAL NOT NULL,
    reason     TEXT NOT NULL CHECK (reason IN ('consumed','purchased','adjustment','initial')),
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_usage_item_time ON usage_log(item_id, created_at);
`);

module.exports = db;
