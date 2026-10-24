// Lucky Taro live link (Cloudflare Worker + D1 database "DB")
// - The Buying Desk sends each salesperson's LOCKED file here (through a claude.ai connector), the moment it changes.
// - sales.luckytaro.com reads it from here. Files are locked with each salesperson's password; this worker can't read them.
// The connector address is  https://<this worker>/mcp/<KEY>  ─ KEY is the secret you set under Settings → Variables and Secrets.
const CORS = { "access-control-allow-origin": "https://sales.luckytaro.com", "access-control-allow-methods": "GET", "cache-control": "no-store" };
const ok = (id, result) => Response.json({ jsonrpc: "2.0", id, result });
const TOOLS = [
  { name: "put_file", description: "Save one locked salesperson file (or a small note). id: the file id (letters/digits). body: the file text.", inputSchema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" } }, required: ["id", "body"] } },
  { name: "get_log", description: "Read what salespeople did on the website (newest first).", inputSchema: { type: "object", properties: { since: { type: "number" } } } }
];
async function setup(env){ await env.DB.batch([
  env.DB.prepare("CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, body TEXT, at INTEGER)"),
  env.DB.prepare("CREATE TABLE IF NOT EXISTS log (at INTEGER, who TEXT, what TEXT)") ]); }
export default {
  async fetch(req, env){ const u = new URL(req.url), p = u.pathname.split("/").filter(Boolean);
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "access-control-allow-methods": "GET,POST", "access-control-allow-headers": "content-type" } });
    // the website: GET /d/<id>  → the locked file
    if (p[0] === "d" && p[1] && req.method === "GET"){ await setup(env); const r = await env.DB.prepare("SELECT body FROM files WHERE id = ?").bind(p[1]).first();
      return r ? new Response(r.body, { headers: { ...CORS, "content-type": "application/json" } }) : new Response("not found", { status: 404, headers: CORS }); }
    // the website: POST /log/<id>  {who, what}  ─ a salesperson's activity (only for a file id that exists)
    if (p[0] === "log" && p[1] && req.method === "POST"){ await setup(env); const f = await env.DB.prepare("SELECT id FROM files WHERE id = ?").bind(p[1]).first(); if (!f) return new Response("no", { status: 404, headers: CORS });
      let b = {}; try { b = await req.json(); } catch(e){} await env.DB.prepare("INSERT INTO log VALUES (?, ?, ?)").bind(Date.now(), String(b.who || p[1]).slice(0, 40), String(b.what || "").slice(0, 300)).run();
      return new Response("ok", { headers: { ...CORS, "access-control-allow-methods": "GET,POST" } }); }
    // the desk (claude.ai connector): /mcp/<KEY>
    if (p[0] === "mcp"){ if (!env.KEY || p[1] !== env.KEY) return new Response("no", { status: 403 });
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const m = await req.json(); if (m.id === undefined) return new Response(null, { status: 202 });
      if (m.method === "initialize") return ok(m.id, { protocolVersion: (m.params && m.params.protocolVersion) || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Lucky Taro Live", version: "1" } });
      if (m.method === "ping") return ok(m.id, {});
      if (m.method === "tools/list") return ok(m.id, { tools: TOOLS });
      if (m.method === "tools/call"){ await setup(env); const a = (m.params && m.params.arguments) || {}, n = m.params && m.params.name;
        if (n === "put_file"){ const id = String(a.id || "").replace(/[^A-Za-z0-9_-]/g, ""); if (!id) return ok(m.id, { isError: true, content: [{ type: "text", text: "bad id" }] });
          await env.DB.prepare("INSERT INTO files VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, at = excluded.at").bind(id, String(a.body || ""), Date.now()).run();
          return ok(m.id, { content: [{ type: "text", text: "saved " + id }] }); }
        if (n === "get_log"){ const r = await env.DB.prepare("SELECT at, who, what FROM log WHERE at > ? ORDER BY at DESC LIMIT 300").bind(Number(a.since) || 0).all();
          await env.DB.prepare("DELETE FROM log WHERE at < ?").bind(Date.now() - 30 * 864e5).run();
          return ok(m.id, { content: [{ type: "text", text: JSON.stringify(r.results || []) }] }); }
        return ok(m.id, { isError: true, content: [{ type: "text", text: "unknown tool" }] }); }
      return Response.json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown method" } }); }
    return new Response("Lucky Taro", { headers: CORS }); } };
