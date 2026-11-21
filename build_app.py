#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build app.html: inline the src/ parts (css + js) into one self-contained file."""
import argparse
import os

SRC = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(SRC, "app.html")
SOURCES = ("top.html", "app.css", "mid.html", "app1.js", "app2.js", "app3.js")

parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true",
                    help="Verify generated app.html is up to date without writing it")
args = parser.parse_args()

missing = [name for name in SOURCES if not os.path.isfile(os.path.join(SRC, name))]
if missing:
    raise SystemExit("ERROR: missing build source file(s): " + ", ".join(missing))

if args.check and not os.path.exists(OUT):
    raise SystemExit("ERROR: app.html is missing")


def read(name):
    with open(os.path.join(SRC, name), "r", encoding="utf-8") as f:
        return f.read()


top = read("top.html")
css = read("app.css")
mid = read("mid.html")
js = "\n".join(read(n) for n in ("app1.js", "app2.js", "app3.js"))

# safety: inline JS must not contain a closing script tag
if "</script" in js.lower():
    raise SystemExit("ERROR: app JS contains '</script' — would break inlining")

html = top + "<style>\n" + css + "</style>\n" + mid + "<script>\n" + js + "</script>\n</body>\n</html>\n"

if args.check:
    with open(OUT, "r", encoding="utf-8") as f:
        current = f.read()
    if current != html:
        raise SystemExit("ERROR: app.html is stale or was edited directly; run build_app.py")
    print("app.html is up to date")
    raise SystemExit(0)

with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)

size = os.path.getsize(OUT)
print("Built %s (%d bytes, %d lines)" % (OUT, size, html.count("\n") + 1))
