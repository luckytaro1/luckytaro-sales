"""Lock each salesperson's package with their password and write data/<id>.json.
usage: python3 build.py <pkg_root> <passwords.json>
  pkg_root/<member_id>/{meta,inv*,cust*,cr*}.json  (as saved from team/<id>/pkg)
  logins.json: {"TEST": {"pw": "...", "member": "<member id>"}, ...}  ─ login code → whose package"""
import json, sys, os, glob, gzip, hashlib, base64, time
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
IT = 200000
def load(p):
    d = json.load(open(p)); return d.get('data', d)
root, pwf = sys.argv[1], sys.argv[2]; J = json.load(open(pwf)); AK = J.pop('_appkey', None); LG = {k.upper(): v for k, v in J.items()}
out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data'); os.makedirs(out, exist_ok=True); done = []
for code, lg in LG.items():
    mdir = os.path.join(root, 'team', lg['member'], 'pkg')
    if not os.path.isdir(mdir): mdir = os.path.join(root, lg['member'])
    mf = os.path.join(mdir, 'meta.json')
    if not os.path.exists(mf): print('missing package for', code); continue
    meta = load(mf)
    if meta.get('role') != 'rep': continue
    docs = {}
    for f in sorted(glob.glob(os.path.join(mdir, '*.json'))):
        docs['team/U/pkg/' + os.path.basename(f)[:-5]] = load(f)
    pkg = {'meta': {'name': meta.get('name'), 'code': code, 'rep': meta.get('code'), 'at': meta.get('at')}, 'docs': docs, 'appkey': AK}
    fid = hashlib.sha256(('lt-sales|' + code).encode()).hexdigest()[:20]; fp = os.path.join(out, fid + '.json')
    try:
        old = json.load(open(fp))
        if old.get('at') == int(meta.get('at') or 0) and old.get('v') == 4 and old.get('ak') == hashlib.sha256((AK or '').encode()).hexdigest()[:8] and not os.environ.get('FORCE'): continue   # nothing new from the desk
    except Exception: pass
    raw = gzip.compress(json.dumps(pkg, separators=(',', ':')).encode())
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=IT).derive(lg['pw'].encode())
    ct = AESGCM(key).encrypt(iv, raw, None)
    E = {'v': 4, 'ak': hashlib.sha256((AK or '').encode()).hexdigest()[:8], 'salt': base64.b64encode(salt).decode(), 'iv': base64.b64encode(iv).decode(), 'it': IT, 'at': int(meta.get('at') or time.time() * 1000), 'ct': base64.b64encode(ct).decode()}
    json.dump(E, open(fp, 'w')); done.append((code, fid, len(ct)))
print(json.dumps(done))
