# Review — Restaurant Ordering System

Reviewed on 22 Nov 2026 from `server.py`, `app1.js`, `app2.js`, `app3.js`, `test_server_features.py`, `README.md`, and `todo.md`.

`python3 -m unittest -v test_server_features.py` passed: 18 tests (re-run on 22 Nov during a second verification pass, which also ran `python3 build_app.py --check` — result: `app.html is up to date` — and re-checked every citation below against the sources). The failures below are behaviors those tests do not cover. The app was not clicked through in a browser, and no printer or old production database was exercised. A second pass over the code added further findings; the first write-up missed them and they are listed alongside the rest.

## Summary

The catalog, stock ledger, tickets, and order-payment flow are implemented and the existing tests pass. The serious gaps are operational, not compile errors: staff PINs do not authorize API calls, two payment models do not agree, cancelling an order can put stock back for lines that stay served, and the admin menu screen still counts the legacy `items` table while editing `products`. `todo.md` is behind the code, so several boxes that are still empty are already built.

## What is wrong

### High — staff login does not protect the API

The waiter and kitchen screens ask for a PIN (`app1.js` around the staff and station pin pads; `POST /api/staff/auth` in `server.py` lines 903–924). After a correct PIN the server returns the name and role and stores nothing. Later calls do not send or check a session.

These routes are open to anyone who can reach the server (`ROUTES` in `server.py` lines 2669–2718, `needs_admin` is false):

- `POST /api/orders`
- `POST /api/orders/{id}/status` and line status
- `PUT /api/orders/{id}/bill`
- `POST /api/print/{id}`
- `GET /api/state`, `GET /api/ticket/{id}.html`

`h_order_create` (`server.py` lines 1091–1097) accepts any `staff_id` that belongs to the branch. It does not check the PIN. `GET /api/state` (`server.py` lines 866–875) publishes every staff id and whether a PIN is set, and strips only the hash.

PINs are unsalted SHA-256 (`server.py` lines 915–916 and 2071–2072). A 4-digit PIN can be guessed offline from the hash, and `/api/staff/auth` has no lockout. The README (lines 57–59 and 76–79) says waiter identity is not verified. The screens contradict that: they look locked.

The admin PIN is a shared secret in `config.json`, default `1234` (`server.py` lines 48 and 575–578). Startup prints it (`server.py` line 3091). The browser keeps it in `sessionStorage` and sends `X-Admin-Pin` on every request, including waiter calls (`app1.js` lines 407 and 416). Traffic is plain HTTP. `Access-Control-Allow-Origin` is `*` (`server.py` line 2787).

Unlocking admin calls `GET /api/export` only to see if the PIN works (`app3.js` lines 142–148). That downloads the branch’s orders, payments, and reservation contacts, then throws the body away.

Two details that confirm the gate is cosmetic: `h_staff_auth` matches staff by id with no branch filter (`server.py` line 909), and the kitchen screen’s “All stations” tile calls `pickStation(null, false)` (`app1.js` lines 629–631), which sets the kitchen role without asking for any PIN even when kitchen staff have PINs. Unhandled exceptions are returned to the client as `Server error: …` (`server.py` lines 2980–2981).

### Medium — an empty admin PIN disables the admin check entirely

`h_settings` (`PUT /api/settings`, `server.py` lines 2623–2638) accepts any string for `admin_pin` — including `""` — with no non-empty or format check. `check_admin` compares against the missing-header default (`headers.get("X-Admin-Pin", "")`, `server.py` lines 575–578), so once the configured PIN is empty, every admin route answers to a request with no header at all. The browser enforces 4+ digits (`app3.js` line 846); the API does not, and a single-character PIN is equally accepted.

### High — cancelling an order restores stock for lines that stay served

`h_order_status` marks only non-served lines cancelled, then restores every debited line:

```1204:1209:server.py
    if status == "cancelled":
        conn.execute("UPDATE orders SET cancel_reason=? WHERE id=?",
                     (str(body.get("reason") or "")[:300], order_id))
        conn.execute("UPDATE order_items SET status='cancelled' WHERE order_id=? AND status!='served'",
                     (order_id,))
        restore_stock(conn, order_id)
```

`restore_stock` (`server.py` lines 594–616) selects `stock_debited=1` with no status filter, adds the quantity back, writes a `cancel` ledger row, and clears `stock_debited`. A served line stays `served` and the kitchen can sell that portion again.

The single-line endpoint has the same hole without even the order-level guard: `h_line_status` (`server.py` lines 1220–1247) accepts `status='cancelled'` for a line in any state, including `served`, and calls `restore_stock` for it.

Cancel also looks only at the legacy `payments` table (`server.py` lines 1198–1201). A bill paid through `bill_payments` does not block the cancel.

### High — two payment systems, and the screen uses only one

Order payments live in `payments` / `payment_allocations` as decimal amounts (`server.py` lines 250–263, `h_payment_create` at 2235). Bill payments live in `bills`, `bill_items`, `bill_payments`, and `bill_refunds` as integer cents (`server.py` lines 265–298).

The admin screen records money with `POST /api/orders/{id}/payments` (`app3.js` line 770). No `app*.js` file calls `/api/bills`. Sales (`h_sales`, `server.py` lines 2339–2349) sums `payments` only. Closing or paying a bill does not show up there.

The same order line can sit on more than one bill. Uniqueness is `(bill_id, order_item_id)` (`server.py` lines 273–279), so two open bills for one table can both snapshot the same line and charge it twice. `h_bill_open` inserts with `INSERT OR IGNORE` (`server.py` lines 2395–2399) and does not look for the line on another bill.

### High — a cancelled order can still be billed

When `order_line_ids` is passed explicitly, `h_bill_open` and `h_bill_add_items` validate each line with `oi.status!='cancelled'` only. Both queries fetch `o.status order_status` and then never look at it (`server.py` lines 2388–2394 and 2453–2459). Cancelling an order keeps its served lines at `status='served'`, so those lines pass the filter and can be snapshotted onto a bill — and their payment enforced by `h_bill_close` — after the order was cancelled. Only the implicit “take every line at this table” path filters `o.status!='cancelled'` (`server.py` lines 2380–2384).

### Medium — payment balance checks are check-then-insert

`h_payment_create` (`server.py` lines 2248–2251) and `h_bill_payment_create` (`server.py` lines 2509–2518) read the paid total, compare it to the balance, and then INSERT, with no transaction or lock spanning the two steps. Two concurrent payments for the same order or bill can both pass the check and both be recorded, overpaying the balance. The stock decrement avoids this with a conditional `UPDATE … WHERE stock_qty>=?` plus a rowcount check (`server.py` lines 979–985); the money paths have no equivalent.

### Medium — menu the admin edits is not the menu the section tiles count

New products are written only to `products` (`h_catalog_product_create`, `server.py` lines 1473–1488). They are not inserted into `items`. Soft-delete sets `products.deleted_at` and leaves the `items` row (`server.py` lines 1637–1638).

Section tiles and the delete dialog count `S.data.items` (`app3.js` lines 164–165 and 231). After a catalog-only product is added, the tile can show zero items, the delete dialog can say the section is empty, and `DELETE /api/sections/{id}` still returns 400 because it counts live products as well (`server.py` lines 1293–1299). When a migrated dish exists in both tables, that error count is doubled.

`copy_menu` copies `items`, then `sync_catalog_from_item` (`server.py` lines 2128–2143). Catalog-only products and modifier groups are not copied. Copied staff rows omit `pin` (`server.py` lines 2144–2149), so the new branch’s staff cannot log in until someone sets PINs again.

### Medium — stock cache can move without a ledger row

Accept and cancel write `stock_movements` (`server.py` lines 1053–1058 and 610–615). Editing stock in the product save or `PATCH /api/variants/{id}` assigns `stock_qty` directly (`server.py` lines 1574–1578 and 1711–1723) and does not insert a movement. The rule in `todo.md` (every stock write needs a ledger row in the same transaction) is not held for manual counts. Replaying the ledger will not match the cache.

`PRAGMA foreign_keys` is never turned on in `db()` (`server.py` lines 89–92). `DELETE /api/modifier-groups/{id}` (`server.py` lines 1921–1931) therefore leaves `modifier_options` and `product_modifier_groups` rows behind. A required group can disappear from the join in `h_catalog_order_create` while the attachment row remains.

### Medium — inactive products can still be ordered

The waiter grid hides `p.active` false (`app2.js` lines 85–86). `require_product` (`server.py` lines 1372–1378) checks branch and `deleted_at` only. A direct `POST /api/orders` can still sell a hidden product if a variant is active.

The product editor always sends `active: 1` for every variant (`app3.js` line 439). A variant cannot be turned off from that screen. Sold-out is only `stock_qty === 0`.

There is no screen to create a modifier group. The editor only attaches groups already in `S.catalogGroups` (`app3.js` lines 362–390). A fresh database with no groups shows “No modifier groups” and no way to add one. `selection_type` is enforced in the waiter sheet with radios (`app2.js` lines 158–160). The order API stores `selection_type` and then ignores it (`server.py` lines 994–1034); only min and max are checked. A `single` group with `max_select` greater than 1 accepts multiple options.

### Medium — offline queue drops any HTTP error

`flushQueue` (`app1.js` lines 455–468) removes a queued order when `e.code` is set. `api()` sets `code` for every non-OK status, including 500 (`app1.js` lines 423–426). The comment says only a bad request is dropped. A transient server error, or a 409 that might succeed on retry, deletes the queued sale from `localStorage`.

### Lower

- Order line `price` is still a float (`order_items.price`, and `unit_price_cents / 100.0` at `server.py` line 1046). Totals use that float (`order_total`, lines 541–542). Bill snapshots use cents. The two totals can disagree by a cent.
- A corrupt `config.json` is ignored and the server continues with defaults, including PIN `1234` (`server.py` lines 69–73).
- Idempotent `client_uuid` returns the old order even when the retry body has different lines (`server.py` lines 933–939).
- The legacy item loop skips unknown items with `continue` (`server.py` lines 1118–1121) and can commit a partial order.
- Section delete is specified as 409 in `todo.md` and implemented as 400 (`server.py` line 1299).
- Newer-database startup does not name both schema versions. The message is “upgrade the server or restore a backup” (`server.py` lines 306–310). `todo.md` asked for both version numbers.
- Two stock counters drift apart. Catalog orders debit only `product_variants.stock_qty`; `items.stock_qty` for migrated dishes is left behind, while the legacy order path (`POST /api/orders` without `product_id`) still reads and debits both (`server.py` lines 1127–1158). `h_items_list` papers over the drift by preferring the variant stock (`server.py` lines 1828–1834), but the legacy counter never catches up.
- Deleting a variant only guards open tickets (`server.py` lines 1795–1806), and the full-replace endpoint does the same. Closed orders keep `order_items.variant_id` pointing at a deleted row and `stock_movements` rows for that variant dangle (foreign keys are off), so the ledger can no longer be replayed for it.
- ESC/POS tickets are encoded as cp437 with `errors="replace"` (`server.py` lines 723–725). Arabic is a first-class ticket language, but cp437 has no Arabic glyphs, so a printed Arabic ticket comes out as `?` marks; only the browser view is correct.
- Reopening a served order sets the order back to `preparing` but leaves every line `served` (`server.py` lines 1194–1215). The kitchen card then shows a preparing ticket whose lines cannot be advanced — the line tap is a no-op for served lines (`app3.js` lines 76–77) — and the waiter’s serve button only appears on `ready`.
- A 413 from `_body` (`server.py` lines 2808–2811) is raised before the request body is read. On a keep-alive HTTP/1.1 connection the unread bytes are then parsed as the next request, corrupting the stream.
- `/api/events` is unauthenticated and holds one server thread per client, polling the database every 0.8 s forever (`server.py` lines 2820–2872); the threading server spawns a thread per connection, so one device (or attacker) opening many streams exhausts threads. `GET /api/state` also hands the configured printer IP/port and all settings to any unauthenticated caller (`server.py` lines 883–887).
- `--backup` archives include `config.json`, which contains the admin PIN in plaintext (`server.py` lines 3047–3048).
- A few i18n keys are missing: `tr('loading')` renders the literal key (`app3.js` line 266) and the variant “From” price label falls back to English in the FR/AR UIs (`app2.js` line 100).

## What is missing

These are absent or only half-present. Several are already called out as deferred in `todo.md` or the README. They are listed because the product still does not do them.

- **Session after staff PIN.** Login succeeds and then any client can act as that waiter, change ticket status, print, or request a bill.
- **One bill per open table line.** No rule stops the same `order_item_id` from being snapshotted onto two bills.
- **Bill UI.** Endpoints exist (`/api/bills`, payments, refunds, close). The admin payment screen does not call them, and sales does not include `bill_payments`.
- **Modifier-group admin.** No create/edit/delete UI for groups or options, no drag-and-drop reorder, no “apply variants to a section”, no per-variant image. `todo.md` Phase 7 still lists those.
- **Ledger on manual stock edits**, and a documented set of reasons (`order_accept`, `cancel`, `refund`, `manual_adjust`). Refunds do not write stock movements. That may be intentional for money-only refunds; it is not written down next to the ledger. A product created with an opening `stock_qty` writes no movement either (`h_catalog_product_create`, `server.py` lines 1481–1488), so the ledger never explains where the opening stock came from.
- **A bill list endpoint.** There is no `GET /api/bills` (`ROUTES`, `server.py` lines 2720–2725), so even a UI built on the bill endpoints cannot discover open bills — it can only open one per table blindly or guess ids.
- **Reservation edits.** `PUT /api/reservations/{id}` (`server.py` lines 2197–2233) can change name, contact, note, table, and status but not `starts_at` or party size, so a guest who calls to move a booking can only be cancelled and rebooked.
- **Catalog products in branch copy**, and staff PINs on copied staff.
- **Foreign keys actually enabled**, so group and product deletes cascade or are rejected.
- **Rate limit or lockout** on admin and staff PIN checks.
- **TLS notes.** README says not to expose the server to the internet. There is no reverse-proxy example. `todo.md` line 400 is still open.
- **Browser checks** listed in `todo.md` Phases 4–7: required modifier blocks the button, max-select disables the next option, sold-out variant, offline flush once, tablet and phone layouts, finance journey on a device. Server tests cover several of the rules; the screens were not exercised here.
- **Physical printer check** (`todo.md` Phase 6 gate).
- **Tests that would catch the bugs above:** cancel with a served line, inactive product order, bill line on two bills, a bill opened from a cancelled order’s lines, sales after a bill payment, manual stock edit without a ledger row, branch copy of a catalog-only product, modifier group delete while attached, a settings call that empties the admin PIN, and two payments racing the balance.

`todo.md` is stale in the other direction. These are already in the code even where the box is unchecked: section POST/PATCH/DELETE, the indexes in `SCHEMA` (`server.py` lines 179–219), `GET /health` (lines 2884–2904), and `python3 server.py --backup` (lines 3022–3053 and 3063–3065).

## Not verified

- Clicking through waiter, kitchen, and admin in a browser.
- A restored pre-catalog `restaurant.db` (the migration test builds a tiny legacy schema only).
- Concurrent orders against the last unit of stock on two server threads; the concurrent-payment overpay described above is likewise unexercised.
- ESC/POS output on a printer (including the Arabic-encoding problem, which needs paper to confirm).
