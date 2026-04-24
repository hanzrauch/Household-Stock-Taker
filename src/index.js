// Household Stock Taker - Cloudflare Worker.
// Same HTTP contract as the original Express server, but running on Workers
// with Cloudflare D1 instead of better-sqlite3. Static assets in /public
// are served by the ASSETS binding for any path that doesn't match a route.

import { Hono } from 'hono';

const app = new Hono();

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

async function usageStats(DB, itemId, currentQty, windowDays = 30) {
  const row = await DB
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS consumed,
              MIN(created_at) AS first_entry
         FROM usage_log
        WHERE item_id = ?
          AND created_at >= datetime('now', ?)`,
    )
    .bind(itemId, `-${windowDays} days`)
    .first();

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

async function attachUsage(DB, items) {
  return Promise.all(
    items.map(async (item) => {
      item.usage = await usageStats(DB, item.id, item.quantity);
      return item;
    }),
  );
}

// --- items CRUD ---------------------------------------------------------

app.get('/api/items', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const lowOnly = c.req.query('low') === '1';
  const category = (c.req.query('category') || '').trim();

  let sql = 'SELECT * FROM items';
  const where = [];
  const params = [];
  if (q) {
    where.push('(name LIKE ? OR brand LIKE ? OR barcode = ? OR category LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, q, `%${q}%`);
  }
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (lowOnly) where.push('quantity <= min_quantity');
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY (quantity <= min_quantity) DESC, name COLLATE NOCASE';

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  const items = await attachUsage(c.env.DB, results.map(rowToItem));
  return c.json(items);
});

app.get('/api/categories', async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND category != '' ORDER BY category COLLATE NOCASE`)
    .all();
  return c.json(results.map((r) => r.category));
});

app.get('/api/items/:id', async (c) => {
  const row = await c.env.DB
    .prepare('SELECT * FROM items WHERE id = ?')
    .bind(c.req.param('id'))
    .first();
  const item = rowToItem(row);
  if (!item) return c.json({ error: 'not found' }, 404);
  item.usage = await usageStats(c.env.DB, item.id, item.quantity);
  return c.json(item);
});

app.post('/api/items', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const {
    barcode, name, brand, category,
    quantity = 0, unit = 'items', minQuantity = 1,
    packageSize, imageUrl, notes,
  } = body;

  if (!name || !String(name).trim()) {
    return c.json({ error: 'name is required' }, 400);
  }

  try {
    const info = await c.env.DB
      .prepare(
        `INSERT INTO items (barcode, name, brand, category, quantity, unit,
                            min_quantity, package_size, image_url, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
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
      )
      .run();

    const newId = info.meta.last_row_id;

    if (Number(quantity) > 0) {
      await c.env.DB
        .prepare(
          `INSERT INTO usage_log (item_id, delta, reason, note) VALUES (?, ?, 'initial', 'Initial stock')`,
        )
        .bind(newId, Number(quantity))
        .run();
    }

    const row = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(newId).first();
    return c.json(rowToItem(row), 201);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return c.json({ error: 'an item with that barcode already exists' }, 409);
    }
    return c.json({ error: err.message }, 500);
  }
});

app.put('/api/items/:id', async (c) => {
  const id = c.req.param('id');
  const current = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!current) return c.json({ error: 'not found' }, 404);

  const b = await c.req.json().catch(() => ({}));
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

  await c.env.DB
    .prepare(
      `UPDATE items SET barcode=?, name=?, brand=?, category=?, unit=?,
              min_quantity=?, package_size=?, image_url=?, notes=?,
              updated_at = datetime('now')
         WHERE id = ?`,
    )
    .bind(
      next.barcode, next.name, next.brand, next.category, next.unit,
      next.min_quantity, next.package_size, next.image_url, next.notes,
      id,
    )
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  return c.json(rowToItem(row));
});

app.delete('/api/items/:id', async (c) => {
  const info = await c.env.DB.prepare('DELETE FROM items WHERE id = ?').bind(c.req.param('id')).run();
  if (!info.meta.changes) return c.json({ error: 'not found' }, 404);
  return new Response(null, { status: 204 });
});

// --- quantity adjustments (logged) --------------------------------------

app.post('/api/items/:id/adjust', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { delta, reason = 'adjustment', note } = body;
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) {
    return c.json({ error: 'delta must be a non-zero number' }, 400);
  }
  if (!['consumed', 'purchased', 'adjustment'].includes(reason)) {
    return c.json({ error: 'invalid reason' }, 400);
  }

  const item = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!item) return c.json({ error: 'not found' }, 404);

  const newQty = Math.max(0, Number(item.quantity) + d);
  const realDelta = newQty - Number(item.quantity);

  // D1 has no interactive transactions; batch() is atomic for a fixed list
  // of statements, which is enough here.
  const stmts = [
    c.env.DB
      .prepare(`UPDATE items SET quantity = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(newQty, id),
  ];
  if (realDelta !== 0) {
    stmts.push(
      c.env.DB
        .prepare(`INSERT INTO usage_log (item_id, delta, reason, note) VALUES (?, ?, ?, ?)`)
        .bind(id, realDelta, reason, note || null),
    );
  }
  await c.env.DB.batch(stmts);

  const row = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  const updated = rowToItem(row);
  updated.usage = await usageStats(c.env.DB, updated.id, updated.quantity);
  return c.json(updated);
});

app.get('/api/items/:id/usage', async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, delta, reason, note, created_at AS createdAt
         FROM usage_log WHERE item_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(c.req.param('id'))
    .all();
  return c.json(results);
});

// --- barcode lookup proxy (Open Food Facts) ------------------------------

app.get('/api/lookup/:barcode', async (c) => {
  const barcode = String(c.req.param('barcode')).replace(/\D/g, '');
  if (!barcode) return c.json({ error: 'invalid barcode' }, 400);

  const existing = await c.env.DB
    .prepare('SELECT * FROM items WHERE barcode = ?')
    .bind(barcode)
    .first();
  if (existing) return c.json({ source: 'local', item: rowToItem(existing) });

  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'HouseholdStockTaker/0.1 (Cloudflare Worker)' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!r.ok) return c.json({ error: `lookup failed (${r.status})` }, 502);
    const data = await r.json();
    if (data.status !== 1 || !data.product) {
      return c.json({ source: 'openfoodfacts', error: 'product not found', barcode }, 404);
    }

    const p = data.product;
    return c.json({
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
    return c.json({ error: 'lookup failed', detail: err.message }, 502);
  }
});

// --- stats --------------------------------------------------------------

app.get('/api/stats', async (c) => {
  const row = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN quantity <= min_quantity THEN 1 ELSE 0 END) AS low,
              SUM(CASE WHEN quantity = 0              THEN 1 ELSE 0 END) AS out
         FROM items`,
    )
    .first();
  return c.json({
    total: row?.total || 0,
    low:   row?.low   || 0,
    out:   row?.out   || 0,
  });
});

// Fall through to the static asset binding for anything else (index.html,
// app.js, styles.css, favicon, ...). not_found_handling in wrangler.toml
// makes index.html serve for unknown paths too.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
