// check-store.js - runs on GitHub Actions once a day.
// Logs in with your Riot login cookie, reads your VALORANT store, builds a webpage
// in ./site, and sends a phone notification (ntfy) when an Ultra/Exclusive skin appears.
//
// Environment (set by the workflow from your GitHub secrets):
//   RIOT_SSID   your Riot "ssid" login cookie        (secret)
//   NTFY_TOPIC  your private ntfy topic name         (secret)
//   SHARD       region: ap / na / eu / kr            (default ap)
//   PAGE_URL    link opened when you tap a notification
//
// Read-only: it only views the store, it never buys anything.
// The webpage shows skins only - no account name or details.

const fs = require('fs');
const path = require('path');

const SSID = (process.env.RIOT_SSID || '').trim();
const NTFY_TOPIC = (process.env.NTFY_TOPIC || '').trim();
const SHARD = (process.env.SHARD || 'ap').trim();
const PAGE_URL = (process.env.PAGE_URL || '').trim();
const OUT_DIR = path.join(__dirname, 'site');
const SAMPLE = process.argv.includes('--sample'); // local preview with fake data, no login

const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const USER_AGENT = 'RiotClient/63.0.9.4909983.4789131 rso-auth (Windows;10;;Professional, x64)';
const CLIENT_PLATFORM = Buffer.from(JSON.stringify({
  platformType: 'PC',
  platformOS: 'Windows',
  platformOSVersion: '10.0.19042.1.256.64bit',
  platformChipset: 'Unknown',
})).toString('base64');

const TOP = new Set(['Ultra', 'Exclusive']);
const TIER_COLOUR = {
  Ultra: '#f5c84c', Exclusive: '#f5955b', Premium: '#d1548d',
  Deluxe: '#2fb59a', Select: '#5a9fe2',
};

class LoginError extends Error {}

// ---------- helpers ----------

async function getJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${url.split('?')[0]} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function notify(title, message, { priority = 'default', tags = '' } = {}) {
  if (!NTFY_TOPIC) { console.log('(no NTFY_TOPIC set, skipping notification)'); return; }
  const headers = { Title: title, Priority: priority };
  if (tags) headers.Tags = tags;
  if (PAGE_URL) headers.Click = PAGE_URL;
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: 'POST', headers, body: message,
  });
  console.log(`Notification sent (HTTP ${res.status}): ${title}`);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtDuration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

// ---------- Riot login (cookie) ----------

async function login() {
  if (!SSID) throw new LoginError('The RIOT_SSID secret is missing.');

  const authorizeUrl = 'https://auth.riotgames.com/authorize'
    + '?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in'
    + '&client_id=play-valorant-web-prod'
    + '&response_type=token%20id_token&nonce=1&scope=account%20openid';

  const res = await fetch(authorizeUrl, {
    redirect: 'manual',
    headers: { Cookie: `ssid=${SSID}`, 'User-Agent': USER_AGENT },
  });
  const location = res.headers.get('location') || '';
  const match = location.match(/access_token=([^&]+)/);
  if (!match) {
    const hint = res.status === 403
      ? 'Riot blocked the request from this server.'
      : 'Your login cookie has probably expired.';
    throw new LoginError(`Login failed (HTTP ${res.status}). ${hint}`);
  }
  const accessToken = decodeURIComponent(match[1]);

  const ent = await getJson('https://entitlements.auth.riotgames.com/api/token/v1', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const puuid = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).sub;
  return { accessToken, entitlementsToken: ent.entitlements_token, puuid };
}

// ---------- store ----------

async function loadSkinData() {
  const [version, weapons, tiers] = await Promise.all([
    getJson('https://valorant-api.com/v1/version'),
    getJson('https://valorant-api.com/v1/weapons'),
    getJson('https://valorant-api.com/v1/contenttiers'),
  ]);
  const tierName = Object.fromEntries(tiers.data.map(t => [t.uuid, t.devName]));
  const byLevel = {};
  for (const w of weapons.data) {
    for (const s of w.skins || []) {
      const tier = tierName[s.contentTierUuid] || 'Other';
      for (const lvl of s.levels || []) {
        byLevel[lvl.uuid] = {
          name: s.displayName,
          weapon: w.displayName,
          tier,
          icon: lvl.displayIcon || s.displayIcon || (s.chromas && s.chromas[0] && s.chromas[0].fullRender) || '',
        };
      }
    }
  }
  return { clientVersion: version.data.riotClientVersion, byLevel };
}

async function fetchStore(auth, clientVersion) {
  return getJson(`https://pd.${SHARD}.a.pvp.net/store/v3/storefront/${auth.puuid}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'X-Riot-Entitlements-JWT': auth.entitlementsToken,
      'X-Riot-ClientVersion': clientVersion,
      'X-Riot-ClientPlatform': CLIENT_PLATFORM,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
}

function parseStore(store, byLevel) {
  const lookup = id => byLevel[id] || { name: 'Unknown item', weapon: '', tier: 'Other', icon: '' };
  const panel = store.SkinsPanelLayout || {};
  const daily = (panel.SingleItemStoreOffers || []).map(o => ({
    ...lookup(o.OfferID), price: o.Cost[VP],
  }));
  const bonus = store.BonusStore;
  const night = bonus && bonus.BonusStoreOffers ? bonus.BonusStoreOffers.map(b => ({
    ...lookup(b.Offer.OfferID),
    price: b.DiscountCosts[VP],
    was: b.Offer.Cost[VP],
    discount: b.DiscountPercent,
  })) : [];
  return {
    daily,
    dailyLeft: panel.SingleItemOffersRemainingDurationInSeconds || 0,
    night,
    nightLeft: bonus ? bonus.BonusStoreRemainingDurationInSeconds : 0,
  };
}

// ---------- webpage ----------

function card(skin) {
  const colour = TIER_COLOUR[skin.tier] || '#8a8f98';
  const top = TOP.has(skin.tier);
  const price = skin.was
    ? `<span class="price">${skin.price} VP</span> <s>${skin.was}</s> <span class="off">-${skin.discount}%</span>`
    : `<span class="price">${skin.price} VP</span>`;
  return `
    <article class="card${top ? ' top' : ''}" style="--tier:${colour}">
      <div class="art">${skin.icon ? `<img src="${esc(skin.icon)}" alt="" loading="lazy">` : ''}</div>
      <div class="meta">
        <div class="tier">${top ? '★ ' : ''}${esc(skin.tier)}${skin.weapon === 'Melee' ? ' · Melee' : ''}</div>
        <h3>${esc(skin.name)}</h3>
        <div>${price}</div>
      </div>
    </article>`;
}

function page({ body, status }) {
  const updated = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short',
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Store Today</title>
<style>
  :root { --bg:#0f1419; --panel:#1a2129; --text:#ece8e1; --muted:#8b949e; --line:#2a333d; --accent:#ff4655; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 28px 16px 48px; }
  header h1 { margin:0; font-size: 28px; letter-spacing: .04em; text-transform: uppercase; }
  header h1 span { color: var(--accent); }
  .status { margin: 14px 0 26px; padding: 12px 14px; border-radius: 10px; background: var(--panel);
            border-left: 4px solid var(--muted); }
  .status.hit { border-left-color: #f5955b; }
  .status.err { border-left-color: var(--accent); }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted);
       margin: 28px 0 10px; display:flex; justify-content:space-between; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  .card { display:flex; gap:14px; align-items:center; background: var(--panel); border:1px solid var(--line);
          border-left: 4px solid var(--tier); border-radius: 10px; padding: 12px; }
  .card.top { box-shadow: 0 0 0 1px var(--tier), 0 6px 24px -10px var(--tier); }
  .art { width: 120px; height: 60px; flex: none; display:flex; align-items:center; justify-content:center; }
  .art img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .tier { font-size: 12px; font-weight: 600; color: var(--tier); text-transform: uppercase; letter-spacing: .08em; }
  h3 { margin: 2px 0 4px; font-size: 16px; }
  .price { font-weight: 600; }
  s { color: var(--muted); }
  .off { color: #2fb59a; font-weight: 600; }
  footer { margin-top: 36px; color: var(--muted); font-size: 13px; }
  @media (max-width: 400px) { .grid { grid-template-columns: 1fr; } .art { width: 90px; } }
</style>
</head>
<body>
<main>
  <header><h1>Store <span>Today</span></h1></header>
  ${status}
  ${body}
  <footer>Updated ${esc(updated)} (Riyadh time). Store resets daily at 3:00 AM.</footer>
</main>
</body>
</html>`;
}

function writeSite(html) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
  console.log(`Wrote ${path.join(OUT_DIR, 'index.html')}`);
}

function sampleStore() {
  const s = (name, weapon, tier, price, extra = {}) => ({ name, weapon, tier, price, icon: '', ...extra });
  return {
    daily: [
      s('Kuronami no Yaiba', 'Melee', 'Exclusive', 5350),
      s('XERØFANG Ghost', 'Ghost', 'Premium', 1775),
      s('RGX 11z Pro Operator', 'Operator', 'Exclusive', 2175),
      s('Imperium Vandal', 'Vandal', 'Exclusive', 2175),
    ],
    dailyLeft: 14400,
    night: [s('Smite Vandal', 'Vandal', 'Select', 525, { was: 875, discount: 40 })],
    nightLeft: 86400 * 5,
  };
}

// ---------- main ----------

async function main() {
  let store;
  if (SAMPLE) {
    store = sampleStore();
  } else {
    const auth = await login();
    const { clientVersion, byLevel } = await loadSkinData();
    store = parseStore(await fetchStore(auth, clientVersion), byLevel);
  }

  const topDaily = store.daily.filter(s => TOP.has(s.tier));
  const topNight = store.night.filter(s => TOP.has(s.tier));
  const tops = [...topDaily, ...topNight];

  for (const s of store.daily) console.log(`  ${TOP.has(s.tier) ? '*' : ' '} ${s.name} (${s.tier}) ${s.price} VP`);

  const status = tops.length
    ? `<div class="status hit"><strong>★ ${tops.length} top-tier skin${tops.length > 1 ? 's' : ''} today.</strong> Time to cop?</div>`
    : `<div class="status">Nothing Ultra or Exclusive today. Keep waiting.</div>`;

  let body = `<h2><span>Daily store</span><span>refreshes in ${fmtDuration(store.dailyLeft)}</span></h2>
  <div class="grid">${store.daily.map(card).join('')}</div>`;
  if (store.night.length) {
    body += `<h2><span>Night Market</span><span>ends in ${fmtDuration(store.nightLeft)}</span></h2>
  <div class="grid">${store.night.map(card).join('')}</div>`;
  }
  writeSite(page({ body, status }));

  if (tops.length && !SAMPLE) {
    const lines = tops.map(s => `${s.name} - ${s.tier} - ${s.price} VP`).join('\n');
    await notify('Top-tier skin in your VALORANT store', lines, { priority: 'high', tags: 'star' });
  }
}

main().catch(async err => {
  console.error(err);
  const isLogin = err instanceof LoginError;
  const msg = isLogin
    ? `${err.message} Paste a fresh ssid cookie into the RIOT_SSID secret.`
    : `Store check failed: ${err.message}`;
  writeSite(page({
    body: '',
    status: `<div class="status err"><strong>Couldn't check the store today.</strong><br>${esc(isLogin ? err.message : 'Something went wrong. Check the GitHub Actions log.')}</div>`,
  }));
  if (!SAMPLE) {
    try { await notify('VALORANT store check failed', msg, { priority: 'high', tags: 'warning' }); } catch { /* ignore */ }
  }
  // Exit 0 so the error page still gets published.
});
