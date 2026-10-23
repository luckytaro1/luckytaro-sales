"""Rebuild the desk's salesperson screens from the desk's packed code, LOCKED with the app key.
usage: python3 make_app.py <dir with meta.json and v*z_N.json chunks> <out app.json> <app key, base64>
Only someone who signed in (their file carries the app key) can unlock it."""
import json, sys, os, gzip, base64, time
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
d, out, key = sys.argv[1], sys.argv[2], base64.b64decode(sys.argv[3])
def load(p):
    x = json.load(open(p)); return x.get('data', x)
m = load(os.path.join(d, 'meta.json'))
z = ''.join(load(os.path.join(d, f"{m['v']}_{i}.json"))['s'] for i in range(m['n']))
P = json.loads(gzip.decompress(base64.b64decode(z)).decode('utf-8'))
js = P['js'].replace('</script', '<' + chr(92) + '/script')
html = ('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<title>Lucky Taro Sales</title>\n'
        '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
        '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=Noto+Sans+SC:wght@500&display=swap" rel="stylesheet">\n'
        f"<style>{P['css']}</style>\n</head>\n<body>{P['body']}<script>{js}</script>\n</body>\n</html>\n")
try:
    if json.load(open(out)).get('v') == m['v'] and not os.environ.get('FORCE'): print(m['v'], 'unchanged'); sys.exit(0)
except Exception: pass
iv = os.urandom(12); ct = AESGCM(key).encrypt(iv, gzip.compress(html.encode('utf-8'), 9), None)
json.dump({'v': m['v'], 'iv': base64.b64encode(iv).decode(), 'ct': base64.b64encode(ct).decode()}, open(out, 'w')); print(m['v'], len(html))
