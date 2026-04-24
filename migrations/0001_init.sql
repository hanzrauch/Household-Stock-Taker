-- Household Stock Taker initial schema.

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
