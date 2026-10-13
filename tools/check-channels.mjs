// Builds tv-channels.json: only channels that pass a real browser-style playback check.
// Run from the site folder:  node tools/check-channels.mjs [playlist.m3u]
// For each https channel it checks, the way a browser on the site would see it:
//   1. the playlist loads (HTTP 200, looks like HLS) and the server allows the site (CORS)
//   2. if it is a master playlist, the first quality level loads too
//   3. the first video chunk downloads (HTTP 200/206, CORS ok, real bytes)
import fs from 'node:fs';

const ORIGIN = 'https://gme-io.github.io';
const SRC = process.argv[2] || 'https://iptv-org.github.io/iptv/index.m3u';
const OUT = 'tv-channels.json';
const CONC = 60, STEP_MS = 8000;

function parse(text) {
  const out = [], lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXTINF:[^,"]*?((?:\s+[\w-]+="[^"]*")*)\s*,(.*)$/);
    if (!m) continue;
    let url = '';
    for (let j = i + 1; j < lines.length && j < i + 6; j++) { const l = lines[j].trim(); if (l && l[0] !== '#') { url = l; break; } }
    if (!/^https:\/\//i.test(url)) continue;
    const a = {}; m[1].replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => a[k] = v);
    const group = (a['group-title'] || 'Undefined').split(';')[0].trim() || 'Undefined';
    if (/^xxx$|adult/i.test(group)) continue;
    let cc = ((a['tvg-id'] || '').match(/\.([a-z]{2})(?:@|$)/i) || [])[1] || ''; cc = cc.toUpperCase(); if (cc === 'UK') cc = 'GB';
    out.push({ name: m[2].trim() || 'Channel', url, logo: /^https:/i.test(a['tvg-logo'] || '') ? a['tvg-logo'] : '', group, cc });
  }
  return out;
}

const corsOk = r => { const a = r.headers.get('access-control-allow-origin'); return a === '*' || a === ORIGIN; };
const req = (url, headers = {}) => fetch(url, { headers: { Origin: ORIGIN, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(STEP_MS) });
const pickUri = body => { const L = body.split(/\r?\n/); for (const l of L) { const t = l.trim(); if (t && t[0] !== '#') return t; } return ''; };
const pickVariant = body => { const L = body.split(/\r?\n/); for (let i = 0; i < L.length; i++) if (L[i].startsWith('#EXT-X-STREAM-INF')) for (let j = i + 1; j < L.length; j++) { const t = L[j].trim(); if (t && t[0] !== '#') return t; } return ''; };

async function check(c) {
  try {
    let r = await req(c.url);
    if (!r.ok || !corsOk(r)) return 'manifest';
    let body = (await r.text()).slice(0, 400000), base = r.url;
    if (!body.includes('#EXTM3U')) return 'notm3u8';
    if (body.includes('#EXT-X-STREAM-INF')) {                       // master -> first level
      const v = pickVariant(body); if (!v) return 'novariant';
      r = await req(new URL(v, base)); if (!r.ok || !corsOk(r)) return 'level';
      body = (await r.text()).slice(0, 400000); base = r.url;
      if (!body.includes('#EXTM3U')) return 'level';
    }
    const seg = pickUri(body); if (!seg) return 'noseg';
    r = await req(new URL(seg, base), { Range: 'bytes=0-4095' });
    if (!(r.status === 200 || r.status === 206) || !corsOk(r)) return 'segment';
    const rd = r.body.getReader(); const { value } = await rd.read(); rd.cancel().catch(() => {});
    return value && value.length >= 188 ? 'ok' : 'empty';
  } catch (e) { return 'error'; }
}

const text = /^https?:/.test(SRC) ? await (await fetch(SRC)).text() : fs.readFileSync(SRC, 'utf8');
const all = parse(text);
console.log('https channels to check:', all.length);
const stats = {}, good = []; let i = 0, done = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < all.length) {
    const c = all[i++]; const res = await check(c);
    stats[res] = (stats[res] || 0) + 1; if (res === 'ok') good.push(c);
    if (++done % 500 === 0) console.log(done + '/' + all.length, JSON.stringify(stats));
  }
}));
const order = new Map(all.map((c, k) => [c.url, k]));
good.sort((a, b) => order.get(a.url) - order.get(b.url));
fs.writeFileSync(OUT, JSON.stringify({ checked: new Date().toISOString().slice(0, 10), source: SRC, total: all.length, channels: good.map(c => [c.name, c.url, c.logo, c.group, c.cc]) }));
console.log('DONE', JSON.stringify(stats), 'kept', good.length, 'of', all.length, '->', OUT, (fs.statSync(OUT).size / 1e6).toFixed(2) + ' MB');
