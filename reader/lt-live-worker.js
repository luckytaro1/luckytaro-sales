// Lucky Taro live link (Cloudflare Worker + D1 database "DB")
// - The Buying Desk sends each salesperson's LOCKED file here (through a claude.ai connector), the moment it changes.
// - sales.luckytaro.com reads it from here. Files are locked with each salesperson's password; this worker can't read them.
// - Order pictures: a salesperson uploads a photo on the website (POST /pic/<id>); the desk picks it up with get_log {pics:true} / {pic:"<id>"} / {pic_done:"<id>"}.
// - Device lock: file "k_<id>" (never served) holds {dk, devs, on}. POST /k/<id> {dev, nm} hands dk only to an approved device and logs every sign-in
//   (with the city Cloudflare sees). The salesperson's file is locked with password + dk, so the password alone opens nothing on a new device.
// The connector address is  https://<this worker>/mcp/<KEY>  ─ KEY is the secret you set under Settings → Variables and Secrets.
const ORIGIN = "https://sales.luckytaro.com";
const CORS = { "access-control-allow-origin": ORIGIN, "access-control-allow-methods": "GET,POST", "access-control-allow-headers": "content-type", "cache-control": "no-store" };
const ok = (id, result) => Response.json({ jsonrpc: "2.0", id, result });
const txt = (id, t) => ok(id, { content: [{ type: "text", text: t }] });
const bad = (id, t) => ok(id, { isError: true, content: [{ type: "text", text: t }] });
const ID = v => String(v || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
const MAX_BODY = 4_000_000, LOG_PER_FILE_DAY = 400, LOG_ROWS_MAX = 20000, PIC_MAX = 900_000, PIC_PER_FILE_DAY = 60;
const TOOLS = [
  { name: "put_file", description: "Save one locked salesperson file. id: the file id (letters/digits/_-). body: the file text.", inputSchema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" } }, required: ["id", "body"] } },
  { name: "delete_file", description: "Delete files: the exact id, and (prefix=true) every file whose id starts with id + '_'.", inputSchema: { type: "object", properties: { id: { type: "string" }, prefix: { type: "boolean" }, keep: { type: "string" } }, required: ["id"] } },
  { name: "get_log", description: "Read what salespeople did on the website, oldest first, after `since` (epoch ms). Each row: {at, who (file id), what}. Order pictures: pics=true lists waiting pictures {id, who, grp, page, n, at, note}; pic=<id> returns that picture (base64 JPEG); pic_done=<id> removes it.", inputSchema: { type: "object", properties: { since: { type: "number" }, pics: { type: "boolean" }, pic: { type: "string" }, pic_done: { type: "string" } } } }
];
let ready = false;
async function setup(env){ if (ready) return; await env.DB.batch([
  env.DB.prepare("CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, body TEXT, at INTEGER)"),
  env.DB.prepare("CREATE TABLE IF NOT EXISTS log (at INTEGER, who TEXT, what TEXT)"),
  env.DB.prepare("CREATE INDEX IF NOT EXISTS log_at ON log(at)"),
  env.DB.prepare("CREATE TABLE IF NOT EXISTS pics (id TEXT PRIMARY KEY, who TEXT, grp TEXT, page INTEGER, n INTEGER, at INTEGER, note TEXT, body TEXT)") ]); ready = true; }
const clean = s => String(s || "").replace(/[<>\u0000-\u001f]/g, " ").slice(0, 300);
export default {
  async fetch(req, env){ const u = new URL(req.url), p = u.pathname.split("/").filter(Boolean);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    // the website: GET /h/<id> → {w} (when the file was last saved ─ tiny, polled often); GET /d/<id> → the locked file
    if ((p[0] === "d" || p[0] === "h") && p[1] && req.method === "GET"){ await setup(env); const id = ID(p[1]); if (/^k_/.test(id)) return new Response("not found", { status: 404, headers: CORS });
      if (p[0] === "h"){ const r = await env.DB.prepare("SELECT at FROM files WHERE id = ?").bind(id).first(); return r ? Response.json({ w: r.at }, { headers: CORS }) : new Response("not found", { status: 404, headers: CORS }); }
      const r = await env.DB.prepare("SELECT body FROM files WHERE id = ?").bind(id).first();
      return r ? new Response(r.body, { headers: { ...CORS, "content-type": "application/json" } }) : new Response("not found", { status: 404, headers: CORS }); }
    // the website: POST /log/<id>  {what} ─ a salesperson's activity. Only for a file that exists; who = that file (never taken from the request); capped per file per day.
    if (p[0] === "log" && p[1] && req.method === "POST"){ if (req.headers.get("origin") !== ORIGIN) return new Response("no", { status: 403 });
      await setup(env); const id = ID(p[1]); if (id.includes("_")) return new Response("no", { status: 404, headers: CORS });
      const f = await env.DB.prepare("SELECT id FROM files WHERE id = ?").bind(id).first(); if (!f) return new Response("no", { status: 404, headers: CORS });
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM log WHERE who = ? AND at > ?").bind(id, Date.now() - 864e5).first();
      if (n && n.n >= LOG_PER_FILE_DAY) return new Response("busy", { status: 429, headers: CORS });
      let b = {}; try { b = JSON.parse((await req.text()).slice(0, 2000)); } catch(e){}
      await env.DB.prepare("INSERT INTO log VALUES (?, ?, ?)").bind(Date.now(), id, clean(b.what)).run();
      return new Response("ok", { headers: CORS }); }
    // the website, signing in: POST /k/<id> {dev, nm} → {dk} for an approved device (or when the lock is off) · 403 {pending} for a new device
    if (p[0] === "k" && p[1] && req.method === "POST"){ if (req.headers.get("origin") !== ORIGIN) return new Response("no", { status: 403 });
      await setup(env); const who = ID(p[1]); if (!who || who.includes("_")) return new Response("no", { status: 404, headers: CORS });
      const f = await env.DB.prepare("SELECT id FROM files WHERE id = ?").bind(who).first(); if (!f) return new Response("no", { status: 404, headers: CORS });
      const n0 = await env.DB.prepare("SELECT COUNT(*) AS n FROM log WHERE who = ? AND at > ?").bind(who, Date.now() - 864e5).first(); if (n0 && n0.n >= LOG_PER_FILE_DAY) return new Response("busy", { status: 429, headers: CORS });
      let b = {}; try { b = JSON.parse((await req.text()).slice(0, 1000)); } catch(e){}
      const dev = String(b.dev || ""), nm = clean(b.nm).slice(0, 60), cf = req.cf || {}, where = clean([cf.city, cf.region, cf.country].filter(Boolean).join(", ")).slice(0, 60);
      if (!/^[A-Za-z0-9]{16,40}$/.test(dev)) return new Response("bad", { status: 400, headers: CORS });
      const kr = await env.DB.prepare("SELECT body FROM files WHERE id = ?").bind("k_" + who).first(); let K = null; try { K = kr ? JSON.parse(kr.body) : null; } catch(e){}
      const ok = !K || !K.on || (K.devs || []).includes(dev);
      await env.DB.prepare("INSERT INTO log VALUES (?, ?, ?)").bind(Date.now(), who, clean(`[signin] ${ok ? "ok" : "new-device"} dev=${dev} where=${where || "?"} on=${nm || "?"}`)).run();
      return ok ? Response.json({ dk: (K && K.dk) || "" }, { headers: CORS }) : Response.json({ pending: true, where, nm }, { status: 403, headers: CORS }); }
    // the website: POST /pic/<id>  {g, p, n, b, note} ─ one page of an order picture (b = base64 JPEG). Only for a login file that exists; capped per file per day.
    if (p[0] === "pic" && p[1] && req.method === "POST"){ if (req.headers.get("origin") !== ORIGIN) return new Response("no", { status: 403 });
      await setup(env); const who = ID(p[1]); if (!who || who.includes("_")) return new Response("no", { status: 404, headers: CORS });
      const f = await env.DB.prepare("SELECT id FROM files WHERE id = ?").bind(who).first(); if (!f) return new Response("no", { status: 404, headers: CORS });
      const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM pics WHERE who = ? AND at > ?").bind(who, Date.now() - 864e5).first(); if (c && c.n >= PIC_PER_FILE_DAY) return new Response("busy", { status: 429, headers: CORS });
      const raw = await req.text(); if (raw.length > PIC_MAX + 2000) return new Response("too big", { status: 413, headers: CORS });
      let b = {}; try { b = JSON.parse(raw); } catch(e){ return new Response("bad", { status: 400, headers: CORS }); }
      const img = String(b.b || ""), g = ID(b.g), page = Math.max(1, Math.min(10, Number(b.p) || 1)), n = Math.max(page, Math.min(10, Number(b.n) || 1));
      if (!g || !/^[A-Za-z0-9+/=]+$/.test(img) || img.length < 500 || img.length > PIC_MAX) return new Response("bad", { status: 400, headers: CORS });
      await env.DB.prepare("INSERT OR REPLACE INTO pics VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(`${who}-${g}-${page}`, who, g, page, n, Date.now(), clean(b.note), img).run();
      return new Response("ok", { headers: CORS }); }
    // the desk (claude.ai connector): /mcp/<KEY>
    if (p[0] === "mcp"){ if (!env.KEY || env.KEY.length < 20 || p[1] !== env.KEY) return new Response("no", { status: 403 });
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const m = await req.json(); if (m.id === undefined) return new Response(null, { status: 202 });
      if (m.method === "initialize") return ok(m.id, { protocolVersion: (m.params && m.params.protocolVersion) || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Lucky Taro Live", version: "2" } });
      if (m.method === "ping") return ok(m.id, {});
      if (m.method === "tools/list") return ok(m.id, { tools: TOOLS });
      if (m.method === "tools/call"){ await setup(env); const a = (m.params && m.params.arguments) || {}, n = m.params && m.params.name;
        if (n === "put_file"){ const id = ID(a.id), body = String(a.body || ""); if (!id) return bad(m.id, "bad id"); if (body.length > MAX_BODY) return bad(m.id, "too big");
          await env.DB.prepare("INSERT INTO files VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, at = excluded.at").bind(id, body, Date.now()).run();
          return txt(m.id, "saved " + id); }
        if (n === "delete_file"){ const id = ID(a.id), keep = ID(a.keep); if (!id) return bad(m.id, "bad id"); const esc = x => x.replace(/[!_%]/g, "!$&");
          if (!keep) await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();   /* with keep: only old parts are removed, the file itself stays */
          if (a.prefix && keep) await env.DB.prepare("DELETE FROM files WHERE id LIKE ? ESCAPE '!' AND id NOT LIKE ? ESCAPE '!'").bind(esc(id) + "!_%", esc(keep) + "%").run();
          else if (a.prefix) await env.DB.prepare("DELETE FROM files WHERE id LIKE ? ESCAPE '!'").bind(esc(id) + "!_%").run();
          return txt(m.id, "deleted"); }
        if (n === "get_log" && a.kinfo) return txt(m.id, "k1");
        if (n === "get_log" && a.pics){ await env.DB.prepare("DELETE FROM pics WHERE at < ?").bind(Date.now() - 3 * 864e5).run();
          const r = await env.DB.prepare("SELECT id, who, grp, page, n, at, note FROM pics ORDER BY at ASC LIMIT 200").all(); return txt(m.id, JSON.stringify(r.results || [])); }
        if (n === "get_log" && a.pic){ const r = await env.DB.prepare("SELECT body FROM pics WHERE id = ?").bind(String(a.pic).slice(0, 200)).first(); return r ? txt(m.id, r.body) : bad(m.id, "no such picture"); }
        if (n === "get_log" && a.pic_done){ await env.DB.prepare("DELETE FROM pics WHERE id = ?").bind(String(a.pic_done).slice(0, 200)).run(); return txt(m.id, "deleted"); }
        if (n === "get_log"){ const r = await env.DB.prepare("SELECT at, who, what FROM log WHERE at > ? ORDER BY at ASC LIMIT 500").bind(Number(a.since) || 0).all();
          await env.DB.prepare("DELETE FROM log WHERE at < ?").bind(Date.now() - 30 * 864e5).run();
          await env.DB.prepare("DELETE FROM log WHERE rowid IN (SELECT rowid FROM log ORDER BY at DESC LIMIT -1 OFFSET ?)").bind(LOG_ROWS_MAX).run();
          return txt(m.id, JSON.stringify(r.results || [])); }
        return bad(m.id, "unknown tool"); }
      return Response.json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown method" } }); }
    return new Response("Lucky Taro", { headers: CORS }); } };
