"""Generate the pairing QR for claude-bridge.

Deferred in the MVP because a hand-rolled QR encoder is the most error-prone part of
the project. This version delegates encoding to `segno` (an independent, well-tested
implementation) rather than writing matrices by hand — the risk that justified
deferring does not apply when we are not writing the encoder ourselves.

Run with a throwaway interpreter path; segno lives in a temp dir, never in the user's
env:
    python tools/make-qr.py
"""

import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, os.path.join(os.environ.get("TEMP", "/tmp"), "qrgen-tmp"))

import segno  # noqa: E402
from PIL import Image  # noqa: E402

cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
token = (ROOT / ".bridge-token").read_text(encoding="utf-8").strip()

host = cfg.get("host", "127.0.0.1")
if host == "tailscale":
    import subprocess
    ts = r"C:\Program Files\Tailscale\tailscale.exe"
    out = subprocess.run([ts, "ip", "-4"], capture_output=True, text=True, timeout=10)
    host = next((l.strip() for l in out.stdout.splitlines() if l.strip()), "127.0.0.1")

url = f"http://{host}:{cfg['port']}/?t={token}"
out_png = ROOT / "pairing-qr.png"

# error='h' keeps it scannable even on a dim phone screen or a scaled-down screenshot.
qr = segno.make(url, error="h")
qr.save(str(out_png), kind="png", scale=12, border=4, dark="#000000", light="#FFFFFF")
img = Image.open(out_png)
img.save(out_png)

print("url   :", url)
print("file  :", out_png)
print("size  :", f"{img.size[0]}x{img.size[1]}")
print("format:", qr.version, "ec=", qr.error, "mask=", qr.mask)
print("\n注意：这个二维码含配对 token，等同于密码。别转发、别发到群里。")
