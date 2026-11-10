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
def scramble(src):
    # Scramble the code for the website copy only: wrap it so every name is local, then let esbuild rename them all.
    # Salespeople then can't read or reuse it. Falls back to the plain copy (and says so) if esbuild can't run.
    import subprocess, shutil
    w = '(()=>{' + src + '\n;window.toast=toast;})();'
    def bins():
        for b in (shutil.which('esbuild'), '/opt/npm-tools/node_modules/.bin/esbuild'):
            if b and os.path.exists(b): yield [b]
        try: subprocess.run(['npm', 'i', '-g', 'esbuild'], capture_output=True, timeout=300)
        except Exception: pass
        if shutil.which('esbuild'): yield [shutil.which('esbuild')]
    for cmd in bins():
        try:
            r = subprocess.run(cmd + ['--minify', '--charset=utf8', '--log-level=error', '--loader=js'], input=w.encode('utf-8'), capture_output=True, timeout=300)
            if r.returncode == 0 and len(r.stdout) > len(src) // 4: return r.stdout.decode('utf-8'), True
        except Exception: pass
    return src, False
js, scr = scramble(P['js']) if not os.environ.get('NO_SCRAMBLE') else (P['js'], False)
if not scr: print('WARNING: code NOT scrambled (esbuild missing)')
js = js.replace('</script', '<' + chr(92) + '/script')
html = ('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<title>Lucky Taro Sales</title>\n'
        '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
        '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=Noto+Sans+SC:wght@500&display=swap" rel="stylesheet">\n'
        f"<style>{P['css']}</style>\n</head>\n<body>{P['body']}<script>{js}</script>\n</body>\n</html>\n")
try:
    if json.load(open(out)).get('v') == m['v'] and json.load(open(out)).get('s') == int(scr) and not os.environ.get('FORCE'): print(m['v'], 'unchanged'); sys.exit(0)
except Exception: pass
iv = os.urandom(12); ct = AESGCM(key).encrypt(iv, gzip.compress(html.encode('utf-8'), 9), None)
json.dump({'v': m['v'], 's': int(scr), 'iv': base64.b64encode(iv).decode(), 'ct': base64.b64encode(ct).decode()}, open(out, 'w')); print(m['v'], len(html))
