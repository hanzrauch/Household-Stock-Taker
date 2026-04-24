# Household Stock Taker

A small self-hosted web app for tracking what's in stock around the house.
Scan a barcode with your phone's camera, get product info auto-filled from
[Open Food Facts](https://world.openfoodfacts.org/), and log what gets used
and purchased so the app can tell you **roughly how many days of stock you
have left** and flag items as low before you run out.

Runs as a single Node process with a SQLite file — no build step on the
frontend, no external services besides the (optional) barcode lookup.

## Features

- **Item catalogue** — name, brand, category, quantity, unit, package size,
  image, notes, and a per-item reorder threshold.
- **Quantity adjustments are logged** — every +/- has a reason
  (`purchased`, `consumed`, `adjustment`, `initial`) and a timestamp, so the
  app can compute a per-day usage rate and estimated days remaining.
- **Barcode scanning** via `@zxing/browser` using the device camera.
- **Product lookup** — the server proxies `/api/lookup/:barcode` to Open
  Food Facts and pre-fills the add-item form with name, brand, category,
  package size, and image.
- **Low-stock view** — filter to just the items at or below their reorder
  threshold; stats in the header show totals, low, and out-of-stock counts.

## Requirements

- Node.js 20 or newer
- A modern browser (the barcode scanner needs `getUserMedia`, which requires
  either `localhost` or HTTPS)

## Install & run

```bash
npm install
npm start
```

Then open http://localhost:3000.

Use `npm run dev` for auto-reload on server changes.

### Using it from your phone

The scanner only works over `localhost` or HTTPS. The simplest options:

- **Same machine as server**: just open `localhost:3000`.
- **Phone on the same LAN**: run behind an HTTPS reverse proxy (Caddy,
  nginx, Tailscale Funnel, `ngrok http 3000`, etc.) and load the HTTPS URL.

## Data

Everything lives in a single SQLite file at `./data/stock.db` (auto-created
on first launch). Back it up by copying that file. The `data/` directory is
git-ignored.

### Schema

**`items`**

| column         | type    | notes                                    |
|----------------|---------|------------------------------------------|
| `id`           | INTEGER | primary key                              |
| `barcode`      | TEXT    | unique, nullable                         |
| `name`         | TEXT    | required                                 |
| `brand`        | TEXT    |                                          |
| `category`     | TEXT    |                                          |
| `quantity`     | REAL    | current on-hand count                    |
| `unit`         | TEXT    | `items`, `ml`, `g`, `rolls`, ...         |
| `min_quantity` | REAL    | reorder-at threshold                     |
| `package_size` | TEXT    | e.g. "500 ml"                            |
| `image_url`    | TEXT    |                                          |
| `notes`        | TEXT    |                                          |
| `created_at`   | TEXT    |                                          |
| `updated_at`   | TEXT    |                                          |

**`usage_log`** — one row per quantity change, used to compute usage rate.

| column       | type    | notes                                                       |
|--------------|---------|-------------------------------------------------------------|
| `id`         | INTEGER | primary key                                                 |
| `item_id`    | INTEGER | FK → `items.id` (cascade on delete)                         |
| `delta`      | REAL    | signed change (negative = consumed, positive = purchased)   |
| `reason`     | TEXT    | `consumed` / `purchased` / `adjustment` / `initial`         |
| `note`       | TEXT    | optional                                                    |
| `created_at` | TEXT    |                                                             |

### Usage-rate math

For each item the server looks at the last 30 days of `usage_log` entries,
sums the consumed quantity, and divides by the span between the first log
entry in the window and now (clamped to ≥ 1 day). The estimated days
remaining is `floor(current quantity / per-day rate)`.

## HTTP API

| Method | Path                      | Description                                              |
|--------|---------------------------|----------------------------------------------------------|
| GET    | `/api/items`              | List items. Query: `q=` (search), `low=1` (low-stock).   |
| POST   | `/api/items`              | Create an item (`name` required).                        |
| GET    | `/api/items/:id`          | Fetch one item (includes `usage` stats).                 |
| PUT    | `/api/items/:id`          | Update item metadata (does not touch quantity).          |
| DELETE | `/api/items/:id`          | Delete item and its log.                                 |
| POST   | `/api/items/:id/adjust`   | Body: `{delta, reason, note?}`. Clamped at 0. Logged.    |
| GET    | `/api/items/:id/usage`    | Recent usage-log rows.                                   |
| GET    | `/api/lookup/:barcode`    | Local hit or Open Food Facts suggestion.                 |
| GET    | `/api/stats`              | `{total, low, out}`.                                     |

## Source layout

```
server.js           Express server + all API routes
db.js               SQLite schema + connection
public/
  index.html        single-page UI
  styles.css
  app.js            list view, forms, scanner, detail/history modal
data/stock.db       SQLite database (created at runtime)
```

## Notes & limitations

- The Open Food Facts API is free but rate-limits aggressively from shared
  IPs. Running from a residential connection is fine; if a lookup fails the
  UI just falls back to manual entry.
- Open Food Facts skews toward groceries and household products. Items not
  in its database (cleaning supplies from a regional chain, for instance)
  can still be added by hand with the barcode recorded.
- This is a single-user app with no authentication. Put it behind a VPN or
  a reverse-proxy with basic auth if you expose it beyond your LAN.
