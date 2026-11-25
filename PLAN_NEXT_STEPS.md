# Implementation Plan: Admin Order Dashboard, Imported Orders & Station-Split Kitchen Printing

## Overview & Scope
This plan details the technical design and phased implementation for four next-generation features in the restaurant ordering system:
1. **Admin Order Dashboard:** A waiter-style menu ordering interface directly accessible by the admin.
2. **"Imported" Orders:** Ability to place non-table orders without table numbers or waiter names, tagged strictly as `Imported`. integrated to Admin Order Dashboard.
3. **Kitchen Display System (KDS) Integration:** Differentiating tickets on kitchen screens with clear attribution: `Table {N} · {Waiter Name}` vs. `📦 Imported Order`.
4. **Station-Split Kitchen Ticket Printing:** Splitting tickets by section/station (e.g. Fish chef gets fish items, Bar gets drinks) with dedicated printer routing, plus a separate admin receipt printer.

> **Status:** Planned implementation is complete. The 24-test server feature suite passes, including the new imported-order and printer-routing coverage.

---

## 1. Architectural & Data Model Design

### 1.1 Database Schema Additions (`orders` Table)
Currently, `orders` has:
- `table_no INTEGER NOT NULL`
- `staff_id INTEGER`
- `staff_name TEXT DEFAULT ''`
- `note TEXT DEFAULT ''`
- `status TEXT DEFAULT 'sent'`

To cleanly support imported orders without breaking legacy table constraints:
- Add column `order_type TEXT NOT NULL DEFAULT 'dine_in'` (`'dine_in'` vs `'imported'`).
- For imported orders:
  - `order_type = 'imported'`
  - `table_no = 0` (or `NULL` where allowed, standardizing `0` for integer compatibility).
  - `staff_name = 'Admin'` (or `'Imported'`).
- Safe migration in `init_db()`:
  ```python
  migrations["orders"]["order_type"] = "TEXT NOT NULL DEFAULT 'dine_in'"
  ```

### 1.2 Station-Split Ticket Architecture
Currently, `print_ticket(order_id)` prints all items in a single print job.
In the new architecture:
- When an order contains items destined for multiple stations (e.g. `Fish`, `Starters`, `Drinks`):
  1. Group lines by their resolved `kitchen_station`.
  2. For each station that has items, generate a dedicated **Station Ticket**.
  3. Format each station slip with the station name, order identifier (Table vs. Imported), items with modifiers/notes, and overall ticket metadata.
  4. Route each station slip to its configured printer, falling back to a default kitchen printer; each job ends with a full paper cut (`\x1dV\x01`).
  5. Send a full priced receipt only to the required admin printer when an admin explicitly requests it; automatic kitchen orders never route there.

---

## 2. Detailed Step-by-Step Implementation

### Step 1: Admin Order Dashboard (Waiter-Style Interface for Admin)

#### Objective
Provide the admin with a full-screen, responsive catalog ordering interface identical in functionality to the waiter tablet experience, accessible directly from the Admin Dashboard without needing waiter sign-in or table restrictions.

#### Design & UX
- **Navigation Entry:**
  - Add a dedicated navigation button or tab in Admin: `🍽️ Take Order` / `Terminal POS`.
  - Also provide a quick-launch shortcut from the Admin top bar (`[🛒 New Order]`).
- **Catalog Experience:**
  - Display full section navigation with photos and counts.
  - Browse dishes, sub-sections, sizes, and price-delta modifier choice groups.
  - Interactive dish configuration modal (single-choice groups, multi-choice add-ons, item-specific kitchen notes).
  - Floating/docked cart summary with quantities, price tally, and total.
- **Cart & Order Review:**
  - Cart drawer showing selected variants and modifiers.
  - Quick note for the kitchen (e.g. "Urgent", "Allergy info", "Customer pickup at 14:00").
  - Single-click "Send to Kitchen" action.

---

### Step 2: "Imported" Order Flow (No Table Number, No Waiters)

#### Objective
Allow the admin to submit orders that do not originate from a dining table or waiter, tagging them strictly as `Imported`.

#### Design & UX
- **Order Target Switcher:**
  - At the top of the Admin Order Dashboard / Cart review, provide an intuitive segmented selector:
    - `[ 🪑 Dine-in Table ]` | `[ 📦 Imported Order ]`
- **When `Imported Order` is active:**
  - The table number input is hidden/disabled.
  - No waiter selection is required or shown.
  - The order is submitted to `/api/orders` with:
    ```json
    {
      "order_type": "imported",
      "table_no": 0,
      "staff_name": "Imported",
      "note": "Optional customer / delivery reference",
      "lines": [...]
    }
    ```
- **Order Identification:**
  - In Admin orders tab, bill payments, and sales reports, these appear labeled as `📦 Imported #123` rather than `Table #0`.

---

### Step 3: Kitchen Display System (KDS) Differentiation

#### Objective
Ensure cooks and station chefs instantly identify whether an incoming ticket is for an in-house table or an external/imported order.

#### Design & UI
- **Kitchen Ticket Card (`kCard` in `app3.js`):**
  - **Dine-In Orders:**
    - Header shows: `🪑 Table {table_no} · {waiter_name}`
    - Normal neutral/amber styling.
  - **Imported Orders:**
    - Header shows: `📦 IMPORTED #123`
    - Prominent badge styling (distinct accent border, e.g. indigo/purple `#6366f1` or blue tag `[IMPORTED]`).
    - No table number is shown.
    - No waiter attribution is shown.
- **Station Line Filtering:**
  - Station chefs only see the lines matching their station (e.g., Fish chef sees only fish items), regardless of whether the order came from a waiter or an imported admin ticket.

---

### Step 4: Station-Split Auto-Printing for Kitchen

#### Objective
Automatically split tickets so that each station/chef receives a dedicated printed slip containing only their items, while retaining all critical order context (table number or imported badge, order ID, timestamp, notes).

#### Technical Specifications

#### 4.1 Grouping Logic
When `maybe_autoprint(order_id)` triggers:
1. Fetch full order and lines.
2. Group lines by `kitchen_station`:
   ```python
   stations_map = {}
   for line in order["lines"]:
       if line["status"] == "cancelled":
           continue
       st = line.get("kitchen_station") or "General Kitchen"
       stations_map.setdefault(st, []).append(line)
   ```

#### 4.2 Split Ticket Template (`station_ticket_text`)
For each station slip:
```text
========================================
             RESTAURANT NAME
----------------------------------------
[ STATION: FISH ]
Ticket #142  -  24/11/2026 14:32
*** IMPORTED ORDER ***
(or: Table: 12   Waiter: Alex)
Note: Extra crispy skin please
----------------------------------------
1x Grilled Salmon (Large)          85.00
   + Garlic Butter
   . Well done
2x Fried Calamari                 120.00
   . Sauce on the side
----------------------------------------
Items for this station: 3
========================================
[ CUT PAPER ]
```

#### 4.3 Printer Dispatch
- Every configured kitchen station can route to its own printer. Stations without an address use the default kitchen printer; older `printer_ip` and `printer_port` settings remain supported as that default.
- The required `admin` printer receives a full priced order receipt only on an explicit admin print action; automatic kitchen orders never route there. Kitchen station slips omit prices.
- Configuration shape:
  ```json
  "printers": {
    "default": { "ip": "192.168.1.200", "port": 9100 },
    "admin": { "ip": "192.168.1.210", "port": 9100 },
    "stations": {
      "Fish": { "ip": "192.168.1.201", "port": 9100 },
      "Drinks": { "ip": "192.168.1.202", "port": 9100 }
    }
  }
  ```

---

## 3. Implementation Phases & Verification Gates

```
┌────────────────────────────────────────────────────────┐
│ Phase 1: Database Migration & Order API Updates        │
│ - Add order_type to orders schema                     │
│ - Update h_order_create to handle order_type & table 0 │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Phase 2: KDS Screen & Ticket Display Updates           │
│ - Update kCard to show Table N + Waiter vs Imported    │
│ - Style Imported badges on kitchen tablets             │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Phase 3: Station-Split Ticket Printing Engine          │
│ - Implement station_ticket_text() in server.py         │
│ - Multi-slip loop with individual ESC/POS paper cuts   │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Phase 4: Admin Order Dashboard & UI Integration        │
│ - Waiter-style POS catalog interface inside Admin     │
│ - Imported toggle (no table #, no waiter)              │
│ - Rebuild app.html                                     │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Phase 5: Verification & End-to-End Testing             │
│ - Unit tests in test_server_features.py                │
│ - Test ticket outputs across stations                  │
└────────────────────────────────────────────────────────┘
```

### Phase 1: Backend & Schema
- [x] Add `order_type` to `orders` table in `server.py` migration.
- [x] Update `h_order_create` to validate:
  - If `order_type == "imported"`: accept `table_no = 0`, store `staff_name = "Imported"`.
  - If `order_type == "dine_in"`: require positive integer `table_no`.
- [x] Update `h_state` order serialization to include `order_type`.

### Phase 2: Kitchen Display System (KDS)
- [x] Update `kCard` in `app3.js`:
  - Check `o.order_type === 'imported'` or `o.table_no === 0`.
  - Render `📦 Imported` header without waiter name.
  - Render `Table {table_no} · {waiter_name}` for dine-in.
- [x] Add CSS badge `.khead-imported` in `app.css`.

### Phase 3: Station-Split Printing Engine
- [x] Create `split_order_by_station(order)` helper in `server.py`.
- [x] Implement `station_ticket_text(order, station_name, station_lines, lang)`:
  - Header explicitly announces the station name in bold/caps.
  - Shows Table/Waiter or `*** IMPORTED ORDER ***`.
  - Lists only lines belonging to that station.
- [x] Update `print_ticket(order_id)` and `maybe_autoprint(order_id)`:
  - Generates and routes one slip to each configured station printer.
  - Each print job ends with a full paper cut.
  - Saves individual ticket logs in `data/tickets/`.
- [x] Add settings for per-station kitchen printers, default kitchen fallback, and the required separate admin receipt printer.

### Phase 4: Admin Order Dashboard UI
- [x] Add new Admin tab: `['pos', '🛒 Take Order']`.
- [x] Add an Admin top-bar quick action for starting a new order.
- [x] Reuse the catalog component from `app2.js` into an Admin POS view:
  - Browse sections and items.
  - Configure dish sizes, choice groups, and notes.
- [x] Add `Imported` order toggle button:
  - When toggled, eliminates table number requirement and automatically marks order as `order_type: 'imported'`.
- [x] Add "Send to Kitchen" button executing `POST /api/orders`.
- [x] Add explicit admin receipt printing to the required admin printer.
- [x] Run `python3 build_app.py` to regenerate `app.html`.

### Phase 5: Test Suite & Verification
- [x] Add test cases to `test_server_features.py`:
  - Test creation of imported order with `table_no = 0`.
  - Test ticket splitting: verify that an order with items from two stations generates two distinct station slips.
  - Verify that imported orders do not require waiter attribution.
  - Verify all existing 22 tests pass without regressions.

---

## 4. Decisions Applied

- Kitchen station printers are configured individually, with the default kitchen printer as fallback.
- The required admin printer handles explicit receipt printing only; kitchen orders go to station printers.
- The admin ordering screen lives in a dedicated Admin Dashboard tab; station slips omit prices.
