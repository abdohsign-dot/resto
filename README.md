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
- **Catalog:** sections contain a free-depth tree of image-backed sub-sections and
  dishes. Each dish has image-backed sizes and reusable choice groups; manage choice
  groups and their price-delta options from the dish editor. Variant prices and stock
  are stored in cents/integer units. A legacy `/api/items` read-only projection remains
  for compatibility.
- **Admin POS and imported orders:** use **Take Order** or the **New Order** shortcut
  in Administration to browse the same catalog as the waiter screen, select variants
  and choices, add item and kitchen notes, and send an order. Choose Dine-in to enter a
  table number or Imported for a non-table order. Imported orders are stored with
  `order_type = imported`, table `0`, and no waiter; they appear as Imported in the Admin
  orders list and KDS.
- **Admin tables and settlement:** the **Tables** view lists dining tables and opens
  each table's complete order history, including unpaid and paid orders. Only admins
  settle balances. **Settle & print receipt** records the outstanding payment and sends
  the receipt to the admin printer. Waiters can send and manage orders but do not print
  tickets or request bills.
- **Kitchen stations and printers:** assign a kitchen station to each section in the
  kitchen configuration. Orders are grouped by station and kitchen slips are sent to
  that station's configured printer. Each slip includes only that station's active
  items, modifiers, and notes, and ends with a paper cut. Kitchen slips omit prices.
  Stations without a dedicated address use the default kitchen printer. The older
  `printer_ip` and `printer_port` settings continue to work as the default.
- **Admin receipt printer:** configure its IP in Administration → Settings; it is
  required when saving printer settings. It is separate from kitchen routing and never
  receives automatic kitchen tickets. Recording a payment sends a priced receipt with
  the payment method and remaining balance to this printer. **Print admin receipt** in
  the Admin orders list reprints a receipt manually. The regular **Print** action still
  opens the browser-printable ticket.
- **Inventory:** a blank variant stock quantity means untracked stock. Tracked stock
  is decremented when an order is accepted and restored on cancellation. Every stock
  change is recorded in `stock_movements` in the same transaction.
- **Modifiers and images:** modifier options belong to reusable groups and use integer
  cent deltas. PNG, JPEG, and WebP section, sub-section, dish, size, or legacy item
  uploads up to 2 MB are supported.
- **Reservations:** record a guest, contact, date/time, party size, optional table, and
  status. These are staff-managed reservations, not a public booking calendar.
- **Payments:** admins settle outstanding order balances by cash, card, or other and
  can record refunds. Receipts are printed locally; this does not connect to a payment
  processor.
- **Sales:** filter received payments and top ordered items by a 7-, 30-, or 90-day
  preset or custom date range, time-of-day window, everyone, admin orders, all waiters,
  or an individual waiter. Print the currently filtered report, including payment
  details and totals.

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
payments/refunds, reservations, image uploads, imported orders, station ticket splitting,
and station/admin printer routing.

## Deployment notes

The server continues to use polling for screen updates and is intended for a trusted
local network. It does not provide TLS, waiter-specific authentication, QR customer
ordering, payroll/time tracking, or online card processing. Do not expose it directly
to the public internet.
