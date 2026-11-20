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

## Admin features

- **Branches:** create a branch from Administration. Optionally copy the current menu
  and staff; copied items start with stock untracked. Orders, reservations, menu, staff,
  and reports are isolated by branch.
- **Inventory:** edit an item's remaining quantity in Menu. A blank quantity means
  untracked stock. Tracked stock is decremented when an order is accepted and restored
  when an unpaid order or line is cancelled.
- **Modifiers and images:** define one modifier per line as `Name:price` in the item
  editor. PNG, JPEG, and WebP uploads up to 2 MB are supported.
- **Reservations:** record a guest, contact, date/time, party size, optional table, and
  status. These are staff-managed reservations, not a public booking calendar.
- **Bills and payments:** waiters can request a bill. Admin can record cash, card, or
  other payments, split payment by item quantities, and record refunds. This does not
  connect to a payment processor.
- **Sales:** view received payments and top ordered items for the last 7, 30, or 90 days.

Existing SQLite databases are migrated on server startup; existing menu, staff, and
order rows are assigned to the default `Main Branch`. Back up `data/restaurant.db`
before deploying a new version.

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
