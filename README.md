# Restaurant Ordering System

## Run locally

Use Python 3.10 or newer; the server uses only the standard library.

```sh
python3 server.py
```

Open `http://localhost:8080` on the server, or use the LAN address printed at startup
on tablets on the same trusted network. After changing `app1.js`, `app2.js`, `app3.js`,
or `app.css`, rebuild the single-page app:

```sh
python3 build_app.py
```

Use `python3 build_app.py --check` in CI. The build reads `top.html`, `mid.html`,
`app.css`, `app1.js`, `app2.js`, and `app3.js`; never edit `app.html` directly.

## Admin features

- **Branches:** create a branch from Administration. Optionally copy the current menu
  and staff; copied items start with stock untracked. Orders, reservations, menu, staff,
  and reports are isolated by branch.
- **Catalog:** the admin menu uses sections, products, variants, and reusable modifier
  groups. Variant prices and stock are stored in cents/integer units. A legacy
  `/api/items` read-only projection remains for compatibility.
- **Inventory:** a blank variant stock quantity means untracked stock. Tracked stock
  is decremented when an order is accepted and restored on cancellation. Every stock
  change is recorded in `stock_movements` in the same transaction.
- **Modifiers and images:** modifier options belong to reusable groups and use integer
  cent deltas. PNG, JPEG, and WebP product or legacy item uploads up to 2 MB are supported.
- **Reservations:** record a guest, contact, date/time, party size, optional table, and
  status. These are staff-managed reservations, not a public booking calendar.
- **Bills and payments:** waiters can request a bill. Admin can record cash, card, or
  other payments, split payment by item quantities, and record refunds. This does not
  connect to a payment processor.
- **Sales:** view received payments and top ordered items for the last 7, 30, or 90 days.

Existing SQLite databases are migrated on server startup. Legacy menu rows become
one product plus one `Regular` default variant, preserving names and prices. Existing
staff and order rows are retained and assigned to the default `Main Branch`. Legacy
item write routes are disabled; use `/api/products`, `/api/variants`, and
`/api/modifier-groups`. Back up `data/restaurant.db` before deploying a new version.

## Daily operation logs

The server appends every handled HTTP request (including reads and failed requests) to
`data/logs/DD-MM-YYYY.jsonl`, using the server's local date; each record also displays
its date and timestamp as `DD/MM/YYYY`. Records include a unique event ID, method,
endpoint, response, branch, client IP, duration, and available role/staff attribution.
They list submitted field names and include a limited summary of non-sensitive values
such as item price, stock, status, and table number. Resource IDs from API responses are
included when available, including IDs assigned on creation. Free text, PINs, payment
amounts, and guest contact details are excluded. The browser-supplied waiter role and ID
are attribution hints, not verified identities; the app does not currently provide
individual waiter authentication. Include `data/logs/` in the restaurant's backup and
retention process. Check server output for `AUDIT LOG WRITE FAILED` if the log directory
is unavailable or unwritable.

## Tests

Run the standard-library regression tests with:

```sh
python3 -m unittest -v test_server_features.py
```

The tests cover database migration, branch isolation, stock handling, modifiers,
payments/refunds, reservations, and image uploads.

## Deployment notes

The server continues to use polling for screen updates and is intended for a trusted
local network. It does not provide TLS, waiter-specific authentication, QR customer
ordering, payroll/time tracking, or online card processing. Do not expose it directly
to the public internet.
