import base64
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import server


class RestaurantFeatureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        server.DATA_DIR = self.temp.name
        server.DB_PATH = os.path.join(self.temp.name, "restaurant.db")
        server.TICKETS_DIR = os.path.join(self.temp.name, "tickets")
        server.IMAGES_DIR = os.path.join(self.temp.name, "item_images")
        server.AUDIT_DIR = os.path.join(self.temp.name, "logs")
        os.makedirs(server.AUDIT_DIR, exist_ok=True)
        server.CONFIG = dict(server.DEFAULT_CONFIG)
        server.init_db()
        self.conn = server.db()

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def test_existing_database_migrates_without_losing_menu(self):
        legacy = tempfile.TemporaryDirectory()
        original = (server.DATA_DIR, server.DB_PATH, server.TICKETS_DIR, server.IMAGES_DIR)
        try:
            server.DATA_DIR = legacy.name
            server.DB_PATH = os.path.join(legacy.name, "restaurant.db")
            server.TICKETS_DIR = os.path.join(legacy.name, "tickets")
            server.IMAGES_DIR = os.path.join(legacy.name, "item_images")
            conn = sqlite3.connect(server.DB_PATH)
            conn.executescript("""
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                INSERT INTO meta VALUES('rev','1');
                CREATE TABLE sections (id INTEGER PRIMARY KEY, name TEXT, position INTEGER, active INTEGER);
                CREATE TABLE items (id INTEGER PRIMARY KEY, section_id INTEGER, name TEXT, price REAL,
                                    description TEXT, position INTEGER, active INTEGER);
                INSERT INTO sections VALUES(1,'Legacy section',1,1);
                INSERT INTO items VALUES(1,1,'Legacy dish',12.5,'',1,1);
            """)
            conn.commit()
            conn.close()
            server.init_db()
            migrated = server.db()
            self.assertEqual(migrated.execute("SELECT name FROM sections WHERE id=1").fetchone()[0],
                             "Legacy section")
            item = migrated.execute("SELECT name,branch_id,stock_qty,modifiers FROM items WHERE id=1").fetchone()
            self.assertEqual(tuple(item), ("Legacy dish", 1, None, "[]"))
            product = migrated.execute(
                "SELECT p.id,p.name,p.section_id,v.name,v.price_cents,"
                "v.stock_qty,v.is_default "
                "FROM products p JOIN product_variants v ON v.product_id=p.id "
                "JOIN catalog_migration_items m ON m.product_id=p.id "
                "WHERE m.item_id=1").fetchone()
            self.assertEqual(tuple(product),
                             (product["id"], "Legacy dish", 1, "Regular",
                              1250, None, 1))
            server.init_db()
            migrated.close()
            migrated = server.db()
            self.assertEqual(
                migrated.execute("SELECT COUNT(*) FROM products").fetchone()[0], 1)
            self.assertEqual(
                migrated.execute("SELECT COUNT(*) FROM product_variants").fetchone()[0], 1)
            migrated.close()
        finally:
            server.DATA_DIR, server.DB_PATH, server.TICKETS_DIR, server.IMAGES_DIR = original
            legacy.cleanup()

    def test_newer_database_schema_is_refused(self):
        conn = self.conn
        conn.execute("PRAGMA user_version=999")
        conn.commit()
        conn.close()
        with self.assertRaisesRegex(RuntimeError, "newer version"):
            server.init_db()
        self.conn = server.db()

    def test_integer_cents_and_default_variant_invariants(self):
        item = self.conn.execute("SELECT id,price FROM items ORDER BY id LIMIT 1").fetchone()
        server.h_item_update([str(item["id"])], {
            "branch_id": 1,
            "price": 12.34,
        }, self.conn)
        variant = self.conn.execute(
            "SELECT v.price_cents,v.is_default "
            "FROM product_variants v JOIN catalog_migration_items m "
            "ON m.variant_id=v.id WHERE m.item_id=?",
            (item["id"],)).fetchone()
        self.assertEqual(variant["price_cents"], 1234)
        self.assertEqual(variant["is_default"], 1)
        product_id = self.conn.execute(
            "SELECT product_id FROM catalog_migration_items WHERE item_id=?",
            (item["id"],)).fetchone()["product_id"]
        variant_id = self.conn.execute(
            "SELECT variant_id FROM catalog_migration_items WHERE item_id=?",
            (item["id"],)).fetchone()["variant_id"]
        with self.assertRaises(server.ApiError) as error:
            server.h_catalog_variant_update(
                [str(variant_id)],
                {"branch_id": 1, "is_default": 0},
                self.conn)
        self.assertEqual(error.exception.code, 400)

    def test_catalog_product_order_modifiers_and_legacy_write(self):
        section = self.conn.execute("SELECT id FROM sections LIMIT 1").fetchone()
        result = server.h_catalog_product_create([], {
            "branch_id": 1,
            "section_id": section["id"],
            "name": "Catalog Pizza",
            "variants": [
                {"name": "Small", "price_cents": 800, "stock_qty": 5,
                 "is_default": 1, "active": 1},
                {"name": "Large", "price_cents": 1400, "stock_qty": 3,
                 "is_default": 0, "active": 1},
            ],
        }, self.conn)
        product_id = result["product_id"]
        group = server.h_catalog_group_create([], {
            "branch_id": 1, "name": "Extras", "selection_type": "multi",
            "min_select": 1, "max_select": 2,
        }, self.conn)
        option = server.h_catalog_option_create([str(group["modifier_group_id"])], {
            "branch_id": 1, "name": "Extra cheese",
            "price_delta_cents": 200,
        }, self.conn)
        server.h_catalog_product_groups([str(product_id)], {
            "branch_id": 1,
            "modifier_groups": [{
                "modifier_group_id": group["modifier_group_id"],
                "override_min": 1,
                "override_max": 2,
            }],
        }, self.conn)
        small = self.conn.execute(
            "SELECT id FROM product_variants "
            "WHERE product_id=? AND name='Small'", (product_id,)).fetchone()
        large = self.conn.execute(
            "SELECT id FROM product_variants "
            "WHERE product_id=? AND name='Large'", (product_id,)).fetchone()
        order = server.h_catalog_order_create({
            "branch_id": 1,
            "table_no": 9,
            "client_uuid": "catalog-order",
            "lines": [{
                "product_id": product_id,
                "variant_id": large["id"],
                "modifier_option_ids": [option["modifier_option_id"]],
                "qty": 2,
            }],
        }, self.conn, 1)
        line = self.conn.execute(
            "SELECT price,unit_price_cents,variant_name,modifiers_json,"
            "stock_debited FROM order_items WHERE order_id=?",
            (order["order_id"],)).fetchone()
        self.assertEqual(line["unit_price_cents"], 1600)
        self.assertEqual(line["variant_name"], "Large")
        self.assertEqual(
            json.loads(line["modifiers_json"])[0]["delta"], 200)
        self.assertEqual(
            self.conn.execute(
                "SELECT stock_qty FROM product_variants WHERE id=?",
                (large["id"],)).fetchone()[0], 1)
        with self.assertRaises(server.ApiError) as error:
            server.h_items_legacy_write([], {"branch_id": 1}, self.conn)
        self.assertEqual(error.exception.code, 405)

    def test_catalog_historical_price_and_variant_cancel_stock(self):
        section = self.conn.execute("SELECT id FROM sections LIMIT 1").fetchone()
        product = server.h_catalog_product_create([], {
            "branch_id": 1,
            "section_id": section["id"],
            "name": "Snapshot Pizza",
            "variants": [{
                "name": "Large", "price_cents": 1400,
                "stock_qty": 4, "is_default": 1, "active": 1,
            }],
        }, self.conn)
        product_id = product["product_id"]
        variant = self.conn.execute(
            "SELECT id FROM product_variants WHERE product_id=?",
            (product_id,)).fetchone()
        order = server.h_catalog_order_create({
            "table_no": 5,
            "lines": [{
                "product_id": product_id,
                "variant_id": variant["id"],
                "modifier_option_ids": [],
                "qty": 1,
            }],
        }, self.conn, 1)
        server.h_catalog_variant_update([str(variant["id"])], {
            "branch_id": 1,
            "price_cents": 1900,
        }, self.conn)
        loaded = server.get_order(self.conn, order["order_id"])
        self.assertEqual(loaded["lines"][0]["unit_price_cents"], 1400)
        server.h_order_status([str(order["order_id"])], {
            "branch_id": 1,
            "status": "cancelled",
        }, self.conn)
        restored = self.conn.execute(
            "SELECT stock_qty FROM product_variants WHERE id=?",
            (variant["id"],)).fetchone()[0]
        self.assertEqual(restored, 4)

    def test_catalog_modifier_and_variant_validation(self):
        section = self.conn.execute("SELECT id FROM sections LIMIT 1").fetchone()
        product = server.h_catalog_product_create([], {
            "branch_id": 1,
            "section_id": section["id"],
            "name": "Validation Pizza",
            "variants": [{
                "name": "Regular", "price_cents": 1000,
                "stock_qty": 2, "is_default": 1, "active": 1,
            }],
        }, self.conn)
        product_id = product["product_id"]
        with self.assertRaises(server.ApiError):
            server.h_catalog_product_create([], {
                "branch_id": 1, "section_id": section["id"],
                "name": "No variants", "variants": [],
            }, self.conn)
        group = server.h_catalog_group_create([], {
            "branch_id": 1, "name": "Required Crust",
            "selection_type": "single", "min_select": 1, "max_select": 1,
        }, self.conn)
        server.h_catalog_product_groups([str(product_id)], {
            "branch_id": 1,
            "modifier_groups": [{
                "modifier_group_id": group["modifier_group_id"],
                "override_min": 1, "override_max": 1,
            }],
        }, self.conn)
        variant = self.conn.execute(
            "SELECT id FROM product_variants WHERE product_id=?",
            (product_id,)).fetchone()
        with self.assertRaises(server.ApiError) as error:
            server.h_catalog_order_create({
                "table_no": 4,
                "lines": [{
                    "product_id": product_id,
                    "variant_id": variant["id"],
                    "modifier_option_ids": [],
                    "qty": 1,
                }],
            }, self.conn, 1)
        self.assertEqual(error.exception.code, 400)

    def test_branch_copy_is_isolated(self):
        source = server.h_state([], {"branch_id": 1}, self.conn)
        created = server.h_branch_create([], {"branch_id": 1, "name": "Downtown", "copy_menu": True}, self.conn)
        target = server.h_state([], {"branch_id": created["branch_id"]}, self.conn)
        self.assertEqual(len(source["items"]), len(target["items"]))
        self.assertNotEqual(source["items"][0]["id"], target["items"][0]["id"])
        self.assertEqual(source["staff"][0]["branch_id"], 1)
        self.assertEqual(target["items"][0]["branch_id"], created["branch_id"])

    def test_order_modifiers_stock_and_cancellation(self):
        item = self.conn.execute("SELECT id,price FROM items ORDER BY id LIMIT 1").fetchone()
        server.h_item_update([str(item["id"])], {
            "branch_id": 1, "stock_qty": 2,
            "modifiers": [{"name": "Extra", "price": 1.5}],
        }, self.conn)
        order = server.h_order_create([], {
            "branch_id": 1, "table_no": 1, "client_uuid": "stock-order",
            "lines": [{"item_id": item["id"], "qty": 2, "modifiers": [{"name": "Extra", "price": 999}]}],
        }, self.conn)
        self.assertEqual(self.conn.execute("SELECT stock_qty FROM items WHERE id=?", (item["id"],)).fetchone()[0], 0)
        loaded = server.get_order(self.conn, order["order_id"])
        self.assertEqual(loaded["total"], round((item["price"] + 1.5) * 2, 2))
        mapping = self.conn.execute(
            "SELECT variant_id FROM catalog_migration_items WHERE item_id=?",
            (item["id"],)).fetchone()
        accept_movement = self.conn.execute(
            "SELECT delta,reason FROM stock_movements "
            "WHERE variant_id=? AND reason='order_accept'",
            (mapping["variant_id"],)).fetchone()
        self.assertEqual(tuple(accept_movement), (-2, "order_accept"))
        server.h_line_status([str(order["order_id"]), str(loaded["lines"][0]["id"])],
                             {"branch_id": 1, "status": "cancelled"}, self.conn)
        self.assertEqual(self.conn.execute("SELECT stock_qty FROM items WHERE id=?", (item["id"],)).fetchone()[0], 2)

    def test_payments_split_bill_request_and_sales(self):
        item = self.conn.execute("SELECT id,price FROM items ORDER BY id LIMIT 1").fetchone()
        order = server.h_order_create([], {
            "branch_id": 1, "table_no": 1, "client_uuid": "payment-order",
            "lines": [{"item_id": item["id"], "qty": 2}],
        }, self.conn)
        loaded = server.get_order(self.conn, order["order_id"])
        line = loaded["lines"][0]
        result = server.h_payment_create([str(order["order_id"])], {
            "branch_id": 1, "amount": item["price"], "method": "cash",
            "allocations": [{"line_id": line["id"], "qty": 1}],
        }, self.conn)
        self.assertEqual(result["balance"], item["price"])
        self.assertEqual(result["payment_id"] > 0, True)
        server.h_bill_request([str(order["order_id"])], {"branch_id": 1}, self.conn)
        state = server.h_state([], {"branch_id": 1}, self.conn)
        self.assertTrue(next(o for o in state["orders"] if o["id"] == order["order_id"])["bill_requested"])
        self.assertEqual(state["orders"][0]["paid"], item["price"])
        self.assertTrue(server.h_sales([], {"branch_id": 1, "period": "7d"}, self.conn)["daily"])
        with self.assertRaises(server.ApiError):
            server.h_payment_create([str(order["order_id"])], {
                "branch_id": 1, "amount": 1000, "method": "cash",
            }, self.conn)
        server.h_payment_refund([str(result["payment_id"])], {
            "branch_id": 1, "amount": item["price"],
        }, self.conn)
        state = server.h_state([], {"branch_id": 1}, self.conn)
        self.assertEqual(state["orders"][0]["paid"], 0)

    def test_reservation_and_uploaded_image(self):
        starts_at = server.time.time() + 3600
        result = server.h_reservation_create([], {
            "branch_id": 1, "guest_name": "Guest", "contact": "123",
            "starts_at": starts_at, "party_size": 3, "table_no": 4,
        }, self.conn)
        server.h_reservation_update([str(result["reservation_id"])],
                                    {"branch_id": 1, "status": "seated"}, self.conn)
        reservation = self.conn.execute("SELECT * FROM reservations WHERE id=?",
                                        (result["reservation_id"],)).fetchone()
        self.assertEqual(reservation["status"], "seated")
        item_id = self.conn.execute("SELECT id FROM items LIMIT 1").fetchone()[0]
        image = base64.b64encode(
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
            b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89").decode("ascii")
        uploaded = server.h_item_image([str(item_id)], {
            "branch_id": 1, "mime": "image/png", "data": image,
        }, self.conn)
        filename = os.path.basename(uploaded["image_url"])
        self.assertRegex(filename, r"[0-9a-f]{32}\.png")
        self.assertTrue(os.path.isfile(os.path.join(server.IMAGES_DIR, filename)))

        with self.assertRaises(server.ApiError) as error:
            server.h_item_image([str(item_id)], {
                "branch_id": 1, "mime": "image/png",
                "data": base64.b64encode(b"\x89PNG" + b"x" * 3_000_000).decode("ascii"),
            }, self.conn)
        self.assertEqual(error.exception.code, 413)

    def test_negative_cross_branch_resource_access(self):
        branch = server.h_branch_create([], {"branch_id": 1, "name": "Branch B"}, self.conn)
        branch_id = branch["branch_id"]

        item = self.conn.execute("SELECT id FROM items WHERE branch_id=1 LIMIT 1").fetchone()
        staff = self.conn.execute("SELECT id FROM staff WHERE branch_id=1 LIMIT 1").fetchone()
        order = server.h_order_create([], {
            "branch_id": 1, "table_no": 1, "client_uuid": "cross-order",
            "lines": [{"item_id": item["id"], "qty": 1}],
        }, self.conn)
        reservation = server.h_reservation_create([], {
            "branch_id": 1, "guest_name": "Private Guest",
            "starts_at": server.time.time() + 7200, "party_size": 2,
        }, self.conn)

        calls = [
            lambda: server.h_order_status([str(order["order_id"])],
                                          {"branch_id": branch_id, "status": "ready"}, self.conn),
            lambda: server.h_item_update([str(item["id"])],
                                         {"branch_id": branch_id, "name": "Leak"}, self.conn),
            lambda: server.h_staff_update([str(staff["id"])],
                                          {"branch_id": branch_id, "name": "Leak"}, self.conn),
            lambda: server.h_reservation_update([str(reservation["reservation_id"])],
                                                {"branch_id": branch_id, "status": "seated"}, self.conn),
            lambda: server.h_sales([], {"branch_id": branch_id, "period": "7d"}, self.conn),
        ]
        # Sales is branch-valid and must return Branch B data, not Branch A data.
        for call in calls[:4]:
            with self.assertRaises(server.ApiError) as error:
                call()
            self.assertIn(error.exception.code, (403, 404))
        branch_sales = calls[4]()
        self.assertEqual(branch_sales["daily"], [])

    def test_payment_split_cannot_over_allocate(self):
        item = self.conn.execute("SELECT id,price FROM items ORDER BY id LIMIT 1").fetchone()
        server.h_item_update([str(item["id"])], {"branch_id": 1, "price": 6}, self.conn)
        order = server.h_order_create([], {
            "branch_id": 1, "table_no": 2, "client_uuid": "split-order",
            "lines": [{"item_id": item["id"], "qty": 2}],
        }, self.conn)
        loaded = server.get_order(self.conn, order["order_id"])
        line = loaded["lines"][0]
        with self.assertRaises(server.ApiError) as error:
            server.h_payment_create([str(order["order_id"])], {
                "branch_id": 1, "amount": 10, "method": "cash",
                "allocations": [{"line_id": line["id"], "qty": 2}],
            }, self.conn)
        self.assertEqual(error.exception.code, 400)
        self.assertIn("match", error.exception.msg)

    def test_audit_log_allowlist_excludes_guest_name(self):
        server.AUDIT_DIR = os.path.join(self.temp.name, "logs")
        os.makedirs(server.AUDIT_DIR, exist_ok=True)
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base_url = "http://127.0.0.1:%d" % httpd.server_address[1]
        try:
            payload = json.dumps({
                "branch_id": 1, "guest_name": "Sensitive Audit Guest",
                "contact": "555-SECRET", "starts_at": server.time.time() + 3600,
                "party_size": 4, "table_no": 7,
            }).encode()
            request = urllib.request.Request(
                base_url + "/api/reservations", data=payload, method="POST",
                headers={"Content-Type": "application/json", "X-Branch-ID": "1",
                         "X-Admin-Pin": server.CONFIG["admin_pin"]})
            with urllib.request.urlopen(request) as response:
                json.load(response)
            log_files = [os.path.join(server.AUDIT_DIR, name)
                         for name in os.listdir(server.AUDIT_DIR)
                         if name.endswith(".jsonl")]
            self.assertTrue(log_files)
            with open(log_files[-1], "r", encoding="utf-8") as log:
                content = log.read()
            self.assertNotIn("Sensitive Audit Guest", content)
            self.assertNotIn("555-SECRET", content)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_http_routes_enforce_admin_and_branch_headers(self):
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base_url = "http://127.0.0.1:%d" % httpd.server_address[1]
        try:
            with urllib.request.urlopen(base_url + "/api/state") as response:
                state = json.load(response)
            self.assertEqual(state["branch_id"], 1)

            payload = json.dumps({"name": "HTTP Test Branch", "copy_menu": True}).encode()
            request = urllib.request.Request(
                base_url + "/api/branches", data=payload, method="POST",
                headers={"Content-Type": "application/json", "X-Branch-ID": "1"})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 403)

            request.add_header("X-Admin-Pin", server.CONFIG["admin_pin"])
            with urllib.request.urlopen(request) as response:
                created = json.load(response)
            self.assertTrue(created["branch_id"] > 1)

            request = urllib.request.Request(
                base_url + "/api/state", headers={"X-Branch-ID": str(created["branch_id"])})
            with urllib.request.urlopen(request) as response:
                copied_state = json.load(response)
            self.assertEqual(copied_state["branch_id"], created["branch_id"])
            self.assertEqual(len(state["items"]), len(copied_state["items"]))
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
