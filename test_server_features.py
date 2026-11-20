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
            migrated.close()
        finally:
            server.DATA_DIR, server.DB_PATH, server.TICKETS_DIR, server.IMAGES_DIR = original
            legacy.cleanup()

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
        self.assertTrue(os.path.isfile(os.path.join(server.IMAGES_DIR, "%d.png" % item_id)))
        self.assertEqual(uploaded["image_url"], "/item-images/%d.png" % item_id)

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
