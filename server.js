const path = require('node:path');
const express = require('express');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/zxing', express.static(path.join(__dirname, 'node_modules/@zxing/browser/umd')));
app.use('/vendor/zxing-library', express.static(path.join(__dirname, 'node_modules/@zxing/library/umd')));

const PORT = process.env.PORT || 3000;

// --- helpers ------------------------------------------------------------

function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    barcode: row.barcode,
    name: row.name,
    brand: row.brand,
    category: row.category,
    quantity: row.quantity,
    unit: row.unit,
    minQuantity: row.min_quantity,
    packageSize: row.package_size,
    imageUrl: row.image_url,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Usage rate over the last N days. Returns { perDay, daysRemaining } or null
// if there isn't enough history yet.
function usageStats(itemId, currentQty, windowDays = 30) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS consumed,
              MIN(created_at) AS first_entry
         FROM usage_log
        WHERE item_id = ?
          AND created_at >= datetime('now', ?)`,
    )
    .get(itemId, `-${windowDays} days`);

  if (!row || !row.first_entry || row.consumed <= 0) return null;

  const firstMs = new Date(row.first_entry + 'Z').getTime();
  const spanDays = Math.max(1, (Date.now() - firstMs) / 86_400_000);
  const perDay = row.consumed / spanDays;
  if (perDay <= 0) return null;

  return {
    perDay: Number(perDay.toFixed(3)),
    daysRemaining: currentQty > 0 ? Math.floor(currentQty / perDay) : 0,
  };
}

// --- items CRUD ---------------------------------------------------------

app.get('/api/items', (req, res) => {
  const q = (req.query.q || '').trim();
  const lowOnly = req.query.low === '1';

  let sql = 'SELECT * FROM items';
  const where = [];
  const params = [];
  if (q) {
    where.push('(name LIKE ? OR brand LIKE ? OR barcode = ? OR category LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, q, `%${q}%`);
  }
  if (lowOnly) where.push('quantity <= min_quantity');
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY (quantity <= min_quantity) DESC, name COLLATE NOCASE';

  const items = db.prepare(sql).all(...params).map(rowToItem);
  for (const item of items) item.usage = usageStats(item.id, item.quantity);
  res.json(items);
});

app.get('/api/items/:id', (req, res) => {
  const item = rowToItem(db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id));
  if (!item) return res.status(404).json({ error: 'not found' });
  item.usage = usageStats(item.id, item.quantity);
  res.json(item);
});

app.post('/api/items', (req, res) => {
  const {
    barcode, name, brand, category,
    quantity = 0, unit = 'items', minQuantity = 1,
    packageSize, imageUrl, notes,
  } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO items (barcode, name, brand, category, quantity, unit,
                            min_quantity, package_size, image_url, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        barcode || null,
        String(name).trim(),
        brand || null,
        category || null,
        Number(quantity) || 0,
        unit || 'items',
        Number(minQuantity) || 0,
        packageSize || null,
        imageUrl || null,
        notes || null,
      );

    if (Number(quantity) > 0) {
      db.prepare(
        `INSERT INTO usage_log (item_id, delta, reason, note) VALUES (?, ?, 'initial', 'Initial stock')`,
      ).run(info.lastInsertRowid, Number(quantity));
    }

    const item = rowToItem(db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid));
    res.status(201).json(item);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'an item with that barcode already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/items/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'not found' });

  const b = req.body || {};
  const next = {
    barcode:      b.barcode      ?? current.barcode,
    name:         b.name         ?? current.name,
    brand:        b.brand        ?? current.brand,
    category:     b.category     ?? current.category,
    unit:         b.unit         ?? current.unit,
    min_quantity: b.minQuantity  ?? current.min_quantity,
    package_size: b.packageSize  ?? current.package_size,
    image_url:    b.imageUrl     ?? current.image_url,
    notes:        b.notes        ?? current.notes,
  };

  db.prepare(
    `UPDATE items SET barcode=?, name=?, brand=?, category=?, unit=?,
            min_quantity=?, package_size=?, image_url=?, notes=?,
            updated_at = datetime('now')
       WHERE id = ?`,
  ).run(
    next.barcode, next.name, next.brand, next.category, next.unit,
    next.min_quantity, next.package_size, next.image_url, next.notes,
    req.params.id,
  );

  res.json(rowToItem(db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id)));
});

app.delete('/api/items/:id', (req, res) => {
  const info = db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

// --- quantity adjustments (logged) --------------------------------------

app.post('/api/items/:id/adjust', (req, res) => {
  const { delta, reason = 'adjustment', note } = req.body || {};
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) {
    return res.status(400).json({ error: 'delta must be a non-zero number' });
  }
  if (!['consumed', 'purchased', 'adjustment'].includes(reason)) {
    return res.status(400).json({ error: 'invalid reason' });
  }

  const tx = db.transaction(() => {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    if (!item) throw Object.assign(new Error('not found'), { status: 404 });

    const newQty = Math.max(0, Number(item.quantity) + d);
    const realDelta = newQty - Number(item.quantity);

    db.prepare(
      `UPDATE items SET quantity = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(newQty, item.id);

    if (realDelta !== 0) {
      db.prepare(
        `INSERT INTO usage_log (item_id, delta, reason, note) VALUES (?, ?, ?, ?)`,
      ).run(item.id, realDelta, reason, note || null);
    }
    return rowToItem(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id));
  });

  try {
    const item = tx();
    item.usage = usageStats(item.id, item.quantity);
    res.json(item);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/items/:id/usage', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, delta, reason, note, created_at AS createdAt
         FROM usage_log WHERE item_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
    .all(req.params.id);
  res.json(rows);
});

// --- barcode lookup proxy (Open Food Facts) ------------------------------

app.get('/api/lookup/:barcode', async (req, res) => {
  const barcode = String(req.params.barcode).replace(/\D/g, '');
  if (!barcode) return res.status(400).json({ error: 'invalid barcode' });

  // Return a locally known item first so the UI can show "already tracked"
  const existing = rowToItem(db.prepare('SELECT * FROM items WHERE barcode = ?').get(barcode));
  if (existing) return res.json({ source: 'local', item: existing });

  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'HouseholdStockTaker/0.1 (self-hosted)' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!r.ok) return res.status(502).json({ error: `lookup failed (${r.status})` });
    const data = await r.json();
    if (data.status !== 1 || !data.product) {
      return res.status(404).json({ source: 'openfoodfacts', error: 'product not found', barcode });
    }

    const p = data.product;
    res.json({
      source: 'openfoodfacts',
      barcode,
      suggestion: {
        barcode,
        name:         p.product_name || p.generic_name || '',
        brand:        (p.brands || '').split(',')[0].trim() || null,
        category:     (p.categories || '').split(',').pop()?.trim() || null,
        packageSize:  p.quantity || null,
        imageUrl:     p.image_front_url || p.image_url || null,
      },
    });
  } catch (err) {
    res.status(502).json({ error: 'lookup failed', detail: err.message });
  }
});

// --- stats --------------------------------------------------------------

app.get('/api/stats', (_req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  const low = db.prepare('SELECT COUNT(*) AS n FROM items WHERE quantity <= min_quantity').get().n;
  const out = db.prepare('SELECT COUNT(*) AS n FROM items WHERE quantity = 0').get().n;
  res.json({ total, low, out });
});

app.listen(PORT, () => {
  console.log(`Household Stock Taker running on http://localhost:${PORT}`);
});
