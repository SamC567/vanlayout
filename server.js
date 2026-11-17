// Zero-dependency server: serves index.html and GET /api/lookup?url=… which
// fetches a product page and tries to extract name + dimensions.
// Run: node server.js   (PORT env optional, default 3000)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const PORT = process.env.PORT || 3000;
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1'; // tests only
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') ||
    s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb');
}

async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links are supported');
  if (ALLOW_PRIVATE) return;
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('Refusing to fetch a private address');
}

async function fetchPage(url) {
  let u = new URL(url);
  for (let i = 0; i < 5; i++) {
    await assertPublic(u);
    const res = await fetch(u, {
      redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location'), u); continue; }
    if (!res.ok) throw new Error(`Site responded ${res.status} (many shops block automated requests — enter sizes manually)`);
    const reader = res.body.getReader(); const chunks = []; let n = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      chunks.push(value); n += value.length; if (n > 3e6) { reader.cancel(); break; }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('Too many redirects');
}

const UNIT = { mm: 1, millimetre: 1, millimeter: 1, millimetres: 1, millimeters: 1, cm: 10, centimetre: 10, centimeter: 10, centimetres: 10, centimeters: 10,
  m: 1000, in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4, '″': 25.4, '”': 25.4 };
const toMm = (v, unit) => Math.round(parseFloat(String(v).replace(',', '.')) * UNIT[unit.toLowerCase()]);

function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&times;/g, '×').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function textOf(html) {
  return decode(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
}
const plausible = d => d.every(x => x >= 10 && x <= 6000);

function extract(html) {
  const out = { name: '', candidates: [] };
  const meta = (p) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i')) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, 'i'));
    return m ? decode(m[1]).trim() : '';
  };
  out.name = meta('og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '';
  out.name = decode(out.name).slice(0, 80);

  // 1) JSON-LD Product with width/height/depth
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1]); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const o = stack.pop(); if (!o || typeof o !== 'object') continue;
      if (Array.isArray(o)) { stack.push(...o); continue; }
      if (o['@graph']) stack.push(...[].concat(o['@graph']));
      if (/Product/.test([].concat(o['@type'] || []).join(','))) {
        if (o.name && !out.name) out.name = String(o.name).slice(0, 80);
        const q = k => { const v = o[k]; if (!v) return null; const val = v.value ?? v; const unit = v.unitText || v.unitCode || 'cm';
          const u = ({ MMT: 'mm', CMT: 'cm', MTR: 'm', INH: 'in' })[unit] || String(unit).toLowerCase();
          return UNIT[u] ? toMm(val, u) : null; };
        const d = [q('depth'), q('width'), q('height')];
        if (d.every(Boolean) && plausible(d)) out.candidates.push({ l: d[0], w: d[1], h: d[2], score: 10, source: 'structured data (depth × width × height)' });
      }
      for (const k in o) if (o[k] && typeof o[k] === 'object') stack.push(o[k]);
    }
  }

  const text = textOf(html);

  // 2) "600 x 400 x 450 mm" patterns
  const num = '(\\d{1,4}(?:[.,]\\d{1,2})?)';
  const sep = '\\s*(?:x|×|X|by)\\s*';
  const unitRe = '(mm|millimet(?:re|er)s?|cm|centimet(?:re|er)s?|m|inch(?:es)?|in|"|″|”)';
  const re = new RegExp(`${num}\\s*${unitRe}?${sep}${num}\\s*${unitRe}?${sep}${num}\\s*${unitRe}?(?![a-z])`, 'gi');
  for (const m of text.matchAll(re)) {
    const unit = m[6] || m[4] || m[2];
    if (!unit) continue;
    const dims = [m[1], m[3], m[5]].map((v, i) => toMm(v, [m[2], m[4], m[6]][i] || unit));
    if (!plausible(dims)) continue;
    const ctx = text.slice(Math.max(0, m.index - 90), m.index).toLowerCase();
    let score = 1;
    if (/external|outer|exterior|overall|product (dimension|size)/.test(ctx)) score += 3;
    if (/dimension|size|measure/.test(ctx)) score += 1;
    if (/internal|inner|interior|inside|capacity/.test(ctx)) score -= 3;
    if (/package|packag|shipping|carton|gift/.test(ctx)) score -= 2;
    out.candidates.push({ l: dims[0], w: dims[1], h: dims[2], score, source: `“${m[0].trim()}”` });
  }

  // 3) labelled values: Length: 60 cm, Width 40 cm, Height 45 cm
  const lab = {};
  for (const [k, words] of [['l', 'length|depth'], ['w', 'width'], ['h', 'height']]) {
    const m = text.match(new RegExp(`(?:${words})\\s*[:\\-]?\\s*${num}\\s*${unitRe}(?![a-z])`, 'i'));
    if (m) lab[k] = toMm(m[1], m[2]);
  }
  if (lab.l && lab.w && lab.h && plausible([lab.l, lab.w, lab.h])) out.candidates.push({ ...lab, score: 2, source: 'labelled length/width/height' });

  // dedupe + rank
  const seen = new Set();
  out.candidates = out.candidates.filter(c => { const k = `${c.l}x${c.w}x${c.h}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.score - a.score).slice(0, 5);
  return out;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (u.pathname === '/api/lookup') {
    try {
      const target = new URL(u.searchParams.get('url') || '');
      const html = await fetchPage(target.href);
      return send(200, extract(html));
    } catch (e) { return send(400, { error: e.message || 'Lookup failed' }); }
  }
  if (u.pathname === '/' || u.pathname === '/index.html')
    return send(200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
  if (u.pathname === '/items.json' || u.pathname === '/plans.json')
    return send(200, fs.readFileSync(path.join(__dirname, u.pathname.slice(1))));
  send(404, { error: 'Not found' });
});

if (require.main === module) server.listen(PORT, () => console.log(`Van layout editor: http://localhost:${PORT}`));
module.exports = { extract, server };
