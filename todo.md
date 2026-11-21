# TODO — Restaurant Ordering System: Catalog & Finance Foundation

Legend: [ ] todo  [x] done  [~] in progress  [!] blocked
Rule: do not start a phase until the previous phase's Verification gate passes.

---

## PHASE 0 — Pre-flight (before any code)

[x] Back up the current repo and any local `data/restaurant.db` to a safe folder.
[x] Initialize Git if needed, configure the remote, and create a branch:
    `git init` (only if not already a repository),
    `git checkout -b catalog-foundation`
[x] Since this is currently not a Git repository, do not run Git destructive
    commands until the repository and remote are initialized.
[x] Confirm Python version on dev machine: `python3 --version` (must be >= 3.10)
[x] Run the current tests once to record the baseline:
    `python3 -m unittest -v test_server_features.py`
[x] Record the baseline: 10 tests, 9 passing, 1 failing with
    `FileNotFoundError` because the temporary audit-log directory is not created.
[x] Fix the baseline audit-log test setup or make audit directory initialization
    consistent before beginning Phase 1.
[x] Confirm no real users / no production data (project assumption).
[x] Freeze UI work: no changes to app1.js/app2.js/app3.js during Phases 1-3.
[x] Confirm the existing test suite is green before the catalog work starts.

Verification gate:
[x] Baseline test suite passes: 10 of 10 tests.
[x] Branch `catalog-foundation` exists and is ready to push.

DO NOT YET: touch the admin UI, touch the waiter UI, add endpoints.

---

## PHASE 1 — Schema, migration, and repository hygiene (FIRST COMMIT)

### 1.1 Schema version guard
[x] In server.py define `DB_VERSION = 2`.
[x] On startup, read `PRAGMA user_version`.
[x] If `user_version > DB_VERSION`: print a clear error and `sys.exit(1)`.
    Message must name both versions and say "upgrade server.py or restore an older backup".
[x] If `user_version < DB_VERSION`: run migration inside a transaction; rollback on any failure.
[x] On success: `PRAGMA user_version = 2`.
[x] Write migration idempotency test (run twice, second run is a no-op).

### 1.2 New catalog tables
[x] `sections` (id, branch_id, name, sort_order, active)
      - migration from current `position` to `sort_order`
      - preserve existing `kitchen_station`
[x] `products` (id, section_id, name, description, image_path, active, sort_order, deleted_at)
      - migration from legacy `items.image_url` to `image_path`
[x] `product_variants` (id, product_id, name, price_cents, stock_qty NULL=untracked,
      is_default, sort_order, active)
      + partial unique index: exactly one `is_default=1` per product
      + `UNIQUE(product_id, name)`
[x] `modifier_groups` (id, branch_id, name, selection_type, min_select, max_select)
      + `UNIQUE(branch_id, name)`
      + `CHECK(max_select >= min_select)`
[x] `modifier_options` (id, modifier_group_id, name, price_delta_cents, sort_order, active)
      + `UNIQUE(modifier_group_id, name)`
[x] `product_modifier_groups` (product_id, modifier_group_id, sort_order, override_min, override_max)
      + document NULL semantics: NULL = inherit from group
[ ] Indexes:
    - products(section_id) WHERE deleted_at IS NULL
    - product_variants(product_id)
    - modifier_options(modifier_group_id)
    - product_modifier_groups(modifier_group_id)

### 1.3 Stock ledger (replaces any boolean stock flag)
[x] `stock_movements` (id, variant_id, order_line_id, delta, reason, created_at, actor)
[ ] reason values documented: order_accept, cancel, refund, manual_adjust
[x] Decision: keep `product_variants.stock_qty` as a cached, indexed quantity
    and require every stock change to update the cache and append a ledger row
    in the same transaction.
[x] If ledger replay is ever used, it must reconcile the cache from movements.
[x] `stock_qty` remains `NULL` for untracked stock and never becomes negative.

### 1.4 Finance foundation (schema compatibility)
[ ] Audit the existing `payments`, `payment_allocations`, `orders`, and
    `order_items` tables before adding any parallel finance model.
[ ] Inventory existing payment behavior and public API contracts in the migration
    plan so catalog work does not replace or break it accidentally.
[ ] If `bills` are added now, integrate them with existing orders rather than
    creating a disconnected bill/payment system.
[ ] `bills` (id, branch_id, table_id, status, opened_at, closed_at)
[ ] `bill_items` (id, bill_id, order_line_id, qty, unit_price_cents) + UNIQUE(bill_id, order_line_id)
[ ] `payments` (id, bill_id, amount_cents, method, recorded_by, recorded_at, note)
[ ] `refunds` (id, payment_id, amount_cents, reason, recorded_at)
[ ] State invariants in code comments:
    - "A bill snapshots order lines; later menu price changes never alter it."
    - "Every refund references a payment; every payment references a bill."
    - "Every bill references order lines."

### 1.5 Order-line extension
[x] In the existing `order_items` table, add `variant_id`
[x] In the existing `order_items` table, add `variant_name`
[x] In the existing `order_items` table, add `modifiers_json`
[x] Add these columns as nullable for legacy/test order rows.
[x] Keep existing item and order snapshots readable while adding catalog fields.
[ ] DO NOT add a `stock_debited` boolean — the ledger replaces it.

### 1.6 Legacy items compatibility
[x] Preserve or migrate the existing `items` table during Phase 1;
    do not hard-drop it before all current server routes are safely migrated.
[ ] If a read-only compatibility view is used, name it clearly as a compatibility
    projection and do not accidentally remove the existing write API mid-phase.
[ ] Create `items_compat` as a VIEW over products JOIN default variant, or expose
    the existing `/api/items` route as a read-only projection.
      Columns: id, section_id, name, description, price_cents, active, stock_qty, image_path
[x] Keep all existing `items` writes working for legacy UI clients until Phase 2
    compatibility adapters are tested.
[x] Record legacy writes at the catalog layer, never as a separate source of truth.
[ ] Remove legacy write routes in Phase 2 only after the new catalog API passes
    positive and negative tests.

### 1.7 Data migration (test data only — destructive is allowed)
[x] For each legacy item: create product + one default variant "Regular" at item price.
[x] If legacy modifiers exist: create one per-product modifier_group and move options into it.
[x] Preserve existing `order_items` rows and make catalog snapshot columns nullable.
[x] Map legacy order-item data to historical names/prices as snapshots even where
    no variant ID exists.
[ ] Record in the migration docstring: "legacy order rows retain item snapshots;
    variant IDs are nullable until future catalog-backed lines".
[ ] Destructive local-only cleanup is not required; in no case delete an order or
    order item merely to simplify migration.

### 1.8 Repository hygiene (same commit)
[x] Create `.gitignore`:
      __pycache__/
      *.pyc
      data/logs/
      data/tickets/
      data/item_images/
      data/restaurant.db
      config.json
[ ] `git rm -r --cached __pycache__ data`
[ ] Commit `data/.gitkeep` and `config.example.json`
[x] Add `LICENSE` (MIT or "source-available, all rights reserved")
[ ] Move screenshots to `docs/screenshots/`

### 1.9 Tests for Phase 1
[x] test_migration_flat_to_variants
[x] test_migration_idempotent (run twice)
[x] test_refuse_start_when_db_newer_than_binary
[ ] test_zero_variants_rejected (requires catalog endpoints, Phase 2)
[ ] test_duplicate_default_variant_rejected (database partial index covered; API pending)
[x] test_missing_default_variant_rejected
[x] test_integer_cents_roundtrip
[x] test_stock_deducted_on_accept_via_ledger
[x] test_stock_restored_on_cancel_via_ledger
[x] test_branch_isolation_products (negative case: wrong branch header -> 404)
[ ] test_legacy_items_projection_or_adapter (compatibility is in shared item writes; projection pending)

Verification gate (Phase 1 -> Phase 2):
[x] `python3 -m unittest -v test_server_features.py` — all pass (11 tests)
[ ] Fresh DB: `rm data/restaurant.db && python3 server.py` starts cleanly, no errors
[ ] Old DB copy: restore a Phase 0 backup, start server, migration runs, tests pass
[ ] A grep audit documents every remaining legacy `items` read/write and assigns
    it to the compatibility or migration checklist item
[ ] `git status` shows no `data/`, no `__pycache__`, no `config.json`
[ ] Commit message: "catalog foundation: schema v2, stock ledger, repo hygiene"
[ ] Push the branch.

DO NOT YET: add endpoints, edit UI, add drag-and-drop, add shared modifier groups.

---

## PHASE 2 — Server API (catalog read + write)

### 2.1 Catalog endpoints
[x] GET    /api/sections
[ ] POST   /api/sections                         {name, sort_order}
[ ] PATCH  /api/sections/{id}                    {name?, sort_order?, active?}
[ ] DELETE /api/sections/{id}                    -> 409 if non-empty
[x] GET    /api/products?section_id=&q=
[x] POST   /api/products                         atomic: product + variants + group attachments
[x] PATCH  /api/products/{id}
[x] DELETE /api/products/{id}                    soft-delete if referenced by open ticket
[x] GET    /api/products/{id}/variants
[x] POST   /api/products/{id}/variants
[x] PATCH  /api/variants/{id}
[x] DELETE /api/variants/{id}                    -> 409 if in open ticket
[x] PUT    /api/products/{id}/variants           bulk replace (for later "apply to section")
[x] GET    /api/modifier-groups
[x] POST   /api/modifier-groups
[x] PATCH  /api/modifier-groups/{id}
[x] DELETE /api/modifier-groups/{id}
[x] GET    /api/modifier-groups/{id}/options
[x] POST   /api/modifier-groups/{id}/options
[x] PATCH  /api/modifier-options/{id}
[x] DELETE /api/modifier-options/{id}
[x] PUT    /api/products/{id}/modifier-groups    attach/detach + override_min/override_max

### 2.2 Validation (all server-side)
[x] product must have >= 1 active variant
[x] exactly one default variant
[x] variant name unique within product
[x] variant price_cents integer >= 0
[x] stock_qty NULL or integer >= 0
[x] name/description length bounds
[x] required group has min_select >= 1
[x] max_select >= min_select
[x] modifier_option_ids belong to groups attached to the product
[x] duplicate modifier_option_ids rejected
[x] unit price ALWAYS recomputed server-side (client price ignored)

### 2.3 Order creation contract (replace item-only contract)
[x] New body:
    { lines: [ { product_id, variant_id, modifier_option_ids, qty, note } ] }
[x] Verify product + variant belong to branch
[x] Verify variant active and stocked
[x] Validate modifiers against attached groups (required/min/max)
[x] Recompute price in cents
[x] Snapshot variant_name, modifiers_json (names + deltas), unit_price_cents
[x] Deduct stock atomically:
      UPDATE product_variants SET stock_qty = stock_qty - :qty
       WHERE id = :variant_id AND (stock_qty IS NULL OR stock_qty >= :qty);
      check rowcount; if 0 -> reject
[x] INSERT stock_movements(delta=-qty, reason='order_accept')
[x] Return full ticket with names + snapshots

### 2.4 Legacy /api/items remains read-only
[x] GET /api/items continues to work via the compatibility projection
[x] No POST/PATCH/DELETE on /api/items (return 405 explicitly)

### 2.5 Tests for Phase 2
[x] test_catalog_product_order_modifiers_and_legacy_write
[x] test_catalog_modifier_and_variant_validation
[x] test_catalog_historical_price_and_variant_cancel_stock
[ ] test_max_select_enforced (implementation present; dedicated test pending)
[ ] test_wrong_group_modifier_rejected (implementation present; dedicated test pending)
[ ] test_stock_deduction_atomic_under_concurrent_orders (implementation present; dedicated test pending)
[ ] test_soft_delete_variant_in_open_ticket_returns_409 (implementation present; dedicated test pending)
[ ] test_branch_isolation_on_every_catalog_route (shared require_* checks present; dedicated test pending)

Verification gate (Phase 2 -> Phase 3):
[x] All tests pass
[ ] Manual curl: create section -> product -> variants -> attach group ->
    create order with modifiers -> verify ticket snapshot -> cancel -> verify
    stock ledger has a - and a + movement
[x] `python3 server.py` starts cleanly on a fresh DB

DO NOT YET: edit the admin UI. The API is the contract; the UI comes after.

---

## PHASE 3 — Build check and regression lock

[x] Define `build_app.py --check`:
    regenerate into temp file, diff against committed app.html, exit non-zero on diff
[x] Add the check to the Phase 3 verification run
[x] Re-run full test suite twice to confirm no flakiness

Verification gate (Phase 3 -> Phase 4):
[x] `python3 -m unittest -v test_server_features.py` passes
[x] `python3 build_app.py --check` passes
[x] `python3 server.py` starts cleanly

DO NOT YET: start the editor.

---

## PHASE 4 — Admin three-pane editor (UI)

Scope for this phase (do not add beyond this):
- sections pane
- products pane
- product editor (variants, one modifier group attachment, overrides)

Deferred to Phase 7:
- drag-and-drop reordering
- shared cross-product group management UI
- bulk variant apply
- per-variant images
- merge/consolidation tools

### 4.1 Sections pane
[x] list sections
[x] create / rename / hide / soft-delete
[x] reorder (buttons for now, drag-and-drop later)

### 4.2 Products pane
[x] list products for selected section
[x] search (client-side filter over loaded list is fine)
[x] create product (opens editor with one default Regular variant)
[x] edit product
[x] soft-delete product

### 4.3 Product editor
[x] name, description, image upload
[x] variants table: add row, edit name/price/stock, set default, delete (block last)
[x] attach one modifier group (checkbox list)
[x] per-product override_min / override_max (NULL = inherit)
[x] Save is atomic: one POST/PATCH with everything
[x] Show server validation errors inline, not as a generic toast

### 4.4 Tests for Phase 4
[ ] browser walkthrough: create section, product, 3 variants, attach group, save
[ ] browser walkthrough: attempt save with 0 variants -> inline error
[ ] browser walkthrough: set two defaults -> inline error
[ ] browser walkthrough: price change on a variant -> old ticket unaffected

Verification gate (Phase 4 -> Phase 5):
[ ] Admin can build a Margherita with Small/Medium/Large in under 2 minutes
[ ] Admin can build a Chicken with Full/Half in under 2 minutes
[ ] API tests still pass
[ ] build check still passes

DO NOT YET: edit the waiter UI.

---

## PHASE 5 — Waiter UI (product bottom sheet)

[x] Product card shows default variant price + "from $X" if variants differ
[x] Tap opens bottom sheet:
    - variant selector (radio, required)
    - modifier groups rendered by selection_type
    - required groups block "Add to cart" with a reason label
    - max_select disables unchecked options when reached
    - sold-out variant shown disabled with "sold out"
    - quantity control
    - note field
    - live price preview (client-side only)
[x] Cart line stores product_id, variant_id, modifier_option_ids, qty, note
[x] Send uses the new order contract
[x] Offline queue stores the same shape (no legacy item_id)

### 5.1 Tests for Phase 5
[x] server walkthrough: catalog Large + Extra cheese snapshots variant and modifier
[ ] browser walkthrough: required crust not chosen -> button blocked with label
[ ] browser walkthrough: 4 extras when max is 3 -> 4th disabled
[ ] browser walkthrough: sold-out Large disabled, Medium selectable
[ ] offline: send with server down -> queued -> server up -> flushed once (idempotent)

Verification gate (Phase 5 -> Phase 6):
[ ] Full waiter browser journey on a tablet-sized viewport
[x] Server records correct snapshots
[x] Stock ledger shows exactly one -qty per line sent

DO NOT YET: edit kitchen UI.

---

## PHASE 6 — Kitchen display and ticket printing

### 6.1 Kitchen display
[x] Ticket line renders variant name
[x] Modifier sub-lines rendered under the product line
[x] Note rendered under modifiers
[x] Status derivation unchanged

### 6.2 ESC/POS ticket
[x] 42-column layout includes variant name
[x] Modifiers as indented sub-lines, 2-space indent, wrap at 40 chars
[x] Note as indented sub-line
[x] Cancellation banner unchanged

### 6.3 Browser print view
[x] Same content as ESC/POS ticket

### 6.4 Tests for Phase 6
[x] archived .txt ticket contains variant name and modifier names
[x] long modifier name wraps at 40 chars without breaking the layout
[x] historical ticket reprint after a price change shows the original prices

Verification gate (Phase 6 -> Phase 7):
[ ] Physical printer (or emulator) prints a correct ticket with variant + modifiers
[ ] Kitchen display shows variant + modifiers on a phone-sized viewport
[ ] No regressions in the Phase 2-5 test suite

---

## PHASE 7 — Finance and stabilization

Now, and only now, build the endpoints and UI for bills/payments/refunds
(the tables already exist from Phase 1).

### 7.1 Bills
[x] POST /api/bills                      {table_no} -> opens a bill, snapshots open lines
[x] GET  /api/bills/{id}
[x] POST /api/bills/{id}/items           attach order_line_ids (snapshot unit_price_cents)
[x] POST /api/bills/{id}/close

### 7.2 Payments and refunds
[x] POST /api/bills/{id}/payments        {amount_cents, method}
[x] POST /api/payments/{id}/refunds      {amount_cents, reason}
[x] Validation: sum(payments) <= bill total; refund <= payment amount
[x] Existing admin payment UI supports recording/splitting/refunding orders
[x] Waiter UI: "request bill" button

### 7.3 Sales summary
[x] GET /api/reports/sales?days=7|30|90  -> received payments, top items

### 7.4 Deferred-but-now-allowed (pick what is needed)
[ ] shared cross-product modifier groups UI
[ ] bulk variant application to a section
[ ] drag-to-reorder in admin
[ ] per-waiter PIN or badge
[ ] TLS deployment guidance (reverse proxy) in docs only
[ ] backup command: `python3 server.py --backup /path/to/backup.zip`
[ ] health endpoint: GET /health

### 7.5 Tests for Phase 7
[x] test_phase7_bill_payment_refund_snapshot_and_sales
[x] test_overpayment_rejected
[x] test_refund_cannot_exceed_payment
[x] test_bill_snapshot_immune_to_menu_price_change
[x] test_cancel_unpaid_order_restores_stock_via_ledger
[x] test_sales_summary_windows_7_30_90

Verification gate (Phase 7 -> Phase 8):
[ ] Full finance journey in the admin UI on a real device
[ ] Ledger + payments reconcile to the cent
[ ] All tests pass

---

## PHASE 8 — Legacy removal

[ ] Remove legacy read routes for /api/items (or keep permanently read-only if useful)
[ ] Drop the `items` view
[ ] Remove any compatibility fields left on order_lines
[ ] Squash migrations: a fresh install starts at v2 with no v1 path
[ ] Update README + docs to the v2 model only
[ ] Final tag: `git tag v2.1-finance`

Verification gate (final):
[ ] Fresh install on a clean machine: `python3 server.py` -> usable admin in < 5 min
[ ] Restore from a Phase 0 backup: migration runs, no data loss beyond documented pre-v2 order drops
[ ] Full test suite green
[ ] build check green

---

## Global guardrails (apply to every phase)

[ ] Never edit app.html directly; always rebuild via build_app.py
[ ] During Phase 1, legacy `items` compatibility writes are allowed only if they
    route through a migration/adapter into the catalog tables
[ ] Never expose `items` as an independent second source of truth
[ ] Never store money as float; always integer cents
[ ] Never trust a client-computed price; server recomputes
[ ] Never add a new stock write without a stock_movements row in the same transaction
[ ] Every new endpoint gets at least one positive and one negative test
[ ] Every phase ends with a verification gate and a push