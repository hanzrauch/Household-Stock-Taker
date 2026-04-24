-- Dedicated categories table so the dropdown list has a real home
-- instead of living only as TEXT on the items table.

CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY COLLATE NOCASE
);

-- Seed with the default household list. INSERT OR IGNORE keeps this
-- idempotent if it runs twice.
INSERT OR IGNORE INTO categories (name) VALUES
  ('Pantry'),
  ('Fridge'),
  ('Freezer'),
  ('Drinks'),
  ('Snacks'),
  ('Cleaning'),
  ('Laundry'),
  ('Bathroom'),
  ('Medicine'),
  ('Baby'),
  ('Pets'),
  ('Other');

-- Backfill: every category already used by an item should also be in
-- the categories table, so it shows up in the management UI.
INSERT OR IGNORE INTO categories (name)
  SELECT DISTINCT category FROM items
   WHERE category IS NOT NULL AND category != '';
