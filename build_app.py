#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build app.html: inline the src/ parts (css + js) into one self-contained file."""
import os

SRC = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(SRC, "app.html")


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

with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)

size = os.path.getsize(OUT)
print("Built %s (%d bytes, %d lines)" % (OUT, size, html.count("\n") + 1))
