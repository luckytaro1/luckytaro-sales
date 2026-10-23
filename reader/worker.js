// Lucky Taro ─ order picture reader (Cloudflare Worker)
// Holds the Anthropic key (secret ANTHROPIC_API_KEY). Only a signed-in salesperson can use it:
// the website sends the login's pass, and it must match the login's file on sales.luckytaro.com
// (a removed login has no file, a changed password has a new pass).
const SITE = "https://sales.luckytaro.com", MODEL_DEFAULT = "claude-sonnet-5-5", MAX_IMAGES = 4, MAX_B64 = 2_500_000;
const cors = o => ({ "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" });
const json = (o, status, origin) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...cors(origin) } });
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const sha = async s => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "", ok = origin === SITE || origin === "https://luckytaro1.github.io";
    if (req.method === "OPTIONS") return new Response(null, { status: ok ? 204 : 403, headers: ok ? cors(origin) : {} });
    if (req.method !== "POST" || !ok) return json({ error: "not allowed" }, 403, ok ? origin : SITE);
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad request" }, 400, origin); }
    const code = String(b.u || "").trim().toUpperCase(), pass = String(b.t || ""), prompt = String(b.prompt || ""), imgs = Array.isArray(b.images) ? b.images.slice(0, MAX_IMAGES) : [];
    if (!/^[A-Z0-9_-]{1,40}$/.test(code) || pass.length < 20 || !prompt || prompt.length > 120000 || !imgs.length) return json({ error: "bad request" }, 400, origin);
    if (imgs.some(x => typeof x !== "string" || x.length > MAX_B64)) return json({ error: "picture too big" }, 413, origin);
    // is this a current login, with this pass?
    const fid = (await sha("lt-sales|" + code)).slice(0, 20);
    const f = await fetch(`${SITE}/data/${fid}.json?t=${Date.now()}`, { cf: { cacheTtl: 0 } });
    if (!f.ok) return json({ error: "signin" }, 401, origin);
    let E; try { E = await f.json(); } catch (e) { return json({ error: "signin" }, 401, origin); }
    if (!E.rt || E.rt !== await sha(pass)) return json({ error: "signin" }, 401, origin);
    // read the picture with Claude
    const content = [...imgs.map(d => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: d } })), { type: "text", text: prompt }];
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.MODEL || MODEL_DEFAULT, max_tokens: 4000, messages: [{ role: "user", content }] }) });
    if (r.status === 429) return json({ error: "rate_limited" }, 429, origin);
    if (!r.ok) return json({ error: "reader failed", status: r.status }, 502, origin);
    const out = await r.json(), text = (out.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const m = text.match(/\{[\s\S]*\}/); let res = null; try { res = m ? JSON.parse(m[0]) : null; } catch (e) {}
    if (!res) return json({ error: "no order found" }, 422, origin);
    return json(res, 200, origin);
  }
};
