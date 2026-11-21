#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Restaurant ordering server — zero dependency (Python 3 standard library only).

Run:      python3 server.py
Tablets:  http://<server-ip>:8080   (waiter / kitchen / admin, same page)

Features
  - Menu with sections (add / edit / reorder / activate)
  - Waiters with assigned table numbers (managed by admin)
  - Orders sent straight to the kitchen screen, status workflow
  - Cancel whole orders or single lines (with reason)
  - Ticket printing: ESC/POS thermal printer on the LAN (port 9100)
    and/or browser print view from any tablet
  - All data stored locally in SQLite (data/restaurant.db)
"""
import hashlib
import json
import base64
import argparse
import datetime
import math
import os
import re
import signal
import socket
import sqlite3
import threading
import time
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("RT_DATA") or os.path.join(BASE, "data")
DB_PATH = os.path.join(DATA_DIR, "restaurant.db")
CONFIG_PATH = os.environ.get("RT_CONFIG") or os.path.join(BASE, "config.json")
TICKETS_DIR = os.path.join(DATA_DIR, "tickets")
AUDIT_DIR = os.path.join(DATA_DIR, "logs")
IMAGES_DIR = os.path.join(DATA_DIR, "item_images")
APP_PATH = os.path.join(BASE, "app.html")

DEFAULT_CONFIG = {
    "restaurant_name": "Restaurant",
    "currency": "MAD",
    "admin_pin": "1234",
    "printer_ip": "",
    "printer_port": 9100,
    "autoprint": True,         # print ticket automatically when an order arrives
    "port": 8080,
    "disk_warning_mb": 500,
    "log_retention_days": 90,
    "ticket_amber_minutes": 5,
    "ticket_red_minutes": 10,
}

SCHEMA_VERSION = 2

# ---------------------------------------------------------------- config / db

_lock = threading.Lock()
_audit_lock = threading.Lock()

def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception:
            pass
    else:
        os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        print("Generated config: %s" % CONFIG_PATH)
        print("First-run admin PIN: %s" % cfg["admin_pin"])
    return cfg

def save_config(cfg):
    with _lock:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)

CONFIG = load_config()

def db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    branch_id INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    description TEXT DEFAULT '',
    position INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    branch_id INTEGER NOT NULL DEFAULT 1,
    stock_qty INTEGER,
    image_url TEXT DEFAULT '',
    modifiers TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tables TEXT DEFAULT '[]',
    active INTEGER DEFAULT 1,
    branch_id INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE,
    table_no INTEGER NOT NULL,
    staff_id INTEGER,
    staff_name TEXT DEFAULT '',
    note TEXT DEFAULT '',
    status TEXT DEFAULT 'sent',
    cancel_reason TEXT DEFAULT '',
    created_at REAL,
    updated_at REAL,
    branch_id INTEGER NOT NULL DEFAULT 1,
    bill_requested INTEGER NOT NULL DEFAULT 0,
    lang TEXT NOT NULL DEFAULT 'fr'
);
CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    item_id INTEGER,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    unit_price_cents INTEGER,
    qty INTEGER NOT NULL DEFAULT 1,
    note TEXT DEFAULT '',
    status TEXT DEFAULT 'sent',
    modifiers TEXT NOT NULL DEFAULT '[]',
    stock_debited INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    image_path TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    stock_qty INTEGER CHECK (stock_qty IS NULL OR stock_qty >= 0),
    is_default INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(product_id, name),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_default_variant
    ON product_variants(product_id) WHERE is_default=1;
CREATE INDEX IF NOT EXISTS ix_products_section
    ON products(section_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_variants_product
    ON product_variants(product_id);

CREATE TABLE IF NOT EXISTS modifier_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    selection_type TEXT NOT NULL CHECK (selection_type IN ('single','multi')),
    min_select INTEGER NOT NULL DEFAULT 0,
    max_select INTEGER NOT NULL DEFAULT 1,
    CHECK (max_select >= min_select),
    UNIQUE(branch_id, name)
);
CREATE TABLE IF NOT EXISTS modifier_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    modifier_group_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price_delta_cents INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(modifier_group_id, name),
    FOREIGN KEY(modifier_group_id) REFERENCES modifier_groups(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS product_modifier_groups (
    product_id INTEGER NOT NULL,
    modifier_group_id INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    override_min INTEGER,
    override_max INTEGER,
    PRIMARY KEY(product_id, modifier_group_id),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY(modifier_group_id) REFERENCES modifier_groups(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_options_group
    ON modifier_options(modifier_group_id);
CREATE INDEX IF NOT EXISTS ix_product_modifier_groups_group
    ON product_modifier_groups(modifier_group_id);

CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_id INTEGER NOT NULL,
    order_item_id INTEGER,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at REAL NOT NULL,
    actor TEXT DEFAULT '',
    FOREIGN KEY(variant_id) REFERENCES product_variants(id)
);
CREATE TABLE IF NOT EXISTS catalog_migration_items (
    item_id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL,
    variant_id INTEGER NOT NULL,
    FOREIGN KEY(product_id) REFERENCES products(id),
    FOREIGN KEY(variant_id) REFERENCES product_variants(id)
);
CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL DEFAULT 1,
    guest_name TEXT NOT NULL,
    contact TEXT DEFAULT '',
    starts_at REAL NOT NULL,
    party_size INTEGER NOT NULL,
    table_no INTEGER,
    status TEXT NOT NULL DEFAULT 'booked',
    note TEXT DEFAULT '',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    refunded_amount REAL NOT NULL DEFAULT 0,
    method TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_allocations (
    payment_id INTEGER NOT NULL,
    order_item_id INTEGER NOT NULL,
    qty REAL NOT NULL,
    PRIMARY KEY (payment_id, order_item_id)
);
"""

def init_db():
    conn = db()
    version_row = conn.execute("PRAGMA user_version").fetchone()
    db_version = int(version_row[0])
    if db_version > SCHEMA_VERSION:
        conn.close()
        raise RuntimeError(
            "database was written by a newer version; upgrade the server or restore a backup"
        )
    conn.executescript(SCHEMA)
    conn.execute("INSERT OR IGNORE INTO branches(id, name) VALUES(1, 'Main Branch')")
    migrations = {
        "sections": {
            "branch_id": "INTEGER NOT NULL DEFAULT 1",
            "kitchen_station": "TEXT DEFAULT ''",
        },
        "items": {"branch_id": "INTEGER NOT NULL DEFAULT 1", "stock_qty": "INTEGER",
                  "image_url": "TEXT DEFAULT ''", "modifiers": "TEXT NOT NULL DEFAULT '[]'"},
        "staff": {
            "branch_id": "INTEGER NOT NULL DEFAULT 1",
            "pin": "TEXT DEFAULT ''",
            "role": "TEXT DEFAULT 'waiter'",
            "kitchen_station": "TEXT DEFAULT ''",
        },
        "orders": {"branch_id": "INTEGER NOT NULL DEFAULT 1",
                   "bill_requested": "INTEGER NOT NULL DEFAULT 0",
                   "lang": "TEXT NOT NULL DEFAULT 'fr'"},
        "order_items": {"modifiers": "TEXT NOT NULL DEFAULT '[]'",
                        "stock_debited": "INTEGER NOT NULL DEFAULT 0",
                        "variant_id": "INTEGER",
                        "variant_name": "TEXT",
                        "modifiers_json": "TEXT",
                        "unit_price_cents": "INTEGER"},
        "payments": {"refunded_amount": "REAL NOT NULL DEFAULT 0"},
    }
    for table, columns in migrations.items():
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(%s)" % table)}
        for column, definition in columns.items():
            if column not in existing:
                conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, definition))
    conn.execute("CREATE INDEX IF NOT EXISTS idx_orders_branch_created ON orders(branch_id, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reservations_branch_time ON reservations(branch_id, starts_at)")
    row = conn.execute("SELECT value FROM meta WHERE key='rev'").fetchone()
    if row is None:
        conn.execute("INSERT INTO meta(key, value) VALUES('rev','1')")
        seed(conn)
    if db_version < SCHEMA_VERSION:
        try:
            conn.commit()
            conn.execute("BEGIN")
            migrate_catalog_v2(conn)
        except Exception:
            conn.rollback()
            conn.close()
            raise
    conn.execute("PRAGMA user_version=%d" % SCHEMA_VERSION)
    conn.commit()
    conn.close()

def seed(conn):
    """First run: a small demo menu so the app is usable immediately."""
    secs = [("Starters", 1), ("Main Courses", 2), ("Desserts", 3), ("Drinks", 4)]
    for name, pos in secs:
        conn.execute("INSERT INTO sections(name, position, active) VALUES(?,?,1)", (name, pos))
    demo = {
        "Starters": [("Garlic Bread", 4.5), ("Tomato Soup", 5.0), ("Chicken Wings", 8.0)],
        "Main Courses": [("Margherita Pizza", 12.0), ("Beef Burger", 13.5),
                         ("Grilled Salmon", 18.0), ("Pasta Carbonara", 14.0)],
        "Desserts": [("Cheesecake", 6.0), ("Tiramisu", 6.5), ("Ice Cream", 4.0)],
        "Drinks": [("Cola", 2.5), ("Sparkling Water", 2.0), ("Orange Juice", 3.5),
                   ("Espresso", 2.0), ("House Red Wine", 5.0)],
    }
    for name, pos in secs:
        for i, (item, price) in enumerate(demo[name], start=1):
            conn.execute(
                "INSERT INTO items(section_id, name, price, position, active) "
                "VALUES((SELECT id FROM sections WHERE name=?), ?, ?, ?, 1)",
                (name, item, price, i))
    for name, tables in [("Alex", list(range(1, 9))), ("Maria", list(range(9, 17)))]:
        conn.execute("INSERT INTO staff(name, tables, active) VALUES(?,?,1)",
                     (name, json.dumps(tables)))

def parse_legacy_modifiers(raw):
    """Parse JSON modifiers or legacy 'Name:price' text for catalog migration."""
    if raw is None:
        return []
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = []
            for line in text.splitlines():
                if ":" not in line:
                    continue
                name, price = line.rsplit(":", 1)
                try:
                    parsed.append({"name": name.strip(), "price": float(price.strip())})
                except (TypeError, ValueError):
                    continue
        raw = parsed
    if not isinstance(raw, list):
        return []
    out = []
    seen = set()
    for modifier in raw:
        if not isinstance(modifier, dict):
            continue
        name = str(modifier.get("name") or "").strip()
        try:
            price = round(float(modifier.get("price", 0)), 2)
        except (TypeError, ValueError):
            continue
        if not name or name in seen or not math.isfinite(price) or price < 0:
            continue
        seen.add(name)
        out.append({"name": name, "price": price})
    return out

def migrate_catalog_v2(conn):
    """Create catalog rows for legacy items and map each item directly by ID."""
    for item in conn.execute("SELECT * FROM items").fetchall():
        existing = conn.execute(
            "SELECT 1 FROM catalog_migration_items WHERE item_id=?",
            (item["id"],)).fetchone()
        if existing:
            continue
        section_id = item["section_id"]
        price = round(float(item["price"]), 2)
        if not math.isfinite(price) or price < 0:
            price = 0.0
        price_cents = int(round(price * 100))
        columns = set(item.keys())
        stock = item["stock_qty"] if "stock_qty" in columns else None
        active = int(bool(item["active"])) if "active" in columns else 1
        sort_order = int(item["position"]) if "position" in columns else 0
        description = str(item["description"] or "") if "description" in columns else ""
        image_path = str(item["image_url"] or "") if "image_url" in columns else ""

        product = conn.execute(
            "INSERT INTO products(section_id,name,description,image_path,active,sort_order)"
            " VALUES(?,?,?,?,?,?)",
            (section_id, str(item["name"]), description, image_path,
             active, sort_order))
        product_id = product.lastrowid
        variant = conn.execute(
            "INSERT INTO product_variants"
            "(product_id,name,price_cents,stock_qty,is_default,sort_order,active)"
            " VALUES(?,?,?,?,1,0,?)",
            (product_id, "Regular", price_cents, stock, active))
        variant_id = variant.lastrowid
        conn.execute(
            "INSERT INTO catalog_migration_items(item_id,product_id,variant_id)"
            " VALUES(?,?,?)",
            (item["id"], product_id, variant_id))
        if stock is not None:
            conn.execute(
                "INSERT INTO stock_movements"
                "(variant_id,delta,reason,created_at,actor)"
                " VALUES(?,?,'manual_adjust',?,?)",
                (variant_id, int(stock), time.time(), "migration"))

        modifiers = parse_legacy_modifiers(
            item["modifiers"] if "modifiers" in columns else None)
        if modifiers:
            branch_row = conn.execute(
                "SELECT branch_id FROM sections WHERE id=?", (section_id,)).fetchone()
            branch_id = int(branch_row["branch_id"]) if branch_row else 1
            group_name = "%s extras" % str(item["name"])
            existing_group = conn.execute(
                "SELECT id FROM modifier_groups WHERE branch_id=? AND name=?",
                (branch_id, group_name)).fetchone()
            if existing_group:
                group_id = existing_group["id"]
            else:
                group = conn.execute(
                    "INSERT INTO modifier_groups"
                    "(branch_id,name,selection_type,min_select,max_select)"
                    " VALUES(?,?,'multi',0,999)",
                    (branch_id, group_name))
                group_id = group.lastrowid
            for index, modifier in enumerate(modifiers):
                conn.execute(
                    "INSERT OR IGNORE INTO modifier_options"
                    "(modifier_group_id,name,price_delta_cents,sort_order,active)"
                    " VALUES(?,?,?,?,1)",
                    (group_id, modifier["name"], int(round(modifier["price"] * 100)), index))
            conn.execute(
                "INSERT OR IGNORE INTO product_modifier_groups"
                "(product_id,modifier_group_id,sort_order,override_min,override_max)"
                " VALUES(?,?,0,NULL,NULL)",
                (product_id, group_id))

    for line in conn.execute(
            "SELECT oi.id,oi.item_id,oi.modifiers "
            "FROM order_items oi "
            "JOIN catalog_migration_items mi ON mi.item_id=oi.item_id "
            "WHERE oi.variant_id IS NULL").fetchall():
        mapping = conn.execute(
            "SELECT variant_id FROM catalog_migration_items WHERE item_id=?",
            (line["item_id"],)).fetchone()
        if not mapping:
            continue
        conn.execute(
            "UPDATE order_items SET variant_id=?, variant_name='Regular', "
            "modifiers_json=? WHERE id=?",
            (mapping["variant_id"], line["modifiers"] or "[]", line["id"]))

def bump_rev(conn):
    conn.execute("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='rev'")

def get_rev(conn):
    return int(conn.execute("SELECT value FROM meta WHERE key='rev'").fetchone()["value"])

# ---------------------------------------------------------------- helpers

class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg

def parse_tables(raw):
    """Accept [1,2,3] or JSON string list; return sorted unique ints."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = []
    out = set()
    for t in raw or []:
        try:
            out.add(int(t))
        except Exception:
            pass
    return sorted(out)

def order_total(lines):
    return round(sum(l["price"] * l["qty"] for l in lines if l["status"] != "cancelled"), 2)

def get_order(conn, order_id, with_lines=True):
    o = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not o:
        raise ApiError(404, "Order not found")
    o = dict(o)
    if with_lines:
        o["lines"] = [dict(r) for r in conn.execute(
            "SELECT * FROM order_items WHERE order_id=? ORDER BY id", (order_id,))]
        o["total"] = order_total(o["lines"])
    return o

def recompute_order_status(conn, order_id):
    """Derive order status from its lines (cancel / all-ready cases)."""
    lines = [dict(r) for r in conn.execute(
        "SELECT status FROM order_items WHERE order_id=?", (order_id,))]
    o = dict(conn.execute("SELECT status FROM orders WHERE id=?", (order_id,)).fetchone())
    if o["status"] in ("served", "cancelled"):
        return
    active = [l for l in lines if l["status"] != "cancelled"]
    if not active:
        new = "cancelled"
    elif all(l["status"] == "ready" for l in active):
        new = "ready"
    elif any(l["status"] in ("preparing", "ready") for l in active):
        new = "preparing"
    else:
        new = "sent"
    if new != o["status"]:
        conn.execute("UPDATE orders SET status=?, updated_at=? WHERE id=?",
                     (new, time.time(), order_id))

def check_admin(headers):
    pin = headers.get("X-Admin-Pin", "")
    if str(pin) != str(CONFIG.get("admin_pin", "")):
        raise ApiError(403, "Wrong or missing admin PIN (X-Admin-Pin header)")

def get_branch_id(body):
    try:
        branch_id = int(body.get("branch_id") or 1)
    except (TypeError, ValueError):
        raise ApiError(400, "Invalid branch")
    if branch_id <= 0:
        raise ApiError(400, "Invalid branch")
    return branch_id

def require_branch(conn, branch_id):
    if not conn.execute("SELECT 1 FROM branches WHERE id=? AND active=1",
                        (branch_id,)).fetchone():
        raise ApiError(404, "Branch not found")

def restore_stock(conn, order_id, line_id=None):
    sql = ("SELECT oi.id, oi.item_id, oi.variant_id, oi.qty, oi.stock_debited "
           "FROM order_items oi "
           "WHERE oi.order_id=? AND oi.stock_debited=1")
    params = [order_id]
    if line_id is not None:
        sql += " AND oi.id=?"
        params.append(line_id)
    for row in conn.execute(sql, params).fetchall():
        conn.execute("UPDATE items SET stock_qty=stock_qty+? WHERE id=? AND stock_qty IS NOT NULL",
                     (row["qty"], row["item_id"]))
        if row["variant_id"] is not None:
            conn.execute(
                "UPDATE product_variants SET stock_qty=stock_qty+? "
                "WHERE id=? AND stock_qty IS NOT NULL",
                (row["qty"], row["variant_id"]))
            conn.execute(
                "INSERT INTO stock_movements"
                "(variant_id,order_item_id,delta,reason,created_at,actor)"
                " VALUES(?,?,?,'cancel',?,?)",
                (row["variant_id"], row["id"], int(row["qty"]),
                 time.time(), "system"))
        conn.execute("UPDATE order_items SET stock_debited=0 WHERE id=?", (row["id"],))

def parse_modifiers(raw):
    if not isinstance(raw, list) or len(raw) > 30:
        raise ApiError(400, "Modifiers must be a list of at most 30 options")
    out, seen = [], set()
    for modifier in raw:
        if not isinstance(modifier, dict):
            raise ApiError(400, "Invalid modifier")
        name = str(modifier.get("name") or "").strip()[:80]
        try:
            price = round(float(modifier.get("price", 0)), 2)
        except (TypeError, ValueError):
            raise ApiError(400, "Invalid modifier price")
        if not name or not math.isfinite(price) or price < 0 or name in seen:
            raise ApiError(400, "Modifier names must be unique and prices non-negative")
        seen.add(name)
        out.append({"name": name, "price": price})
    return out

# ---------------------------------------------------------------- ticket / printing

TICKET_W = 42

def ticket_text(order, lang="fr"):
    """Plain-text ticket for 80mm (42 col) thermal printers."""
    cfg = CONFIG
    labels = {
        "fr": {
            "ticket": "Ticket", "table": "Table", "waiter": "Serveur",
            "cancelled": "ANNULÉ", "ready": "PRÊT", "total": "TOTAL",
            "order_cancelled": "COMMANDE ANNULÉE", "reason": "Motif",
        },
        "ar": {
            "ticket": "تذكرة", "table": "طاولة", "waiter": "النادل",
            "cancelled": "ملغى", "ready": "جاهز", "total": "المجموع",
            "order_cancelled": "تم إلغاء الطلب", "reason": "السبب",
        },
        "en": {
            "ticket": "Ticket", "table": "Table", "waiter": "Waiter",
            "cancelled": "CANCELLED", "ready": "READY", "total": "TOTAL",
            "order_cancelled": "ORDER CANCELLED", "reason": "Reason",
        },
    }
    labels = labels.get(lang, labels["en"])
    sep = "-" * TICKET_W
    created = time.strftime("%d/%m/%Y %H:%M", time.localtime(order["created_at"]))
    out = []
    out.append(cfg["restaurant_name"][:TICKET_W].center(TICKET_W).rstrip())
    out.append(sep)
    out.append("%s #%d" % (labels["ticket"], order["id"]))
    out.append("%s: %s" % (labels["table"], order["table_no"]))
    out.append("%s: %s" % (labels["waiter"], order["staff_name"] or "-"))
    out.append(created)
    if order.get("note"):
        out.append("** %s **" % order["note"])
    out.append(sep)
    for l in order["lines"]:
        if l["status"] == "cancelled":
            name = l["name"]
            if l.get("variant_name"):
                name = "%s (%s)" % (name, l["variant_name"])
            out.append("%dx %-24s %s" % (l["qty"], name[:24], labels["cancelled"]))
            continue
        line = "%dx %s" % (l["qty"], l["name"][:TICKET_W - 12])
        if l.get("variant_name"):
            line = "%dx %s (%s)" % (l["qty"], l["name"][:TICKET_W - 20],
                                     l["variant_name"][:8])
        snapshot_cents = l.get("unit_price_cents")
        snapshot_price = (snapshot_cents / 100.0) if snapshot_cents is not None else l["price"]
        amt = "%0.2f %s" % (snapshot_price * l["qty"], cfg.get("currency") or "MAD")
        out.append(line.ljust(TICKET_W - len(amt)) + amt)
        try:
            modifiers = json.loads(l.get("modifiers") or "[]")
        except (TypeError, ValueError):
            modifiers = []
        if not modifiers and l.get("modifiers_json"):
            try:
                modifiers = json.loads(l["modifiers_json"] or "[]")
            except (TypeError, ValueError):
                modifiers = []
        if modifiers:
            modifier_text = ", ".join(str(m.get("name") or "") for m in modifiers)
            prefix = "  + "
            width = TICKET_W - len(prefix)
            for i in range(0, len(modifier_text), width):
                chunk = modifier_text[i:i + width]
                out.append((prefix if i == 0 else "    ") + chunk)
        if l["note"]:
            for sub in [l["note"][i:i + TICKET_W - 4] for i in range(0, len(l["note"]), TICKET_W - 4)]:
                out.append("   . " + sub)
        if l["status"] == "ready":
            out.append("   . " + labels["ready"])
    out.append(sep)
    tot = "%0.2f %s" % (order["total"], cfg.get("currency") or "MAD")
    out.append(labels["total"].ljust(TICKET_W - len(tot)) + tot)
    out.append(sep)
    if order["status"] == "cancelled":
        out.append("*** %s ***" % labels["order_cancelled"].center(TICKET_W - 8))
        if order.get("cancel_reason"):
            out.append(labels["reason"] + ": " + order["cancel_reason"])
    return "\n".join(out)

def escpos_bytes(text):
    b = b"\x1b@"                      # init
    b += b"\x1ba\x01"                 # center
    header, rest = text.split("\n", 1)
    b += header.encode("cp437", errors="replace") + b"\n"
    b += b"\x1ba\x00"                 # left
    b += rest.encode("cp437", errors="replace") + b"\n\n\n"
    b += b"\x1dV\x01"                 # full cut
    return b

def send_escpos(text):
    """Send raw ESC/POS to a network thermal printer. Returns (ok, error)."""
    ip = (CONFIG.get("printer_ip") or "").strip()
    if not ip:
        return False, "No printer configured"
    port = int(CONFIG.get("printer_port") or 9100)
    try:
        s = socket.create_connection((ip, port), timeout=4)
        try:
            s.sendall(escpos_bytes(text))
        finally:
            s.close()
        return True, ""
    except Exception as e:
        return False, str(e)

def save_ticket(order, text):
    try:
        os.makedirs(TICKETS_DIR, exist_ok=True)
        path = os.path.join(TICKETS_DIR, "ticket_%d_%s.txt" % (order["id"],
                        time.strftime("%Y%m%d_%H%M%S")))
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path
    except Exception:
        return ""

def print_ticket(order_id):
    conn = db()
    try:
        order = get_order(conn, order_id)
    finally:
        conn.close()
    text = ticket_text(order, order.get("lang", "fr"))
    save_ticket(order, text)
    ok, err = send_escpos(text)
    return {"ok": True, "printed": ok, "error": err, "ticket": text}

def maybe_autoprint(order_id):
    if CONFIG.get("autoprint") and (CONFIG.get("printer_ip") or "").strip():
        threading.Thread(target=lambda: (lambda r: print("autoprint #%d: %s" %
            (order_id, "ok" if r["printed"] else r["error"])))(print_ticket(order_id)),
            daemon=True).start()

TICKET_HTML = """<!doctype html><html lang="%(lang)s" dir="%(dir)s"><head><meta charset="utf-8">
<title>%(ticket)s #%(id)d</title><style>
@page { size: 80mm auto; margin: 3mm; }
body { font: 12px/1.35 "Courier New", monospace; white-space: pre; margin: 0; direction: %(dir)s; text-align: %(align)s; }
@media print { .noprint { display: none } }
.noprint { padding: 8px; text-align: center; }
.noprint button { font-size: 16px; padding: 10px 22px; }
</style></head><body>
<div class="noprint"><button onclick="window.print()">%(print_label)s #%(id)d</button></div>
%(body)s
</body></html>"""

def ticket_html(order_id, lang="en"):
    if lang not in ("fr", "ar", "en"):
        lang = "en"
    conn = db()
    try:
        order = get_order(conn, order_id)
    finally:
        conn.close()
    text = ticket_text(order, lang).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    labels = {"fr": ("Imprimer le ticket", "right"), "ar": ("طباعة التذكرة", "right"),
              "en": ("Print ticket", "left")}
    print_label, align = labels[lang]
    return TICKET_HTML % {
        "id": order_id, "body": "<div>%s</div>" % text, "lang": lang,
        "dir": "rtl" if lang == "ar" else "ltr", "align": align,
        "ticket": {"fr": "Ticket", "ar": "تذكرة", "en": "Ticket"}[lang],
        "print_label": print_label,
    }

# ---------------------------------------------------------------- API handlers

def h_ticket(args, body, conn):
    order_id = int(args[0])
    order = get_order(conn, order_id, with_lines=False)
    if order["branch_id"] != get_branch_id(body):
        raise ApiError(404, "Order not found")
    return ticket_html(order_id, body.get("lang", "fr"))

def h_state(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    cutoff = time.time() - 86400

    # Build a quick lookup: item_id -> kitchen_station (via sections join)
    station_by_item = {}
    for row in conn.execute(
            "SELECT i.id item_id, s.kitchen_station FROM items i "
            "JOIN sections s ON s.id=i.section_id WHERE i.branch_id=?", (branch_id,)):
        station_by_item[row["item_id"]] = row["kitchen_station"] or ""
    station_by_variant = {}
    for row in conn.execute(
            "SELECT v.id variant_id,s.kitchen_station "
            "FROM product_variants v "
            "JOIN products p ON p.id=v.product_id "
            "JOIN sections s ON s.id=p.section_id "
            "WHERE s.branch_id=?", (branch_id,)):
        station_by_variant[row["variant_id"]] = row["kitchen_station"] or ""

    orders = [dict(r) for r in conn.execute(
        "SELECT * FROM orders WHERE branch_id=? AND "
        "(status IN ('sent','preparing','ready') OR created_at > ?) "
        "ORDER BY created_at DESC LIMIT 300", (branch_id, cutoff))]
    for o in orders:
        o["lines"] = [dict(r) for r in conn.execute(
            "SELECT * FROM order_items WHERE order_id=? ORDER BY id", (o["id"],))]
        for line in o["lines"]:
            line["kitchen_station"] = (
                station_by_variant.get(line.get("variant_id"))
                if line.get("variant_id") is not None
                else station_by_item.get(line.get("item_id"), "")
            ) or ""
            line["paid_qty"] = conn.execute(
                "SELECT COALESCE(SUM(pa.qty * (p.amount-p.refunded_amount)/p.amount),0) q "
                "FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id "
                "WHERE p.order_id=? AND pa.order_item_id=? AND p.amount>0",
                (o["id"], line["id"])).fetchone()["q"]
        o["total"] = order_total(o["lines"])
        o["paid"] = round(sum(payment["amount"] for payment in conn.execute(
            "SELECT amount-refunded_amount amount FROM payments WHERE order_id=?", (o["id"],))), 2)
        o["balance"] = round(o["total"] - o["paid"], 2)
        o["payments"] = [dict(payment) for payment in conn.execute(
            "SELECT * FROM payments WHERE order_id=? ORDER BY created_at", (o["id"],))]
        # Compute kitchen_stations: distinct non-empty stations from active (non-cancelled) lines
        stations_seen = set()
        for line in o["lines"]:
            if line["status"] != "cancelled":
                ks = line.get("kitchen_station") or ""
                if ks:
                    stations_seen.add(ks)
        o["kitchen_stations"] = sorted(stations_seen)

    # Build staff list: include has_pin, role, kitchen_station; never include pin hash
    raw_staff = [dict(r) for r in conn.execute(
        "SELECT * FROM staff WHERE branch_id=? ORDER BY id", (branch_id,))]
    staff_out = []
    for s in raw_staff:
        s["has_pin"] = bool(s.get("pin", ""))
        s.pop("pin", None)
        s.setdefault("role", "waiter")
        s.setdefault("kitchen_station", "")
        staff_out.append(s)

    return {
        "branch_id": branch_id,
        "rev": get_rev(conn),
        "now": time.time(),
        "restaurant": CONFIG["restaurant_name"],
        "currency": CONFIG["currency"],
        "has_printer": bool((CONFIG.get("printer_ip") or "").strip()),
        "settings": {k: CONFIG.get(k) for k in
                     ("restaurant_name", "currency", "printer_ip", "printer_port", "autoprint",
                      "disk_warning_mb", "log_retention_days",
                      "ticket_amber_minutes", "ticket_red_minutes")},
        "branches": [dict(r) for r in conn.execute(
            "SELECT * FROM branches WHERE active=1 ORDER BY id")],
        "sections": [dict(r) for r in conn.execute(
            "SELECT * FROM sections WHERE branch_id=? ORDER BY position, id", (branch_id,))],
        "items": [dict(r) for r in conn.execute(
            "SELECT * FROM items WHERE branch_id=? ORDER BY position, id", (branch_id,))],
        "staff": staff_out,
        "reservations": [dict(r) for r in conn.execute(
            "SELECT * FROM reservations WHERE branch_id=? AND starts_at>=? "
            "ORDER BY starts_at LIMIT 300", (branch_id, cutoff))],
        "payments": [dict(payment) for order in orders for payment in conn.execute(
            "SELECT * FROM payments WHERE order_id=? ORDER BY created_at", (order["id"],))],
        "orders": orders,
    }

def h_staff_auth(args, body, conn):
    """POST /api/staff/auth — no admin required."""
    staff_id = body.get("staff_id")
    pin_input = str(body.get("pin") or "")
    if not staff_id:
        raise ApiError(400, "staff_id required")
    row = conn.execute("SELECT * FROM staff WHERE id=? AND active=1", (staff_id,)).fetchone()
    if not row:
        raise ApiError(403, "Forbidden")
    stored_pin = row["pin"] if "pin" in row.keys() else ""
    if not stored_pin:
        raise ApiError(403, "Ask the administrator to set your password")
    hashed_input = hashlib.sha256(pin_input.encode()).hexdigest()
    if hashed_input != stored_pin:
        raise ApiError(403, "Wrong PIN")
    return {
        "ok": True,
        "staff_id": row["id"],
        "name": row["name"],
        "role": row["role"] if "role" in row.keys() else "waiter",
        "kitchen_station": row["kitchen_station"] if "kitchen_station" in row.keys() else "",
    }

def h_catalog_order_create(body, conn, branch_id):
    table_no = body.get("table_no")
    if isinstance(table_no, bool) or not isinstance(table_no, int) or table_no <= 0:
        raise ApiError(400, "table_no must be a positive integer")
    lines = body.get("lines") or []
    if not isinstance(lines, list) or not lines:
        raise ApiError(400, "Order has no items")
    uuid = str(body.get("client_uuid") or "")
    if uuid:
        existing = conn.execute("SELECT id,branch_id FROM orders WHERE uuid=?", (uuid,)).fetchone()
        if existing:
            if existing["branch_id"] != branch_id:
                raise ApiError(409, "Client order ID is already used by another branch")
            return {"ok": True, "order_id": existing["id"], "duplicate": True}
    staff_id = body.get("staff_id")
    staff_name = ""
    if staff_id:
        staff = conn.execute("SELECT name FROM staff WHERE id=? AND branch_id=?",
                             (staff_id, branch_id)).fetchone()
        if not staff:
            raise ApiError(400, "Waiter does not belong to this branch")
        staff_name = staff["name"]
    now = time.time()
    order = conn.execute(
        "INSERT INTO orders(uuid,table_no,staff_id,staff_name,note,status,created_at,"
        "updated_at,branch_id,lang) VALUES(?,?,?,?,?, 'sent',?,?,?,?)",
        (uuid or None, table_no, staff_id, staff_name,
         str(body.get("note") or "")[:300], now, now, branch_id,
         body.get("lang") if body.get("lang") in ("fr", "ar", "en") else "fr"))
    order_id = order.lastrowid
    try:
        for line in lines:
            if not isinstance(line, dict):
                conn.rollback()
                raise ApiError(400, "Invalid order line")
            try:
                qty = int(line.get("qty", 1))
                if qty != line.get("qty", 1):
                    raise ValueError()
            except (TypeError, ValueError):
                conn.rollback()
                raise ApiError(400, "Invalid item quantity")
            if qty < 1 or qty > 50:
                conn.rollback()
                raise ApiError(400, "Item quantity must be between 1 and 50")
            product_id = int(line["product_id"])
            variant_id = int(line["variant_id"])
            product = require_product(conn, product_id, branch_id)
            variant = require_variant(conn, variant_id, product_id, branch_id)
            if not variant["active"]:
                conn.rollback()
                raise ApiError(409, "Variant is inactive")
            if variant["stock_qty"] is not None:
                updated = conn.execute(
                    "UPDATE product_variants SET stock_qty=stock_qty-? "
                    "WHERE id=? AND stock_qty IS NOT NULL AND stock_qty>=?",
                    (qty, variant_id, qty))
                if updated.rowcount != 1:
                    conn.rollback()
                    raise ApiError(409, "%s is out of stock" % product["name"])
            selected_ids = line.get("modifier_option_ids") or []
            if not isinstance(selected_ids, list):
                conn.rollback()
                raise ApiError(400, "Invalid selected modifiers")
            if len(selected_ids) != len(set(selected_ids)):
                conn.rollback()
                raise ApiError(400, "Duplicate modifier option")
            effective = {}
            for attachment in conn.execute(
                    "SELECT pmg.*,g.selection_type,g.min_select,g.max_select "
                    "FROM product_modifier_groups pmg "
                    "JOIN modifier_groups g ON g.id=pmg.modifier_group_id "
                    "WHERE pmg.product_id=?", (product_id,)):
                minimum = attachment["override_min"] if attachment["override_min"] is not None else attachment["min_select"]
                maximum = attachment["override_max"] if attachment["override_max"] is not None else attachment["max_select"]
                effective[attachment["modifier_group_id"]] = {
                    "name": attachment["name"] if "name" in attachment.keys() else "",
                    "minimum": minimum,
                    "maximum": maximum,
                }
            actual_modifiers = []
            selected_by_group = {}
            attached_group_ids = set(effective)
            for raw_id in selected_ids:
                option = conn.execute(
                    "SELECT o.*,g.branch_id,g.name group_name "
                    "FROM modifier_options o "
                    "JOIN modifier_groups g ON g.id=o.modifier_group_id "
                    "WHERE o.id=? AND o.active=1", (int(raw_id),)).fetchone()
                if not option or option["branch_id"] != branch_id:
                    conn.rollback()
                    raise ApiError(400, "Unknown modifier option")
                if option["modifier_group_id"] not in attached_group_ids:
                    conn.rollback()
                    raise ApiError(400, "Modifier option does not belong to this product")
                selected_by_group.setdefault(option["modifier_group_id"], 0)
                selected_by_group[option["modifier_group_id"]] += 1
                actual_modifiers.append({
                    "id": option["id"],
                    "name": option["name"],
                    "delta": option["price_delta_cents"],
                })
            for group_id, bounds in effective.items():
                selected_count = selected_by_group.get(group_id, 0)
                if selected_count < bounds["minimum"]:
                    conn.rollback()
                    raise ApiError(400, "Required modifier selection missing")
                if selected_count > bounds["maximum"]:
                    conn.rollback()
                    raise ApiError(400, "Modifier selection exceeds maximum")
            unit_price_cents = variant["price_cents"] + sum(
                modifier["delta"] for modifier in actual_modifiers)
            if unit_price_cents < 0:
                conn.rollback()
                raise ApiError(400, "Unit price cannot be negative")
            line_row = conn.execute(
                "INSERT INTO order_items"
                "(order_id,item_id,name,price,qty,note,status,modifiers,"
                "stock_debited,variant_id,variant_name,modifiers_json,unit_price_cents)"
                " VALUES(?,?,?,?,?,?, 'sent',?,?,?,?,?,?)",
                (order_id, None, product["name"], unit_price_cents / 100.0, qty,
                 str(line.get("note") or "")[:200],
                 json.dumps(actual_modifiers, ensure_ascii=False),
                 int(variant["stock_qty"] is not None),
                 variant_id, variant["name"],
                 json.dumps(actual_modifiers, ensure_ascii=False),
                 unit_price_cents))
            if variant["stock_qty"] is not None:
                conn.execute(
                    "INSERT INTO stock_movements"
                    "(variant_id,order_item_id,delta,reason,created_at,actor)"
                    " VALUES(?,?,?,'order_accept',?,?)",
                    (variant_id, line_row.lastrowid, -qty, now, "system"))
        bump_rev(conn)
        conn.commit()
    except ApiError:
        conn.rollback()
        raise
    except Exception:
        conn.rollback()
        raise
    maybe_autoprint(order_id)
    return {"ok": True, "order_id": order_id}

def h_order_create(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    table_no = body.get("table_no")
    if isinstance(table_no, bool) or not isinstance(table_no, int) or table_no <= 0:
        raise ApiError(400, "table_no must be a positive integer")
    lines = body.get("lines") or []
    if not lines:
        raise ApiError(400, "Order has no items")
    if any(isinstance(line, dict) and "product_id" in line for line in lines):
        if not all(isinstance(line, dict) and "product_id" in line for line in lines):
            raise ApiError(400, "Mixed legacy and catalog order lines are not supported")
        return h_catalog_order_create(body, conn, branch_id)
    # idempotency: same client_uuid returns the already-created order
    uuid = str(body.get("client_uuid") or "")
    if uuid:
        existing = conn.execute("SELECT id,branch_id FROM orders WHERE uuid=?", (uuid,)).fetchone()
        if existing:
            if existing["branch_id"] != branch_id:
                raise ApiError(409, "Client order ID is already used by another branch")
            return {"ok": True, "order_id": existing["id"], "duplicate": True}
    staff_id = body.get("staff_id")
    staff_name = ""
    if staff_id:
        s = conn.execute("SELECT name FROM staff WHERE id=? AND branch_id=?",
                         (staff_id, branch_id)).fetchone()
        if not s:
            raise ApiError(400, "Waiter does not belong to this branch")
        staff_name = s["name"]
    now = time.time()
    cur = conn.execute(
        "INSERT INTO orders(uuid, table_no, staff_id, staff_name, note, status, created_at, updated_at, branch_id, lang) "
        "VALUES(?,?,?,?,?,'sent',?,?,?,?)",
        (uuid or None, table_no, staff_id, staff_name, str(body.get("note") or "")[:300], now, now,
         branch_id, body.get("lang") if body.get("lang") in ("fr", "ar", "en") else "fr"))
    order_id = cur.lastrowid
    for l in lines:
        try:
            raw_qty = float(l.get("qty", 1))
            if not math.isfinite(raw_qty) or not raw_qty.is_integer():
                raise ValueError()
            qty = int(raw_qty)
        except (TypeError, ValueError):
            conn.rollback()
            raise ApiError(400, "Invalid item quantity")
        if qty < 1 or qty > 50:
            conn.rollback()
            raise ApiError(400, "Item quantity must be between 1 and 50")
        it = conn.execute("SELECT * FROM items WHERE id=? AND branch_id=? AND active=1",
                          (l.get("item_id"), branch_id)).fetchone()
        if not it:
            continue
        mapping = conn.execute(
            "SELECT variant_id FROM catalog_migration_items WHERE item_id=?",
            (it["id"],)).fetchone()
        variant_id = mapping["variant_id"] if mapping else None
        if variant_id is not None:
            variant = conn.execute(
                "SELECT stock_qty FROM product_variants WHERE id=?",
                (variant_id,)).fetchone()
            available = variant["stock_qty"] if variant else None
        else:
            available = it["stock_qty"]
        if available is not None and available < qty:
            conn.rollback()
            raise ApiError(409, "%s is out of stock" % it["name"])
        allowed_modifiers = json.loads(it["modifiers"] or "[]")
        selected = l.get("modifiers") or []
        if not isinstance(selected, list):
            conn.rollback()
            raise ApiError(400, "Invalid selected modifiers")
        selected_names = {str(m.get("name") or "") for m in selected if isinstance(m, dict)}
        actual_modifiers = [m for m in allowed_modifiers if m["name"] in selected_names]
        if len(actual_modifiers) != len(selected_names):
            conn.rollback()
            raise ApiError(400, "Unknown item modifier")
        unit_price = round(it["price"] + sum(m["price"] for m in actual_modifiers), 2)
        stock_debited = int(available is not None)
        if stock_debited:
            conn.execute("UPDATE items SET stock_qty=stock_qty-? WHERE id=? AND branch_id=?",
                         (qty, it["id"], branch_id))
        if variant_id is not None and available is not None:
            variant_update = conn.execute(
                "UPDATE product_variants SET stock_qty=stock_qty-? "
                "WHERE id=? AND stock_qty IS NOT NULL AND stock_qty>=?",
                (qty, variant_id, qty))
            if variant_update.rowcount != 1:
                conn.rollback()
                raise ApiError(409, "%s is out of stock" % it["name"])
        line = conn.execute(
            "INSERT INTO order_items(order_id, item_id, name, price, qty, note, status, modifiers, stock_debited) "
            "VALUES(?,?,?,?,?,?, 'sent',?,?)",
            (order_id, it["id"], it["name"], unit_price, qty, str(l.get("note") or "")[:200],
             json.dumps(actual_modifiers, ensure_ascii=False), stock_debited))
        if variant_id is not None:
            conn.execute(
                "UPDATE order_items SET variant_id=?, variant_name='Regular', "
                "modifiers_json=? WHERE id=?",
                (variant_id, json.dumps(actual_modifiers, ensure_ascii=False),
                 line.lastrowid))
            if available is not None:
                conn.execute(
                    "INSERT INTO stock_movements"
                    "(variant_id,order_item_id,delta,reason,created_at,actor)"
                    " VALUES(?,?,?,'order_accept',?,?)",
                    (variant_id, line.lastrowid, -int(qty), time.time(), "system"))
    n = conn.execute("SELECT COUNT(*) c FROM order_items WHERE order_id=?", (order_id,)).fetchone()["c"]
    if n == 0:
        conn.execute("DELETE FROM orders WHERE id=?", (order_id,))
        raise ApiError(400, "No valid items in order")
    bump_rev(conn)
    conn.commit()
    maybe_autoprint(order_id)
    return {"ok": True, "order_id": order_id}

def h_order_status(args, body, conn):
    branch_id = get_branch_id(body)
    order_id = int(args[0])
    status = body.get("status")
    if status not in ("preparing", "ready", "served", "cancelled"):
        raise ApiError(400, "Bad status")
    order = get_order(conn, order_id, with_lines=False)
    if order["branch_id"] != branch_id:
        raise ApiError(404, "Order not found")
    if order["status"] == "served" and status != "served":
        reason = str(body.get("reopen_reason") or "").strip()
        if not reason:
            raise ApiError(400, "A reopen reason is required")
    if status == "cancelled" and conn.execute(
            "SELECT 1 FROM payments WHERE order_id=? AND amount>refunded_amount LIMIT 1",
            (order_id,)).fetchone():
        raise ApiError(409, "Refund recorded payments before cancelling this order")
    conn.execute("UPDATE orders SET status=?, updated_at=? WHERE id=?",
                 (status, time.time(), order_id))
    if status == "cancelled":
        conn.execute("UPDATE orders SET cancel_reason=? WHERE id=?",
                     (str(body.get("reason") or "")[:300], order_id))
        conn.execute("UPDATE order_items SET status='cancelled' WHERE order_id=? AND status!='served'",
                     (order_id,))
        restore_stock(conn, order_id)
    elif status == "preparing":
        conn.execute("UPDATE order_items SET status='preparing' WHERE order_id=? AND status='sent'",
                     (order_id,))
    elif status == "ready":
        conn.execute("UPDATE order_items SET status='ready' WHERE order_id=? AND status IN ('sent','preparing')",
                     (order_id,))
    bump_rev(conn)
    conn.commit()
    return {"ok": True}

def h_line_status(args, body, conn):
    branch_id = get_branch_id(body)
    order_id, line_id = int(args[0]), int(args[1])
    status = body.get("status")
    if status not in ("sent", "preparing", "ready", "cancelled"):
        raise ApiError(400, "Bad status")
    li = conn.execute("SELECT * FROM order_items WHERE id=? AND order_id=?",
                      (line_id, order_id)).fetchone()
    if not li:
        raise ApiError(404, "Line not found")
    order = conn.execute("SELECT branch_id FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order or order["branch_id"] != branch_id:
        raise ApiError(404, "Order not found")
    if status == "cancelled" and conn.execute(
            "SELECT 1 FROM payments WHERE order_id=? AND amount>refunded_amount LIMIT 1",
            (order_id,)).fetchone():
        raise ApiError(409, "Refund recorded payments before cancelling an item")
    conn.execute("UPDATE order_items SET status=? WHERE id=?", (status, line_id))
    if status == "cancelled":
        restore_stock(conn, order_id, line_id)
        conn.execute("UPDATE orders SET cancel_reason=CASE WHEN cancel_reason='' "
                     "THEN ? ELSE cancel_reason END WHERE id=?",
                     ("item cancelled: " + li["name"], order_id))
    recompute_order_status(conn, order_id)
    conn.execute("UPDATE orders SET updated_at=? WHERE id=?", (time.time(), order_id))
    bump_rev(conn)
    conn.commit()
    return {"ok": True}

def h_section_create(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    name = str(body.get("name") or "").strip()
    if not name:
        raise ApiError(400, "Name required")
    kitchen_station = str(body.get("kitchen_station") or "").strip()[:100]
    pos = conn.execute("SELECT COALESCE(MAX(position),0)+1 p FROM sections WHERE branch_id=?",
                       (branch_id,)).fetchone()["p"]
    conn.execute("INSERT INTO sections(name, position, active, branch_id, kitchen_station) VALUES(?,?,1,?,?)",
                 (name, pos, branch_id, kitchen_station))
    bump_rev(conn); conn.commit()
    return {"ok": True}

def h_section_update(args, body, conn):
    branch_id = get_branch_id(body)
    sid = int(args[0])
    s = conn.execute("SELECT * FROM sections WHERE id=? AND branch_id=?",
                      (sid, branch_id)).fetchone()
    if not s:
        raise ApiError(404, "Section not found")
    if "name" in body:
        name = str(body["name"]).strip()
        if not name:
            raise ApiError(400, "Name required")
        conn.execute("UPDATE sections SET name=? WHERE id=? AND branch_id=?", (name, sid, branch_id))
    if "kitchen_station" in body:
        conn.execute("UPDATE sections SET kitchen_station=? WHERE id=? AND branch_id=?",
                     (str(body["kitchen_station"] or "").strip()[:100], sid, branch_id))
    if "sort_order" in body:
        conn.execute("UPDATE sections SET position=? WHERE id=? AND branch_id=?",
                     (int(body["sort_order"]), sid, branch_id))
    for k in ("position", "active"):
        if k in body:
            conn.execute("UPDATE sections SET %s=? WHERE id=? AND branch_id=?" % k,
                         (int(body[k]), sid, branch_id))
    bump_rev(conn); conn.commit()
    return {"ok": True}

def h_section_delete(args, body, conn):
    branch_id = get_branch_id(body)
    sid = int(args[0])
    if not conn.execute("SELECT 1 FROM sections WHERE id=? AND branch_id=?", (sid, branch_id)).fetchone():
        raise ApiError(404, "Section not found")
    n = conn.execute("SELECT COUNT(*) c FROM items WHERE section_id=? AND branch_id=?",
                     (sid, branch_id)).fetchone()["c"]
    n += conn.execute(
        "SELECT COUNT(*) c FROM products WHERE section_id=? AND deleted_at IS NULL",
        (sid,)).fetchone()["c"]
    if n:
        raise ApiError(400, "Section still has %d item(s) — move or delete them first" % n)
    conn.execute("DELETE FROM sections WHERE id=? AND branch_id=?", (sid, branch_id))
    bump_rev(conn); conn.commit()
    return {"ok": True}

def sync_catalog_from_item(conn, item_id):
    item = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    if not item:
        return
    mapping = conn.execute(
        "SELECT product_id,variant_id FROM catalog_migration_items WHERE item_id=?",
        (item_id,)).fetchone()
    if mapping:
        product_id = mapping["product_id"]
        variant_id = mapping["variant_id"]
        conn.execute(
            "UPDATE products SET section_id=?,name=?,description=?,image_path=?,"
            "active=?,sort_order=? WHERE id=?",
            (item["section_id"], item["name"], str(item["description"] or ""),
             str(item["image_url"] or ""), int(bool(item["active"])),
             int(item["position"]), product_id))
        conn.execute(
            "UPDATE product_variants SET name='Regular',price_cents=?,stock_qty=?,"
            "is_default=1,active=? WHERE id=?",
            (int(round(float(item["price"]) * 100)),
             item["stock_qty"], int(bool(item["active"])), variant_id))
        return
    product = conn.execute(
        "INSERT INTO products(section_id,name,description,image_path,active,sort_order)"
        " VALUES(?,?,?,?,?,?)",
        (item["section_id"], item["name"], str(item["description"] or ""),
         str(item["image_url"] or ""), int(bool(item["active"])),
         int(item["position"])))
    product_id = product.lastrowid
    variant = conn.execute(
        "INSERT INTO product_variants"
        "(product_id,name,price_cents,stock_qty,is_default,sort_order,active)"
        " VALUES(?, 'Regular', ?, ?, 1, 0, ?)",
        (product_id, int(round(float(item["price"]) * 100)),
         item["stock_qty"], int(bool(item["active"]))))
    conn.execute(
        "INSERT INTO catalog_migration_items(item_id,product_id,variant_id)"
        " VALUES(?,?,?)",
        (item_id, product_id, variant.lastrowid))

def parse_cents(value):
    try:
        if isinstance(value, bool):
            raise ValueError()
        cents = int(value)
        if cents != value:
            raise ValueError()
    except (TypeError, ValueError, OverflowError):
        raise ApiError(400, "Price must be an integer number of cents")
    if cents < 0:
        raise ApiError(400, "Price cannot be negative")
    return cents

def parse_stock(value):
    if value is None:
        return None
    if isinstance(value, bool):
        raise ApiError(400, "Stock must be a non-negative integer or null")
    try:
        stock = int(value)
        if stock != value:
            raise ValueError()
    except (TypeError, ValueError, OverflowError):
        raise ApiError(400, "Stock must be a non-negative integer or null")
    if stock < 0:
        raise ApiError(400, "Stock cannot be negative")
    return stock

def require_product(conn, product_id, branch_id):
    row = conn.execute(
        "SELECT p.* FROM products p JOIN sections s ON s.id=p.section_id "
        "WHERE p.id=? AND s.branch_id=? AND p.deleted_at IS NULL",
        (product_id, branch_id)).fetchone()
    if not row:
        raise ApiError(404, "Product not found")
    return row

def require_variant(conn, variant_id, product_id, branch_id):
    row = conn.execute(
        "SELECT v.* FROM product_variants v "
        "JOIN products p ON p.id=v.product_id "
        "JOIN sections s ON s.id=p.section_id "
        "WHERE v.id=? AND v.product_id=? AND s.branch_id=?",
        (variant_id, product_id, branch_id)).fetchone()
    if not row:
        raise ApiError(404, "Variant not found")
    return row

def validate_variants(conn, product_id, variants):
    if not isinstance(variants, list) or not variants:
        raise ApiError(400, "Product requires at least one variant")
    active_count = sum(1 for v in variants if v.get("active", 1) in (1, True))
    if active_count < 1:
        raise ApiError(400, "Product requires at least one active variant")
    default_count = sum(1 for v in variants if v.get("is_default", 0) in (1, True))
    if default_count != 1:
        raise ApiError(400, "Product requires exactly one default variant")
    names = set()
    normalized = []
    for variant in variants:
        if not isinstance(variant, dict):
            raise ApiError(400, "Invalid variant")
        name = str(variant.get("name") or "").strip()[:80]
        if not name:
            raise ApiError(400, "Variant name required")
        if name in names:
            raise ApiError(400, "Duplicate variant name")
        names.add(name)
        normalized.append({
            "id": variant.get("id"),
            "name": name,
            "price_cents": parse_cents(variant.get("price_cents", 0)),
            "stock_qty": parse_stock(variant.get("stock_qty")),
            "is_default": int(bool(variant.get("is_default", 0))),
            "sort_order": int(variant.get("sort_order", 0)),
            "active": int(bool(variant.get("active", 1))),
        })
    return normalized

def h_catalog_sections(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    return {"sections": [dict(r) for r in conn.execute(
        "SELECT * FROM sections WHERE branch_id=? "
        "ORDER BY position,id", (branch_id,))]}

def h_catalog_products_list(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    section_id = body.get("section_id")
    query = str(body.get("q") or "").strip().lower()
    sql = ("SELECT p.* FROM products p JOIN sections s ON s.id=p.section_id "
           "WHERE s.branch_id=? AND p.deleted_at IS NULL")
    params = [branch_id]
    if section_id:
        sql += " AND p.section_id=?"
        params.append(int(section_id))
    sql += " ORDER BY p.sort_order,p.id"
    out = []
    for row in conn.execute(sql, params):
        product = dict(row)
        if query and query not in product["name"].lower():
            continue
        variants = [dict(v) for v in conn.execute(
            "SELECT * FROM product_variants WHERE product_id=? "
            "ORDER BY sort_order,id", (product["id"],))]
        product["variants"] = variants
        product["modifier_groups"] = [dict(r) for r in conn.execute(
            "SELECT pmg.*,g.name,g.selection_type,g.min_select,g.max_select "
            "FROM product_modifier_groups pmg "
            "JOIN modifier_groups g ON g.id=pmg.modifier_group_id "
            "WHERE pmg.product_id=? ORDER BY pmg.sort_order,g.id",
            (product["id"],))]
        out.append(product)
    return {"products": out}

def h_catalog_product_create(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    section_id = int(body.get("section_id") or 0)
    if not conn.execute("SELECT 1 FROM sections WHERE id=? AND branch_id=?",
                        (section_id, branch_id)).fetchone():
        raise ApiError(400, "Bad section")
    name = str(body.get("name") or "").strip()[:120]
    if not name:
        raise ApiError(400, "Product name required")
    variants = validate_variants(conn, None, body.get("variants"))
    try:
        conn.execute("BEGIN")
        cur = conn.execute(
            "INSERT INTO products(section_id,name,description,image_path,active,sort_order)"
            " VALUES(?,?,?,?,?,?)",
            (section_id, name, str(body.get("description") or "")[:300],
             str(body.get("image_path") or "")[:500],
             int(bool(body.get("active", 1))),
             int(body.get("sort_order", 0))))
        product_id = cur.lastrowid
        for variant in variants:
            conn.execute(
                "INSERT INTO product_variants"
                "(product_id,name,price_cents,stock_qty,is_default,sort_order,active)"
                " VALUES(?,?,?,?,?,?,?)",
                (product_id, variant["name"], variant["price_cents"],
                 variant["stock_qty"], variant["is_default"],
                 variant["sort_order"], variant["active"]))
        attachments = body.get("modifier_groups") or []
        if not isinstance(attachments, list):
            raise ApiError(400, "Invalid modifier groups")
        for attachment in attachments:
            if not isinstance(attachment, dict):
                raise ApiError(400, "Invalid modifier group attachment")
            group_id = int(attachment["modifier_group_id"])
            group = conn.execute(
                "SELECT * FROM modifier_groups WHERE id=? AND branch_id=?",
                (group_id, branch_id)).fetchone()
            if not group:
                raise ApiError(404, "Modifier group not found")
            override_min = attachment.get("override_min")
            override_max = attachment.get("override_max")
            if override_min is not None:
                override_min = int(override_min)
            if override_max is not None:
                override_max = int(override_max)
            min_select = override_min if override_min is not None else group["min_select"]
            max_select = override_max if override_max is not None else group["max_select"]
            if min_select < 0 or max_select < min_select:
                raise ApiError(400, "Invalid modifier group bounds")
            conn.execute(
                "INSERT INTO product_modifier_groups"
                "(product_id,modifier_group_id,sort_order,override_min,override_max)"
                " VALUES(?,?,?,?,?)",
                (product_id, group_id, int(attachment.get("sort_order", 0)),
                 override_min, override_max))
        bump_rev(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"ok": True, "product_id": product_id}

def h_catalog_product_update(args, body, conn):
    branch_id = get_branch_id(body)
    product_id = int(args[0])
    require_product(conn, product_id, branch_id)
    try:
        conn.execute("BEGIN")
        if "section_id" in body:
            section_id = int(body["section_id"])
            if not conn.execute("SELECT 1 FROM sections WHERE id=? AND branch_id=?",
                                (section_id, branch_id)).fetchone():
                raise ApiError(400, "Bad section")
            conn.execute("UPDATE products SET section_id=? WHERE id=?",
                         (section_id, product_id))
        if "name" in body:
            name = str(body["name"] or "").strip()[:120]
            if not name:
                raise ApiError(400, "Product name required")
            conn.execute("UPDATE products SET name=? WHERE id=?", (name, product_id))
        if "description" in body:
            conn.execute("UPDATE products SET description=? WHERE id=?",
                         (str(body["description"] or "")[:300], product_id))
        if "image_path" in body:
            conn.execute("UPDATE products SET image_path=? WHERE id=?",
                         (str(body["image_path"] or "")[:500], product_id))
        if "active" in body:
            conn.execute("UPDATE products SET active=? WHERE id=?",
                         (int(bool(body["active"])), product_id))
        if "sort_order" in body:
            conn.execute("UPDATE products SET sort_order=? WHERE id=?",
                         (int(body["sort_order"]), product_id))
        if "variants" in body:
            variants = validate_variants(conn, product_id, body["variants"])
            existing_ids = {r["id"] for r in conn.execute(
                "SELECT id FROM product_variants WHERE product_id=?",
                (product_id,))}
            submitted_ids = {int(v["id"]) for v in variants if v["id"] is not None}
            for variant_id in existing_ids - submitted_ids:
                referenced = conn.execute(
                    "SELECT 1 FROM order_items WHERE variant_id=? "
                    "AND status!='served' AND status!='cancelled' LIMIT 1",
                    (variant_id,)).fetchone()
                if referenced:
                    raise ApiError(409, "Variant is in use by an open ticket")
                conn.execute("DELETE FROM product_variants WHERE id=?",
                             (variant_id,))
            for variant in variants:
                if variant["id"] is not None:
                    if not conn.execute("SELECT 1 FROM product_variants WHERE id=? AND product_id=?",
                                        (int(variant["id"]), product_id)).fetchone():
                        raise ApiError(404, "Variant not found")
                    conn.execute(
                        "UPDATE product_variants SET name=?,price_cents=?,stock_qty=?,"
                        "is_default=?,sort_order=?,active=? WHERE id=?",
                        (variant["name"], variant["price_cents"], variant["stock_qty"],
                         variant["is_default"], variant["sort_order"],
                         variant["active"], int(variant["id"])))
                else:
                    conn.execute(
                        "INSERT INTO product_variants"
                        "(product_id,name,price_cents,stock_qty,is_default,sort_order,active)"
                        " VALUES(?,?,?,?,?,?,?)",
                        (product_id, variant["name"], variant["price_cents"],
                         variant["stock_qty"], variant["is_default"],
                         variant["sort_order"], variant["active"]))
        if "modifier_groups" in body:
            attachments = body["modifier_groups"]
            if not isinstance(attachments, list):
                raise ApiError(400, "Invalid modifier groups")
            conn.execute("DELETE FROM product_modifier_groups WHERE product_id=?",
                         (product_id,))
            for attachment in attachments:
                if not isinstance(attachment, dict):
                    raise ApiError(400, "Invalid modifier group attachment")
                group_id = int(attachment["modifier_group_id"])
                group = conn.execute(
                    "SELECT * FROM modifier_groups WHERE id=? AND branch_id=?",
                    (group_id, branch_id)).fetchone()
                if not group:
                    raise ApiError(404, "Modifier group not found")
                override_min = attachment.get("override_min")
                override_max = attachment.get("override_max")
                if override_min is not None:
                    override_min = int(override_min)
                if override_max is not None:
                    override_max = int(override_max)
                min_select = override_min if override_min is not None else group["min_select"]
                max_select = override_max if override_max is not None else group["max_select"]
                if min_select < 0 or max_select < min_select:
                    raise ApiError(400, "Invalid modifier group bounds")
                conn.execute(
                    "INSERT INTO product_modifier_groups"
                    "(product_id,modifier_group_id,sort_order,override_min,override_max)"
                    " VALUES(?,?,?,?,?)",
                    (product_id, group_id, int(attachment.get("sort_order", 0)),
                     override_min, override_max))
        bump_rev(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"ok": True}

def h_catalog_product_delete(args, body, conn):
    branch_id = get_branch_id(body)
    product_id = int(args[0])
    require_product(conn, product_id, branch_id)
    referenced = conn.execute(
        "SELECT 1 FROM order_items WHERE variant_id IN "
        "(SELECT id FROM product_variants WHERE product_id=?) "
        "AND status IN ('sent','preparing','ready') LIMIT 1",
        (product_id,)).fetchone()
    if referenced:
        raise ApiError(409, "Product is in use by an open ticket")
    conn.execute("UPDATE products SET deleted_at=? WHERE id=?",
                 (datetime.datetime.now().isoformat(), product_id))
    bump_rev(conn)
    conn.commit()
    return {"ok": True}

def h_catalog_variants_list(args, body, conn):
    branch_id = get_branch_id(body)
    product_id = int(args[0])
    require_product(conn, product_id, branch_id)
    return {"variants": [dict(r) for r in conn.execute(
        "SELECT * FROM product_variants WHERE product_id=? "
        "ORDER BY sort_order,id", (product_id,))]}

def h_catalog_variant_create(args, body, conn):
    branch_id = get_branch_id(body)
    product_id = int(args[0])
    require_product(conn, product_id, branch_id)
    name = str(body.get("name") or "").strip()[:80]
    if not name:
        raise ApiError(400, "Variant name required")
    variant = {
        "name": name,
        "price_cents": parse_cents(body.get("price_cents", 0)),
        "stock_qty": parse_stock(body.get("stock_qty")),
        "is_default": int(bool(body.get("is_default", 0))),
        "sort_order": int(body.get("sort_order", 0)),
        "active": int(bool(body.get("active", 1))),
    }
    if variant["is_default"]:
        conn.execute("UPDATE product_variants SET is_default=0 "
                     "WHERE product_id=? AND is_default=1", (product_id,))
    try:
        cur = conn.execute(
            "INSERT INTO product_variants"
            "(product_id,name,price_cents,stock_qty,is_default,sort_order,active)"
            " VALUES(?,?,?,?,?,?,?)",
            (product_id, variant["name"], variant["price_cents"],
             variant["stock_qty"], variant["is_default"],
             variant["sort_order"], variant["active"]))
        bump_rev(conn)
        conn.commit()
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        raise ApiError(400, "Duplicate variant name")
    return {"ok": True, "variant_id": cur.lastrowid}

def h_catalog_variant_update(args, body, conn):
    branch_id = get_branch_id(body)
    variant_id = int(args[0])
    row = conn.execute(
        "SELECT v.*,p.id product_id FROM product_variants v "
        "JOIN products p ON p.id=v.product_id "
        "JOIN sections s ON s.id=p.section_id "
        "WHERE v.id=? AND s.branch_id=?", (variant_id, branch_id)).fetchone()
    if not row:
        raise ApiError(404, "Variant not found")
    product_id = row["product_id"]
    if "is_default" in body and int(bool(body["is_default"])):
        conn.execute("UPDATE product_variants SET is_default=0 "
                     "WHERE product_id=?", (product_id,))
    fields = []
    values = []
    for key, column in (("name", "name"), ("price_cents", "price_cents"),
                        ("stock_qty", "stock_qty"), ("sort_order", "sort_order"),
                        ("active", "active"), ("is_default", "is_default")):
        if key not in body:
            continue
        if key == "name":
            value = str(body[key] or "").strip()[:80]
            if not value:
                raise ApiError(400, "Variant name required")
        elif key == "price_cents":
            value = parse_cents(body[key])
        elif key == "stock_qty":
            value = parse_stock(body[key])
        elif key == "is_default":
            value = int(bool(body[key]))
        else:
            value = int(body[key])
        fields.append("%s=?" % column)
        values.append(value)
    if fields:
        values.append(variant_id)
        try:
            conn.execute("UPDATE product_variants SET %s WHERE id=?"
                         % ",".join(fields), values)
        except sqlite3.IntegrityError:
            raise ApiError(400, "Duplicate variant name")
    defaults = conn.execute(
        "SELECT COUNT(*) c FROM product_variants "
        "WHERE product_id=? AND is_default=1", (product_id,)).fetchone()["c"]
    active = conn.execute(
        "SELECT COUNT(*) c FROM product_variants "
        "WHERE product_id=? AND active=1", (product_id,)).fetchone()["c"]
    if defaults != 1:
        raise ApiError(400, "Product requires exactly one default variant")
    if active < 1:
        raise ApiError(400, "Product requires at least one active variant")
    bump_rev(conn)
    conn.commit()
    return {"ok": True}

def h_catalog_variants_replace(args, body, conn):
    branch_id = get_branch_id(body)
    product_id = int(args[0])
    require_product(conn, product_id, branch_id)
    variants = validate_variants(conn, product_id, body.get("variants"))
    try:
        conn.execute("BEGIN")
        existing = {r["id"] for r in conn.execute(
            "SELECT id FROM product_variants WHERE product_id=?", (product_id,))}
        submitted_ids = {int(v["id"]) for v in variants if v["id"] is not None}
        for variant_id in existing - submitted_ids:
            if conn.execute(
                    "SELECT 1 FROM order_items WHERE variant_id=? "
                    "AND status IN ('sent','preparing','ready') LIMIT 1",
                    (variant_id,)).fetchone():
                raise ApiError(409, "Variant is in use by an open ticket")
        conn.execute("DELETE FROM product_variants "
                     "WHERE product_id=? AND id NOT IN (%s)" %
                     ",".join("?" for _ in submitted_ids),
                     (product_id, *submitted_ids)) if submitted_ids else conn.execute(
                         "DELETE FROM product_variants WHERE product_id=?",
                         (product_id,))
        for variant in variants:
            if variant["id"] is not None:
                conn.execute(
                    "UPDATE product_variants SET name=?,price_cents=?,stock_qty=?,"
                    "is_default=?,sort_order=?,active=? WHERE id=? AND product_id=?",
                    (variant["name"], variant["price_cents"], variant["stock_qty"],
                     variant["is_default"], variant["sort_order"], variant["active"],
                     int(variant["id"]), product_id))
            else:
                conn.execute(
                    "INSERT INTO product_variants"
                    "(product_id,name,price_cents,stock_qty,is_default,sort_order,active)"
                    " VALUES(?,?,?,?,?,?,?)",
                    (product_id, variant["name"], variant["price_cents"],
                     variant["stock_qty"], variant["is_default"],
                     variant["sort_order"], variant["active"]))
        bump_rev(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"ok": True}

def h_catalog_variant_delete(args, body, conn):
    branch_id = get_branch_id(body)
    variant_id = int(args[0])
    row = conn.execute(
        "SELECT v.*,p.id product_id FROM product_variants v "
        "JOIN products p ON p.id=v.product_id "
        "JOIN sections s ON s.id=p.section_id "
        "WHERE v.id=? AND s.branch_id=?", (variant_id, branch_id)).fetchone()
    if not row:
        raise ApiError(404, "Variant not found")
    referenced = conn.execute(
        "SELECT 1 FROM order_items WHERE variant_id=? "
        "AND status IN ('sent','preparing','ready') LIMIT 1",
        (variant_id,)).fetchone()
    if referenced:
        raise ApiError(409, "Variant is in use by an open ticket")
    remaining = conn.execute(
        "SELECT COUNT(*) c FROM product_variants WHERE product_id=?",
        (row["product_id"],)).fetchone()["c"]
    if remaining <= 1:
        raise ApiError(400, "Product requires at least one variant")
    conn.execute("DELETE FROM product_variants WHERE id=?", (variant_id,))
    defaults = conn.execute(
        "SELECT COUNT(*) c FROM product_variants "
        "WHERE product_id=? AND is_default=1",
        (row["product_id"],)).fetchone()["c"]
    if defaults == 0:
        replacement = conn.execute(
            "SELECT id FROM product_variants WHERE product_id=? AND active=1 "
            "ORDER BY sort_order,id LIMIT 1",
            (row["product_id"],)).fetchone()
        if replacement:
            conn.execute("UPDATE product_variants SET is_default=1 WHERE id=?",
                         (replacement["id"],))
    bump_rev(conn)
    conn.commit()
    return {"ok": True}

def h_items_list(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    out = []
    for row in conn.execute(
            "SELECT i.*,v.id variant_id,v.price_cents,v.stock_qty variant_stock "
            "FROM items i LEFT JOIN catalog_migration_items m ON m.item_id=i.id "
            "LEFT JOIN product_variants v ON v.id=m.variant_id "
            "WHERE i.branch_id=? ORDER BY i.position,i.id", (branch_id,)):
        item = dict(row)
        item["price_cents"] = item["price_cents"] if item["price_cents"] is not None else int(round(item["price"] * 100))
        item["stock_qty"] = item["variant_stock"] if item["variant_stock"] is not None else item["stock_qty"]
        out.append(item)
    return {"items": out}

def h_items_legacy_write(args, body, conn):
    raise ApiError(405, "Legacy item writes are disabled; use /api/products")

def h_catalog_groups_list(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    groups = []
    for row in conn.execute(
            "SELECT * FROM modifier_groups WHERE branch_id=? ORDER BY id",
            (branch_id,)):
        group = dict(row)
        group["options"] = [dict(r) for r in conn.execute(
            "SELECT * FROM modifier_options WHERE modifier_group_id=? "
            "ORDER BY sort_order,id", (row["id"],))]
        groups.append(group)
    return {"modifier_groups": groups}

def h_catalog_group_create(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    name = str(body.get("name") or "").strip()[:120]
    selection_type = str(body.get("selection_type") or "multi")
    min_select = int(body.get("min_select", 0))
    max_select = int(body.get("max_select", 1))
    if not name:
        raise ApiError(400, "Modifier group name required")
    if selection_type not in ("single", "multi"):
        raise ApiError(400, "Invalid modifier selection type")
    if min_select < 0 or max_select < min_select:
        raise ApiError(400, "Invalid modifier group bounds")
    try:
        cur = conn.execute(
            "INSERT INTO modifier_groups"
            "(branch_id,name,selection_type,min_select,max_select)"
            " VALUES(?,?,?,?,?)",
            (branch_id, name, selection_type, min_select, max_select))
        bump_rev(conn)
        conn.commit()
    except sqlite3.IntegrityError:
        raise ApiError(409, "Modifier group name already exists")
    return {"ok": True, "modifier_group_id": cur.lastrowid}

def h_catalog_group_update(args, body, conn):
    branch_id = get_branch_id(body)
    group_id = int(args[0])
    row = conn.execute(
        "SELECT * FROM modifier_groups WHERE id=? AND branch_id=?",
        (group_id, branch_id)).fetchone()
    if not row:
        raise ApiError(404, "Modifier group not found")
    fields, values = [], []
    if "name" in body:
        name = str(body["name"] or "").strip()[:120]
        if not name:
            raise ApiError(400, "Modifier group name required")
        fields.append("name=?")
        values.append(name)
    if "selection_type" in body:
        if body["selection_type"] not in ("single", "multi"):
            raise ApiError(400, "Invalid modifier selection type")
        fields.append("selection_type=?")
        values.append(body["selection_type"])
    min_select = int(body.get("min_select", row["min_select"]))
    max_select = int(body.get("max_select", row["max_select"]))
    if "min_select" in body:
        fields.append("min_select=?")
        values.append(min_select)
    if "max_select" in body:
        fields.append("max_select=?")
        values.append(max_select)
    if min_select < 0 or max_select < min_select:
        raise ApiError(400, "Invalid modifier group bounds")
    if fields:
        values.append(group_id)
        try:
            conn.execute("UPDATE modifier_groups SET %s WHERE id=?"
                         % ",".join(fields), values)
        except sqlite3.IntegrityError:
            raise ApiError(409, "Modifier group name already exists")
    bump_rev(conn)
    conn.commit()
    return {"ok": True}

def h_catalog_group_delete(args, body, conn):
    branch_id = get_branch_id(body)
    group_id = int(args[0])
    row = conn.execute(
        "SELECT * FROM modifier_groups WHERE id=? AND branch_id=?",
        (group_id, branch_id)).fetchone()
    if not row:
        raise ApiError(404, "Modifier group not found")
    conn.execute("DELETE FROM modifier_groups WHERE id=?", (group_id,))
    bump_rev(conn)
    conn.commit()
    return {"ok": True}

def h_catalog_options_list(args, body, conn):
    branch_id = get_branch_id(body)
    group_id = int(args[0])
    if not conn.execute(
            "SELECT 1 FROM modifier_groups WHERE id=? AND branch_id=?",
            (group_id, branch_id)).fetchone():
        raise ApiError(404, "Modifier group not found")
    return {"options": [dict(r) for r in conn.execute(
        "SELECT * FROM modifier_options WHERE modifier_group_id=? "
        "ORDER BY sort_order,id", (group_id,))]}

def h_catalog_option_create(args, body, conn):
    branch_id = get_branch_id(body)
    group_id = int(args[0])
    if not conn.execute(
            "SELECT 1 FROM modifier_groups WHERE id=? AND branch_id=?",
            (group_id, branch_id)).fetchone():
        raise ApiError(404, "Modifier group not found")
    name = str(body.get("name") or "").strip()[:80]
    if not name:
        raise ApiError(400, "Modifier option name required")
    cents = int(body.get("price_delta_cents", 0))
    if cents != body.get("price_delta_cents", 0):
        raise ApiError(400, "Modifier delta must be an integer number of cents")
    try:
        cur = conn.execute(
            "INSERT INTO modifier_options"
            "(modifier_group_id,name,price_delta_cents,sort_order,active)"
            " VALUES(?,?,?,?,?)",
            (group_id, name, cents, int(body.get("sort_order", 0)),
             int(bool(body.get("active", 1)))))
        bump_rev(conn)
        conn.commit()
    except sqlite3.IntegrityError:
        raise ApiError(409, "Modifier option name already exists")
    return {"ok": True, "modifier_option_id": cur.lastrowid}

def h_catalog_option_update(args, body, conn):
    branch_id = get_branch_id(body)
    option_id = int(args[0])
    row = conn.execute(
        "SELECT o.*,g.branch_id FROM modifier_options o "
        "JOIN modifier_groups g ON g.id=o.modifier_group_id "
        "WHERE o.id=?", (option_id,)).fetchone()
    if not row or row["branch_id"] != branch_id:
        raise ApiError(404, "Modifier option not found")
    fields, values = [], []
    if "name" in body:
        name = str(body["name"] or "").strip()[:80]
        if not name:
            raise ApiError(400, "Modifier option name required")
        fields.append("name=?")
        values.append(name)
    if "price_delta_cents" in body:
        cents = int(body["price_delta_cents"])
        if cents != body["price_delta_cents"]:
            raise ApiError(400, "Modifier delta must be an integer number of cents")
        fields.append("price_delta_cents=?")
        values.append(cents)
    for key, column in (("sort_order", "sort_order"), ("active", "active")):
        if key in body:
            fields.append("%s=? " % column)
            values.append(int(bool(body[key])) if key == "active" else int(body[key]))
    if fields:
        values.append(option_id)
        try:
            conn.execute("UPDATE modifier_options SET %s WHERE id=?"
                         % ",".join(f.strip() for f in fields), values)
        except sqlite3.IntegrityError:
            raise ApiError(409, "Modifier option name already exists")
    bump_rev(conn)
    conn.commit()
    return {"ok": True}

def h_catalog_option_delete(args, body, conn):
    branch_id = get_branch_id(body)
    option_id = int(args[0])
    row = conn.execute(
        "SELECT o.*,g.branch_id FROM modifier_options o "
        "JOIN modifier_groups g ON g.id=o.modifier_group_id "
        "WHERE o.id=?", (option_id,)).fetchone()
    if not row or row["branch_id"] != branch_id:
        raise ApiError(404, "Modifier option not found")
    conn.execute("UPDATE modifier_options SET active=0 WHERE id=?", (option_id,))
    bump_rev(conn)
    conn.commit()
    return {"ok": True}

def h_catalog_product_groups(args, body, conn):
    branch_id = get_branch_id(body)
    product_id = int(args[0])
    require_product(conn, product_id, branch_id)
    attachments = body.get("modifier_groups")
    if not isinstance(attachments, list):
        raise ApiError(400, "Modifier groups must be a list")
    conn.execute("BEGIN")
    try:
        conn.execute("DELETE FROM product_modifier_groups WHERE product_id=?",
                     (product_id,))
        for attachment in attachments:
            if not isinstance(attachment, dict):
                raise ApiError(400, "Invalid modifier group attachment")
            group_id = int(attachment["modifier_group_id"])
            group = conn.execute(
                "SELECT * FROM modifier_groups WHERE id=? AND branch_id=?",
                (group_id, branch_id)).fetchone()
            if not group:
                raise ApiError(404, "Modifier group not found")
            override_min = attachment.get("override_min")
            override_max = attachment.get("override_max")
            min_select = group["min_select"] if override_min is None else int(override_min)
            max_select = group["max_select"] if override_max is None else int(override_max)
            if min_select < 0 or max_select < min_select:
                raise ApiError(400, "Invalid modifier group bounds")
            conn.execute(
                "INSERT INTO product_modifier_groups"
                "(product_id,modifier_group_id,sort_order,override_min,override_max)"
                " VALUES(?,?,?,?,?)",
                (product_id, group_id, int(attachment.get("sort_order", 0)),
                 override_min, override_max))
        bump_rev(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"ok": True}
def h_item_create(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    name = str(body.get("name") or "").strip()
    if not name:
        raise ApiError(400, "Name required")
    try:
        price = round(float(body.get("price")), 2)
        if not math.isfinite(price) or price < 0:
            raise ValueError()
    except Exception:
        raise ApiError(400, "Bad price")
    sid = body.get("section_id")
    if not conn.execute("SELECT 1 FROM sections WHERE id=? AND branch_id=?", (sid, branch_id)).fetchone():
        raise ApiError(400, "Bad section")
    pos = conn.execute("SELECT COALESCE(MAX(position),0)+1 p FROM items WHERE section_id=? AND branch_id=?",
                       (sid, branch_id)).fetchone()["p"]
    modifiers = parse_modifiers(body.get("modifiers", []))
    stock = body.get("stock_qty")
    if stock is not None:
        try:
            raw_stock = float(stock)
            if not math.isfinite(raw_stock) or not raw_stock.is_integer():
                raise ValueError()
            stock = int(raw_stock)
        except (TypeError, ValueError):
            raise ApiError(400, "Stock must be a non-negative whole number or null")
        if stock < 0:
            raise ApiError(400, "Stock cannot be negative")
    image_url = str(body.get("image_url") or "").strip()
    if image_url and not image_url.startswith("/item-images/"):
        raise ApiError(400, "Image must be uploaded to this server")
    cur = conn.execute("INSERT INTO items(section_id, name, price, description, position, active, branch_id, stock_qty, image_url, modifiers) "
                       "VALUES(?,?,?,?,?,1,?,?,?,?)",
                       (sid, name, price, str(body.get("description") or "")[:300], pos, branch_id,
                        stock, image_url[:500], json.dumps(modifiers, ensure_ascii=False)))
    sync_catalog_from_item(conn, cur.lastrowid)
    bump_rev(conn); conn.commit()
    return {"ok": True, "item_id": cur.lastrowid}

def h_item_update(args, body, conn):
    branch_id = get_branch_id(body)
    iid = int(args[0])
    it = conn.execute("SELECT * FROM items WHERE id=? AND branch_id=?", (iid, branch_id)).fetchone()
    if not it:
        raise ApiError(404, "Item not found")
    if "name" in body:
        name = str(body["name"]).strip()
        if not name:
            raise ApiError(400, "Name required")
        conn.execute("UPDATE items SET name=? WHERE id=? AND branch_id=?", (name, iid, branch_id))
    if "price" in body:
        try:
            price = round(float(body["price"]), 2)
            if not math.isfinite(price) or price < 0:
                raise ValueError()
            conn.execute("UPDATE items SET price=? WHERE id=? AND branch_id=?", (price, iid, branch_id))
        except Exception:
            raise ApiError(400, "Bad price")
    if "description" in body:
        conn.execute("UPDATE items SET description=? WHERE id=? AND branch_id=?",
                     (str(body["description"])[:300], iid, branch_id))
    if "stock_qty" in body:
        stock = body["stock_qty"]
        if stock is not None:
            try:
                raw_stock = float(stock)
                if not math.isfinite(raw_stock) or not raw_stock.is_integer():
                    raise ValueError()
                stock = int(raw_stock)
            except (TypeError, ValueError):
                raise ApiError(400, "Stock must be a non-negative whole number or null")
            if stock < 0:
                raise ApiError(400, "Stock cannot be negative")
        conn.execute("UPDATE items SET stock_qty=? WHERE id=? AND branch_id=?",
                     (stock, iid, branch_id))
    if "image_url" in body:
        image_url = str(body["image_url"] or "").strip()
        if image_url and not image_url.startswith("/item-images/"):
            raise ApiError(400, "Image must be uploaded to this server")
        conn.execute("UPDATE items SET image_url=? WHERE id=? AND branch_id=?",
                     (image_url[:500], iid, branch_id))
    if "modifiers" in body:
        modifiers = parse_modifiers(body["modifiers"])
        conn.execute("UPDATE items SET modifiers=? WHERE id=? AND branch_id=?",
                     (json.dumps(modifiers, ensure_ascii=False), iid, branch_id))
    if "section_id" in body:
        sid = body["section_id"]
        if not conn.execute("SELECT 1 FROM sections WHERE id=? AND branch_id=?",
                            (sid, branch_id)).fetchone():
            raise ApiError(400, "Bad section")
        conn.execute("UPDATE items SET section_id=? WHERE id=? AND branch_id=?", (sid, iid, branch_id))
    for k in ("position", "active"):
        if k in body:
            conn.execute("UPDATE items SET %s=? WHERE id=? AND branch_id=?" % k,
                         (int(body[k]), iid, branch_id))
    sync_catalog_from_item(conn, iid)
    bump_rev(conn); conn.commit()
    return {"ok": True}

def h_item_delete(args, body, conn):
    branch_id = get_branch_id(body)
    iid = int(args[0])
    mapping = conn.execute(
        "SELECT product_id FROM catalog_migration_items WHERE item_id=?",
        (iid,)).fetchone()
    conn.execute("DELETE FROM items WHERE id=? AND branch_id=?", (iid, branch_id))
    if mapping:
        conn.execute("DELETE FROM catalog_migration_items WHERE item_id=?", (iid,))
        conn.execute("DELETE FROM products WHERE id=?", (mapping["product_id"],))
    bump_rev(conn); conn.commit()
    return {"ok": True}

def h_staff_create(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    name = str(body.get("name") or "").strip()
    if not name:
        raise ApiError(400, "Name required")
    tables = json.dumps(parse_tables(body.get("tables")))
    role = str(body.get("role") or "waiter").strip()
    if role not in ("waiter", "kitchen"):
        role = "waiter"
    kitchen_station = str(body.get("kitchen_station") or "").strip()[:100]
    pin_raw = str(body.get("pin") or "").strip()
    pin_hash = hashlib.sha256(pin_raw.encode()).hexdigest() if pin_raw else ""
    cur = conn.execute(
        "INSERT INTO staff(name, tables, active, branch_id, pin, role, kitchen_station) VALUES(?,?,?,?,?,?,?)",
        (name, tables, int(bool(body.get("active", 1))), branch_id, pin_hash, role, kitchen_station))
    bump_rev(conn); conn.commit()
    return {"ok": True, "staff_id": cur.lastrowid}

def h_staff_update(args, body, conn):
    branch_id = get_branch_id(body)
    sid = int(args[0])
    st = conn.execute("SELECT * FROM staff WHERE id=? AND branch_id=?", (sid, branch_id)).fetchone()
    if not st:
        raise ApiError(404, "Waiter not found")
    if "name" in body:
        name = str(body["name"]).strip()
        if not name:
            raise ApiError(400, "Name required")
        conn.execute("UPDATE staff SET name=? WHERE id=? AND branch_id=?", (name, sid, branch_id))
    if "tables" in body:
        conn.execute("UPDATE staff SET tables=? WHERE id=? AND branch_id=?",
                     (json.dumps(parse_tables(body["tables"])), sid, branch_id))
    if "active" in body:
        conn.execute("UPDATE staff SET active=? WHERE id=? AND branch_id=?",
                     (int(body["active"]), sid, branch_id))
    if "role" in body:
        role = str(body["role"] or "waiter").strip()
        if role not in ("waiter", "kitchen"):
            role = "waiter"
        conn.execute("UPDATE staff SET role=? WHERE id=? AND branch_id=?", (role, sid, branch_id))
    if "kitchen_station" in body:
        conn.execute("UPDATE staff SET kitchen_station=? WHERE id=? AND branch_id=?",
                     (str(body["kitchen_station"] or "").strip()[:100], sid, branch_id))
    if "pin" in body:
        pin_raw = str(body["pin"] or "").strip()
        pin_hash = hashlib.sha256(pin_raw.encode()).hexdigest() if pin_raw else ""
        conn.execute("UPDATE staff SET pin=? WHERE id=? AND branch_id=?", (pin_hash, sid, branch_id))
    bump_rev(conn); conn.commit()
    return {"ok": True, "staff_id": sid}

def h_staff_delete(args, body, conn):
    branch_id = get_branch_id(body)
    conn.execute("DELETE FROM staff WHERE id=? AND branch_id=?", (int(args[0]), branch_id))
    bump_rev(conn); conn.commit()
    return {"ok": True}

def h_branch_create(args, body, conn):
    source_id = get_branch_id(body)
    require_branch(conn, source_id)
    name = str(body.get("name") or "").strip()[:100]
    if not name:
        raise ApiError(400, "Branch name required")
    try:
        cur = conn.execute("INSERT INTO branches(name) VALUES(?)", (name,))
    except sqlite3.IntegrityError:
        raise ApiError(409, "Branch name already exists")
    new_id = cur.lastrowid
    if body.get("copy_menu"):
        section_map = {}
        for section in conn.execute(
                "SELECT * FROM sections WHERE branch_id=? ORDER BY position, id", (source_id,)):
            new_section = conn.execute(
                "INSERT INTO sections(name,position,active,branch_id,kitchen_station) VALUES(?,?,?,?,?)",
                (section["name"], section["position"], section["active"], new_id,
                 section["kitchen_station"] if "kitchen_station" in section.keys() else ""))
            section_map[section["id"]] = new_section.lastrowid
        for item in conn.execute("SELECT * FROM items WHERE branch_id=?", (source_id,)):
            copied = conn.execute(
                "INSERT INTO items(section_id,name,price,description,position,active,branch_id,"
                "stock_qty,image_url,modifiers) VALUES(?,?,?,?,?,?,?,NULL,?,?)",
                (section_map[item["section_id"]], item["name"], item["price"], item["description"],
                 item["position"], item["active"], new_id, item["image_url"], item["modifiers"]))
            sync_catalog_from_item(conn, copied.lastrowid)
        for staff in conn.execute("SELECT * FROM staff WHERE branch_id=?", (source_id,)):
            conn.execute(
                "INSERT INTO staff(name,tables,active,branch_id,role,kitchen_station) VALUES(?,?,?,?,?,?)",
                (staff["name"], staff["tables"], staff["active"], new_id,
                 staff["role"] if "role" in staff.keys() else "waiter",
                 staff["kitchen_station"] if "kitchen_station" in staff.keys() else ""))
    bump_rev(conn)
    conn.commit()
    return {"ok": True, "branch_id": new_id}

def h_reservation_create(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    name = str(body.get("guest_name") or "").strip()[:120]
    contact = str(body.get("contact") or "").strip()[:120]
    note = str(body.get("note") or "").strip()[:300]
    try:
        starts_at = float(body.get("starts_at"))
        raw_party_size = float(body.get("party_size"))
        if not math.isfinite(raw_party_size) or not raw_party_size.is_integer():
            raise ValueError()
        party_size = int(raw_party_size)
        if body.get("table_no") not in (None, ""):
            raw_table = float(body["table_no"])
            if not math.isfinite(raw_table) or not raw_table.is_integer():
                raise ValueError()
            table_no = int(raw_table)
        else:
            table_no = None
    except (TypeError, ValueError):
        raise ApiError(400, "Invalid reservation date, party size, or table")
    if not name or not math.isfinite(starts_at) or starts_at <= time.time() or not 1 <= party_size <= 50:
        raise ApiError(400, "Reservation needs a guest name, future date, and party size from 1 to 50")
    if table_no is not None and table_no <= 0:
        raise ApiError(400, "Table must be a positive number")
    conflict = None
    if table_no is not None:
        window = 7200
        row = conn.execute(
            "SELECT guest_name,starts_at FROM reservations "
            "WHERE branch_id=? AND table_no=? AND status!='cancelled' "
            "AND ABS(starts_at-?)<=? LIMIT 1",
            (branch_id, table_no, starts_at, window)).fetchone()
        if row:
            conflict = "Table %d is already booked at %s" % (
                table_no, datetime.datetime.fromtimestamp(row["starts_at"]).strftime("%H:%M"))
    cur = conn.execute(
        "INSERT INTO reservations(branch_id,guest_name,contact,starts_at,party_size,table_no,status,note,created_at) "
        "VALUES(?,?,?,?,?,?,'booked',?,?)",
        (branch_id, name, contact, starts_at, party_size, table_no, note, time.time()))
    bump_rev(conn); conn.commit()
    return {"ok": True, "reservation_id": cur.lastrowid, "warning": conflict}

def h_reservation_update(args, body, conn):
    branch_id = get_branch_id(body)
    reservation_id = int(args[0])
    reservation = conn.execute("SELECT * FROM reservations WHERE id=? AND branch_id=?",
                               (reservation_id, branch_id)).fetchone()
    if not reservation:
        raise ApiError(404, "Reservation not found")
    status = body.get("status", reservation["status"])
    if status not in ("booked", "seated", "cancelled", "no_show"):
        raise ApiError(400, "Invalid reservation status")
    if "guest_name" in body:
        name = str(body["guest_name"] or "").strip()[:120]
        if not name:
            raise ApiError(400, "Guest name required")
        conn.execute("UPDATE reservations SET guest_name=? WHERE id=?", (name, reservation_id))
    if "contact" in body:
        conn.execute("UPDATE reservations SET contact=? WHERE id=?",
                     (str(body["contact"] or "").strip()[:120], reservation_id))
    if "note" in body:
        conn.execute("UPDATE reservations SET note=? WHERE id=?",
                     (str(body["note"] or "").strip()[:300], reservation_id))
    if "table_no" in body:
        table_no = body["table_no"]
        if table_no not in (None, ""):
            try:
                raw_table = float(table_no)
                if not math.isfinite(raw_table) or not raw_table.is_integer():
                    raise ValueError()
                table_no = int(raw_table)
            except (TypeError, ValueError):
                raise ApiError(400, "Invalid table")
        else:
            table_no = None
        conn.execute("UPDATE reservations SET table_no=? WHERE id=?", (table_no, reservation_id))
    conn.execute("UPDATE reservations SET status=? WHERE id=?", (status, reservation_id))
    bump_rev(conn); conn.commit()
    return {"ok": True}

def h_payment_create(args, body, conn):
    branch_id = get_branch_id(body)
    order_id = int(args[0])
    order = get_order(conn, order_id)
    if order["branch_id"] != branch_id or order["status"] == "cancelled":
        raise ApiError(404, "Order not found")
    try:
        amount = round(float(body.get("amount")), 2)
    except (TypeError, ValueError):
        raise ApiError(400, "Invalid payment amount")
    method = str(body.get("method") or "").lower()
    if not math.isfinite(amount) or amount <= 0 or method not in ("cash", "card", "other"):
        raise ApiError(400, "Payment must be positive and use cash, card, or other")
    paid = sum(row["amount"] for row in conn.execute(
        "SELECT amount-refunded_amount amount FROM payments WHERE order_id=?", (order_id,)))
    if amount > round(order["total"] - paid, 2) + 0.001:
        raise ApiError(409, "Payment exceeds the remaining balance")
    allocations = body.get("allocations") or []
    if not isinstance(allocations, list):
        raise ApiError(400, "Invalid bill split")
    if allocations:
        allocated_qty = 0
        for allocation in allocations:
            try:
                qty = float(allocation["qty"])
            except (KeyError, TypeError, ValueError):
                raise ApiError(400, "Invalid bill split allocation")
            if not math.isfinite(qty) or not qty.is_integer() or qty <= 0:
                raise ApiError(400, "Split quantities must be whole numbers")
            allocated_qty += int(qty)
    cur = conn.execute(
        "INSERT INTO payments(order_id,amount,method,note,created_at) VALUES(?,?,?,?,?)",
        (order_id, amount, method, str(body.get("note") or "")[:200], time.time()))
    payment_id = cur.lastrowid
    if allocations:
        allocated_total = 0.0
        for allocation in allocations:
            try:
                line_id = int(allocation["line_id"])
                qty = float(allocation["qty"])
            except (KeyError, TypeError, ValueError):
                raise ApiError(400, "Invalid bill split allocation")
            if not math.isfinite(qty) or not qty.is_integer():
                raise ApiError(400, "Split quantities must be whole numbers")
            line = conn.execute(
                "SELECT * FROM order_items WHERE id=? AND order_id=? AND status!='cancelled'",
                (line_id, order_id)).fetchone()
            if not line or qty <= 0 or qty > line["qty"]:
                raise ApiError(400, "Invalid bill split quantity")
            already = conn.execute(
                "SELECT COALESCE(SUM(pa.qty * (p.amount-p.refunded_amount)/p.amount),0) q FROM payment_allocations pa "
                "JOIN payments p ON p.id=pa.payment_id WHERE pa.order_item_id=? AND p.order_id=?",
                (line_id, order_id)).fetchone()["q"]
            if already + qty > line["qty"]:
                raise ApiError(409, "Item quantity already assigned to another split")
            conn.execute("INSERT INTO payment_allocations(payment_id,order_item_id,qty) VALUES(?,?,?)",
                         (payment_id, line_id, qty))
            allocated_total += line["price"] * qty
        if abs(round(allocated_total, 2) - amount) > 0.01:
            raise ApiError(400, "Payment amount must match the selected items")
    bump_rev(conn); conn.commit()
    return {"ok": True, "payment_id": payment_id, "balance": round(order["total"] - paid - amount, 2)}

def h_bill_request(args, body, conn):
    branch_id = get_branch_id(body)
    order_id = int(args[0])
    order = conn.execute("SELECT branch_id,status FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order or order["branch_id"] != branch_id:
        raise ApiError(404, "Order not found")
    if order["status"] in ("served", "cancelled"):
        raise ApiError(400, "Closed orders cannot request a bill")
    conn.execute("UPDATE orders SET bill_requested=1, updated_at=? WHERE id=?",
                 (time.time(), order_id))
    bump_rev(conn); conn.commit()
    return {"ok": True}

def h_payment_refund(args, body, conn):
    branch_id = get_branch_id(body)
    payment_id = int(args[0])
    payment = conn.execute(
        "SELECT p.*,o.branch_id FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=?",
        (payment_id,)).fetchone()
    if not payment or payment["branch_id"] != branch_id:
        raise ApiError(404, "Payment not found")
    try:
        amount = round(float(body.get("amount")), 2)
    except (TypeError, ValueError):
        raise ApiError(400, "Invalid refund amount")
    remaining = round(payment["amount"] - payment["refunded_amount"], 2)
    if not math.isfinite(amount) or amount <= 0 or amount > remaining + 0.001:
        raise ApiError(400, "Refund must be positive and no greater than the unrefunded payment")
    conn.execute("UPDATE payments SET refunded_amount=refunded_amount+? WHERE id=?",
                 (amount, payment_id))
    bump_rev(conn); conn.commit()
    return {"ok": True, "refunded": amount, "remaining": round(remaining - amount, 2)}

def h_sales(args, body, conn):
    branch_id = get_branch_id(body)
    require_branch(conn, branch_id)
    period = body.get("period", "7d")
    days = {"7d": 7, "30d": 30, "90d": 90}.get(period)
    if not days:
        raise ApiError(400, "Period must be 7d, 30d, or 90d")
    start = time.time() - days * 86400
    daily = [dict(row) for row in conn.execute(
        "SELECT date(p.created_at,'unixepoch','localtime') day, "
        "ROUND(SUM(p.amount-p.refunded_amount),2) revenue, COUNT(*) payments "
        "FROM payments p JOIN orders o ON o.id=p.order_id "
        "WHERE o.branch_id=? AND p.created_at>=? GROUP BY day HAVING revenue>0 ORDER BY day",
        (branch_id, start))]
    top_items = [dict(row) for row in conn.execute(
        "SELECT oi.name, SUM(oi.qty) quantity, ROUND(SUM(oi.price*oi.qty),2) value "
        "FROM order_items oi JOIN orders o ON o.id=oi.order_id "
        "WHERE o.branch_id=? AND o.created_at>=? AND oi.status!='cancelled' "
        "GROUP BY oi.name ORDER BY quantity DESC LIMIT 10", (branch_id, start))]
    return {"ok": True, "period": period, "daily": daily, "top_items": top_items}

def h_item_image(args, body, conn):
    branch_id = get_branch_id(body)
    item_id = int(args[0])
    if not conn.execute("SELECT 1 FROM items WHERE id=? AND branch_id=?",
                        (item_id, branch_id)).fetchone():
        raise ApiError(404, "Item not found")
    mime_types = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
    extension = mime_types.get(body.get("mime"))
    if not extension:
        raise ApiError(400, "Upload PNG, JPEG, or WebP images")
    try:
        image = base64.b64decode(body.get("data") or "", validate=True)
    except (ValueError, TypeError):
        raise ApiError(400, "Invalid image data")
    if not image or len(image) > 2_000_000:
        raise ApiError(413, "Image must be between 1 byte and 2 MB")
    valid_signature = (
        (extension == "png" and image.startswith(b"\x89PNG\r\n\x1a\n")) or
        (extension == "jpg" and image.startswith(b"\xff\xd8\xff")) or
        (extension == "webp" and len(image) >= 12 and image[:4] == b"RIFF" and image[8:12] == b"WEBP")
    )
    if not valid_signature:
        raise ApiError(400, "Image content does not match its format")
    os.makedirs(IMAGES_DIR, exist_ok=True)
    filename = "%s.%s" % (uuid.uuid4().hex, extension)
    path = os.path.join(IMAGES_DIR, filename)
    with open(path, "wb") as image_file:
        image_file.write(image)
    image_url = "/item-images/" + filename
    conn.execute("UPDATE items SET image_url=? WHERE id=? AND branch_id=?",
                 (image_url, item_id, branch_id))
    bump_rev(conn); conn.commit()
    return {"ok": True, "image_url": image_url}

def h_product_image(args, body, conn):
    branch_id = get_branch_id(body)
    product_id = int(args[0])
    require_product(conn, product_id, branch_id)
    mime_types = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
    extension = mime_types.get(body.get("mime"))
    if not extension:
        raise ApiError(400, "Upload PNG, JPEG, or WebP images")
    try:
        image = base64.b64decode(body.get("data") or "", validate=True)
    except (ValueError, TypeError):
        raise ApiError(400, "Invalid image data")
    if not image or len(image) > 2_000_000:
        raise ApiError(413, "Image must be between 1 byte and 2 MB")
    valid_signature = (
        (extension == "png" and image.startswith(b"\x89PNG\r\n\x1a\n")) or
        (extension == "jpg" and image.startswith(b"\xff\xd8\xff")) or
        (extension == "webp" and len(image) >= 12 and image[:4] == b"RIFF" and image[8:12] == b"WEBP")
    )
    if not valid_signature:
        raise ApiError(400, "Image content does not match its format")
    os.makedirs(IMAGES_DIR, exist_ok=True)
    filename = "%s.%s" % (uuid.uuid4().hex, extension)
    path = os.path.join(IMAGES_DIR, filename)
    with open(path, "wb") as image_file:
        image_file.write(image)
    image_url = "/item-images/" + filename
    conn.execute("UPDATE products SET image_path=? WHERE id=?",
                 (image_url, product_id))
    bump_rev(conn)
    conn.commit()
    return {"ok": True, "image_url": image_url}

def h_settings(args, body, conn):
    global CONFIG
    allowed = ("restaurant_name", "currency", "printer_ip", "printer_port", "autoprint", "admin_pin", "port",
               "disk_warning_mb", "log_retention_days", "ticket_amber_minutes", "ticket_red_minutes")
    for k in allowed:
        if k in body:
            v = body[k]
            if k in ("printer_port", "port") and v not in ("", None):
                v = int(v)
            if k == "autoprint":
                v = bool(v)
            if isinstance(v, str):
                v = v[:200]
            CONFIG[k] = v
    save_config(CONFIG)
    return {"ok": True}

def h_print(args, body, conn):
    order = get_order(conn, int(args[0]), with_lines=False)
    if order["branch_id"] != get_branch_id(body):
        raise ApiError(404, "Order not found")
    return print_ticket(int(args[0]))

def h_export(args, body, conn):
    data = h_state(args, body, conn)
    branch_id = data["branch_id"]
    data["orders"] = []
    for row in conn.execute(
            "SELECT * FROM orders WHERE branch_id=? ORDER BY created_at DESC", (branch_id,)):
        order = dict(row)
        order["lines"] = [dict(line) for line in conn.execute(
            "SELECT * FROM order_items WHERE order_id=? ORDER BY id", (order["id"],))]
        order["total"] = order_total(order["lines"])
        order["paid"] = round(sum(payment["amount"] for payment in conn.execute(
            "SELECT amount-refunded_amount amount FROM payments WHERE order_id=?", (order["id"],))), 2)
        order["balance"] = round(order["total"] - order["paid"], 2)
        data["orders"].append(order)
    data["payments"] = [dict(row) for row in conn.execute(
        "SELECT p.* FROM payments p JOIN orders o ON o.id=p.order_id "
        "WHERE o.branch_id=? ORDER BY p.created_at", (branch_id,))]
    data["reservations"] = [dict(row) for row in conn.execute(
        "SELECT * FROM reservations WHERE branch_id=? ORDER BY starts_at", (branch_id,))]
    data.pop("now", None)
    return {"ok": True, "exported_at": time.time(), "data": data}

ROUTES = [
    ("GET",    r"^/api/state$",                     h_state,          False),
    ("GET",    r"^/api/sections$",                  h_catalog_sections, False),
    ("GET",    r"^/api/products$",                  h_catalog_products_list, False),
    ("GET",    r"^/api/items$",                     h_items_list,      False),
    ("GET",    r"^/api/products/(\d+)/variants$",   h_catalog_variants_list, False),
    ("GET",    r"^/api/modifier-groups$",           h_catalog_groups_list, False),
    ("GET",    r"^/api/modifier-groups/(\d+)/options$", h_catalog_options_list, False),
    ("POST",   r"^/api/orders$",                    h_order_create,   False),
    ("POST",   r"^/api/orders/(\d+)/status$",       h_order_status,   False),
    ("POST",   r"^/api/orders/(\d+)/lines/(\d+)/status$", h_line_status, False),
    ("GET",    r"^/api/ticket/(\d+)\.html$",        h_ticket,         False),
    ("POST",   r"^/api/print/(\d+)$",               h_print,          False),
    ("GET",    r"^/api/export$",                    h_export,         True),
    ("POST",   r"^/api/sections$",                  h_section_create, True),
    ("PUT",    r"^/api/sections/(\d+)$",            h_section_update, True),
    ("PATCH",  r"^/api/sections/(\d+)$",            h_section_update, True),
    ("DELETE", r"^/api/sections/(\d+)$",            h_section_delete, True),
    ("POST",   r"^/api/products$",                  h_catalog_product_create, True),
    ("PATCH",  r"^/api/products/(\d+)$",            h_catalog_product_update, True),
    ("PUT",    r"^/api/products/(\d+)$",            h_catalog_product_update, True),
    ("DELETE", r"^/api/products/(\d+)$",            h_catalog_product_delete, True),
    ("POST",   r"^/api/products/(\d+)/variants$",   h_catalog_variant_create, True),
    ("PUT",    r"^/api/products/(\d+)/variants$",   h_catalog_variants_replace, True),
    ("PATCH",  r"^/api/variants/(\d+)$",            h_catalog_variant_update, True),
    ("PUT",    r"^/api/variants/(\d+)$",            h_catalog_variant_update, True),
    ("DELETE", r"^/api/variants/(\d+)$",            h_catalog_variant_delete, True),
    ("POST",   r"^/api/modifier-groups$",           h_catalog_group_create, True),
    ("PATCH",  r"^/api/modifier-groups/(\d+)$",     h_catalog_group_update, True),
    ("PUT",    r"^/api/modifier-groups/(\d+)$",     h_catalog_group_update, True),
    ("DELETE", r"^/api/modifier-groups/(\d+)$",     h_catalog_group_delete, True),
    ("POST",   r"^/api/modifier-groups/(\d+)/options$", h_catalog_option_create, True),
    ("PATCH",  r"^/api/modifier-options/(\d+)$",    h_catalog_option_update, True),
    ("PUT",    r"^/api/modifier-options/(\d+)$",    h_catalog_option_update, True),
    ("DELETE", r"^/api/modifier-options/(\d+)$",   h_catalog_option_delete, True),
    ("PUT",    r"^/api/products/(\d+)/modifier-groups$", h_catalog_product_groups, True),
    ("POST",   r"^/api/items$",                     h_items_legacy_write, True),
    ("PATCH",  r"^/api/items/(\d+)$",               h_items_legacy_write, True),
    ("PUT",    r"^/api/items/(\d+)$",               h_items_legacy_write, True),
    ("DELETE", r"^/api/items/(\d+)$",               h_items_legacy_write, True),
    ("POST",   r"^/api/staff$",                     h_staff_create,   True),
    ("PUT",    r"^/api/staff/(\d+)$",               h_staff_update,   True),
    ("DELETE", r"^/api/staff/(\d+)$",               h_staff_delete,   True),
    ("POST",   r"^/api/staff/auth$",                h_staff_auth,     False),
    ("PUT",    r"^/api/settings$",                  h_settings,       True),
    ("POST",   r"^/api/branches$",                  h_branch_create,  True),
    ("POST",   r"^/api/reservations$",              h_reservation_create, True),
    ("PUT",    r"^/api/reservations/(\d+)$",        h_reservation_update, True),
    ("POST",   r"^/api/orders/(\d+)/payments$",     h_payment_create, True),
    ("POST",   r"^/api/payments/(\d+)/refund$",     h_payment_refund, True),
    ("PUT",    r"^/api/orders/(\d+)/bill$",         h_bill_request,   False),
    ("GET",    r"^/api/sales$",                     h_sales,          True),
    ("PUT",    r"^/api/items/(\d+)/image$",         h_item_image,     True),
    ("PUT",    r"^/api/products/(\d+)/image$",      h_product_image,  True),
]

# ---------------------------------------------------------------- HTTP server

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _audit_request(self, method, handler):
        started = time.time()
        self._audit_status = 500
        try:
            return handler()
        finally:
            now = datetime.datetime.now().astimezone()
            path = urlparse(self.path).path
            needs_admin = any(m == method and re.match(pattern, path) and admin
                              for m, pattern, _fn, admin in ROUTES)
            try:
                admin = str(self.headers.get("X-Admin-Pin", "")) == str(CONFIG.get("admin_pin", ""))
            except Exception:
                admin = False
            record = {
                "event_id": str(uuid.uuid4()),
                "date": now.strftime("%d/%m/%Y"),
                "timestamp": now.strftime("%d/%m/%Y %H:%M:%S.%f")[:-3],
                "timezone": now.strftime("%Z") or "local",
                "operation": method,
                "path": path,
                "status": self._audit_status,
                "result": "success" if 200 <= self._audit_status < 400 else "failure",
                "submitted_fields": getattr(self, "_audit_fields", []),
                "change_summary": getattr(self, "_audit_summary", {}),
                "resource_ids": getattr(self, "_audit_resource_ids", {}),
                "actor": "admin" if admin else ("admin_required" if needs_admin else "client"),
                "claimed_role": str(self.headers.get("X-Actor-Role", "") or "")[:24],
                "claimed_actor_id": str(self.headers.get("X-Actor-ID", "") or "")[:64],
                "branch_id": self.headers.get("X-Branch-ID"),
                "client_ip": self.client_address[0],
                "duration_ms": round((time.time() - started) * 1000, 1),
            }
            try:
                os.makedirs(AUDIT_DIR, exist_ok=True)
                log_path = os.path.join(AUDIT_DIR, now.strftime("%d-%m-%Y") + ".jsonl")
                with _audit_lock, open(log_path, "a", encoding="utf-8") as log:
                    log.write(json.dumps(record, ensure_ascii=False) + "\n")
            except OSError as exc:
                # Keep the service available, but make audit-write failures visible.
                print("AUDIT LOG WRITE FAILED: %s" % exc, flush=True)
    server_version = "RestaurantServer/1.0"

    def log_message(self, fmt, *args):
        pass  # keep the console quiet

    def _headers(self, code=200, ctype="application/json", extra=None):
        self._audit_status = code
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Pin, X-Branch-ID, X-Actor-Role, X-Actor-ID")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()

    def _json(self, obj, code=200):
        id_keys = {"id", "item_id", "order_id", "section_id", "staff_id",
                   "reservation_id", "payment_id", "branch_id"}
        if isinstance(obj, dict):
            self._audit_resource_ids = {k: obj[k] for k in id_keys
                                        if k in obj and isinstance(obj[k], (int, str))}
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._headers(code, extra={"Content-Length": str(len(body))})
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._audit_request("OPTIONS", lambda: self._headers(200))

    def _body(self, max_size=1_000_000):
        n = int(self.headers.get("Content-Length") or 0)
        if n > max_size:
            raise ApiError(413, "Body too large")
        if n == 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise ApiError(400, "Invalid JSON body")

    def h_events(self):
        """SSE long-poll handler — writes raw HTTP, never uses _headers/_json."""
        raw = (
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: text/event-stream\r\n"
            "Cache-Control: no-cache\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Connection: keep-alive\r\n"
            "X-Accel-Buffering: no\r\n"
            "\r\n"
        )
        try:
            self.wfile.write(raw.encode("utf-8"))
            self.wfile.flush()
            self._audit_status = 200
        except (OSError, BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return

        conn = db()
        try:
            rev = get_rev(conn)
        finally:
            conn.close()

        # Send initial rev immediately
        try:
            msg = "data: {\"rev\": %d}\n\n" % rev
            self.wfile.write(msg.encode("utf-8"))
            self.wfile.flush()
        except (OSError, BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return

        while True:
            time.sleep(0.8)
            try:
                conn = db()
                try:
                    new_rev = get_rev(conn)
                finally:
                    conn.close()
                if new_rev != rev:
                    rev = new_rev
                    msg = "data: {\"rev\": %d}\n\n" % rev
                    self.wfile.write(msg.encode("utf-8"))
                    self.wfile.flush()
            except (OSError, BrokenPipeError, ConnectionResetError):
                break
            except Exception:
                break

        self.close_connection = True

    def do_GET(self):
        self._audit_request("GET", self._handle_get)

    def _handle_get(self):
        parsed = urlparse(self.path)
        p = parsed.path
        # SSE endpoint — handle before normal routing
        if p == "/api/events":
            self.h_events()
            return
        if p == "/health":
            conn = db()
            try:
                conn.execute("PRAGMA user_version").fetchone()
                db_writable = True
                conn.execute("BEGIN IMMEDIATE")
                conn.rollback()
                open_tickets = conn.execute(
                    "SELECT COUNT(*) c FROM orders WHERE status IN ('sent','preparing','ready')"
                ).fetchone()["c"]
            except sqlite3.Error:
                db_writable = False
                open_tickets = 0
            finally:
                conn.close()
            self._json({
                "status": "ok",
                "schema_version": SCHEMA_VERSION,
                "open_tickets": open_tickets,
                "db_writable": db_writable,
            })
            return
        image_match = re.fullmatch(r"/item-images/([a-fA-F0-9]{32})\.(png|jpg|webp)", p)
        if image_match:
            path = os.path.join(IMAGES_DIR, image_match.group(0).split("/")[-1])
            if not os.path.isfile(path):
                self._json({"ok": False, "error": "Image not found"}, 404)
                return
            mime = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[image_match.group(2)]
            with open(path, "rb") as image_file:
                data = image_file.read()
            self._headers(200, mime, extra={"Content-Length": str(len(data))})
            self.wfile.write(data)
            return
        if p in ("/", "/app.html", "/index.html"):
            try:
                with open(APP_PATH, "rb") as f:
                    app = f.read()
            except Exception:
                self._json({"ok": False, "error": "app.html not found — run build_app.py"}, 500)
                return
            self._headers(200, "text/html", extra={"Content-Length": str(len(app))})
            self.wfile.write(app)
            return
        self._route("GET", p, parse_qs(parsed.query))

    def do_POST(self):
        self._audit_request("POST", lambda: self._route("POST", urlparse(self.path).path))

    def do_PUT(self):
        self._audit_request("PUT", lambda: self._route("PUT", urlparse(self.path).path))

    def do_PATCH(self):
        self._audit_request("PATCH", lambda: self._route("PATCH", urlparse(self.path).path))

    def do_DELETE(self):
        self._audit_request("DELETE", lambda: self._route("DELETE", urlparse(self.path).path))

    def _route(self, method, path, query=None):
        for m, pattern, fn, needs_admin in ROUTES:
            if m != method:
                continue
            match = re.match(pattern, path)
            if not match:
                continue
            try:
                body = (self._body(3_000_000 if re.match(r"^/api/items/\d+/image$", path) else 1_000_000)
                        if method in ("POST", "PUT", "PATCH", "DELETE")
                        else {"lang": (query or {}).get("lang", ["en"])[0],
                              "period": (query or {}).get("period", ["7d"])[0],
                              "section_id": (query or {}).get("section_id", [None])[0],
                              "q": (query or {}).get("q", [""])[0]})
                body["branch_id"] = self.headers.get("X-Branch-ID") or (
                    (query or {}).get("branch_id", [body.get("branch_id", 1)])[0])
                # Audit field names and low-risk allowlisted values only.
                self._audit_fields = sorted(k for k in body if k != "branch_id")
                safe_values = {"price", "qty", "status", "table_no", "party_size",
                               "active", "position", "stock_qty", "section_id",
                               "copy_menu", "lang", "period"}
                self._audit_summary = {k: body[k] for k in self._audit_fields
                                       if k in safe_values and isinstance(body[k], (str, int, float, bool, type(None)))}
                if needs_admin:
                    check_admin(self.headers)
                conn = db()
                try:
                    result = fn(match.groups(), body, conn)
                finally:
                    conn.close()
                if isinstance(result, str):          # ticket HTML view
                    b = result.encode("utf-8")
                    self._headers(200, "text/html", extra={"Content-Length": str(len(b))})
                    self.wfile.write(b)
                else:
                    self._json(result)
            except ApiError as e:
                self._json({"ok": False, "error": e.msg}, e.code)
            except Exception as e:
                self._json({"ok": False, "error": "Server error: %s" % e}, 500)
            return
        self._json({"ok": False, "error": "Not found"}, 404)

def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def directory_size_mb(path):
    total = 0
    if not os.path.isdir(path):
        return 0
    for root, dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total / (1024 * 1024)

def cleanup_old_logs(days):
    cutoff = time.time() - max(0, int(days)) * 86400
    removed = 0
    if os.path.isdir(AUDIT_DIR):
        for name in os.listdir(AUDIT_DIR):
            path = os.path.join(AUDIT_DIR, name)
            if os.path.isfile(path):
                try:
                    if os.path.getmtime(path) < cutoff:
                        os.unlink(path)
                        removed += 1
                except OSError:
                    pass
    print("Cleaned %d log file(s) older than %d days." % (removed, days))

def create_backup(destination):
    target = os.path.abspath(destination)
    if os.path.isdir(target):
        target = os.path.join(target, "restaurant-backup-%s.zip" %
                              datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    temp_db = os.path.join(os.path.dirname(target), ".restaurant-backup.db")
    source = sqlite3.connect(DB_PATH, timeout=15)
    try:
        backup = sqlite3.connect(temp_db)
        source.backup(backup)
        backup.close()
    finally:
        source.close()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(temp_db, "data/restaurant.db")
        for source_dir, archive_dir in ((TICKETS_DIR, "data/tickets"),
                                        (IMAGES_DIR, "data/item_images"),
                                        (AUDIT_DIR, "data/logs")):
            if os.path.isdir(source_dir):
                for root, dirs, files in os.walk(source_dir):
                    for name in files:
                        path = os.path.join(root, name)
                        relative = os.path.relpath(path, DATA_DIR)
                        archive.write(path, relative.replace(os.sep, "/"))
        if os.path.isfile(CONFIG_PATH):
            archive.write(CONFIG_PATH, "config.json")
    try:
        os.unlink(temp_db)
    except OSError:
        pass
    print("Backup created: %s" % target)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--backup", metavar="PATH",
                        help="Create a timestamped backup archive and exit")
    parser.add_argument("--cleanup-logs", metavar="N", type=int,
                        help="Delete log files older than N days")
    args = parser.parse_args()
    init_db()
    if args.backup:
        create_backup(args.backup)
        raise SystemExit(0)
    if args.cleanup_logs is not None:
        cleanup_old_logs(args.cleanup_logs)
        raise SystemExit(0)
    warning_mb = float(CONFIG.get("disk_warning_mb", 500))
    for label, path in (("item images", IMAGES_DIR), ("audit logs", AUDIT_DIR)):
        used = directory_size_mb(path)
        if used > warning_mb:
            print("WARNING: %s directory exceeds %.0f MB (currently %.1f MB): %s" %
                  (label, warning_mb, used, path))
    conn = db()
    try:
        open_counts = conn.execute(
            "SELECT SUM(status='sent'), SUM(status='preparing'), SUM(status='ready') "
            "FROM orders").fetchone()
        sent, preparing, ready = open_counts
        open_total = sum(v or 0 for v in open_counts)
        print("%d open tickets, %d ready to serve." % (open_total, ready or 0))
    finally:
        conn.close()
    port = int(os.environ.get("PORT") or CONFIG.get("port") or 8080)
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("Restaurant ordering server running")
    print("  On this machine : http://localhost:%d" % port)
    print("  On the LAN      : http://%s:%d   <- open this on the tablets" % (lan_ip(), port))
    print("  Data            : %s" % DB_PATH)
    print("  Admin PIN       : %s  (config.json)" % CONFIG["admin_pin"])
    print("  Printer         : %s" % ((CONFIG.get("printer_ip") or "not configured") +
                                   (":%s" % CONFIG.get("printer_port") if CONFIG.get("printer_ip") else "")))
    def stop_server(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGINT, stop_server)
    signal.signal(signal.SIGTERM, stop_server)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")
    finally:
        server.shutdown()
        server.server_close()
