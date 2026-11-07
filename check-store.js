// check-store.js - runs on GitHub Actions every 2 hours.
// Logs in with your Riot login cookie, reads your VALORANT store, ranks every
// Exclusive/Ultra skin (rankings.js), builds a webpage in ./site, and pings your
// phone (ntfy) according to the reminder rules in rankings.js.
//
// Environment (set by the workflow from your GitHub secrets):
//   RIOT_SSID   your Riot login cookie(s)            (secret)
//   NTFY_TOPIC  your private ntfy topic name         (secret)
//   SHARD       region: ap / na / eu / kr            (default ap)
//   PAGE_URL    link opened when you tap a notification
//
// Read-only: it only views the store, it never buys anything.
// The webpage shows skins only - no account name or details.

const fs = require('fs');
const path = require('path');
const R = require('./rankings');

const SSID = (process.env.RIOT_SSID || '').trim();
const NTFY_TOPIC = (process.env.NTFY_TOPIC || '').trim();
const SHARD = (process.env.SHARD || 'ap').trim();
const PAGE_URL = (process.env.PAGE_URL || '').trim();
const OUT_DIR = path.join(__dirname, 'site');
const STATE_FILE = path.join(__dirname, 'state', 'state.json');

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
const PRIORITY = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };

class LoginError extends Error {}

// ---------- helpers ----------

async function getJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${url.split('?')[0]} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

let sendNotification = async ({ title, message, priority = 'default', tags = [] }) => {
  if (!NTFY_TOPIC) { console.log(`(no NTFY_TOPIC) ${title}: ${message}`); return; }
  // JSON publishing so skin names with special characters (like Ø) work everywhere.
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: NTFY_TOPIC, title, message, tags,
      priority: PRIORITY[priority] || 3,
      ...(PAGE_URL ? { click: PAGE_URL } : {}),
    }),
  });
  console.log(`Notification sent (HTTP ${res.status}): ${title}`);
};
const notify = (...args) => sendNotification(...args);

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

  // RIOT_SSID can be just the ssid value, or the whole Cookie header ("a=1; ssid=...; b=2").
  const cookie = SSID.includes('=') ? SSID.replace(/^cookie:\s*/i, '') : `ssid=${SSID}`;
  if (!/(^|;\s*)ssid=/.test(cookie)) throw new LoginError('The RIOT_SSID secret has no ssid cookie in it.');

  const res = await fetch(authorizeUrl, {
    redirect: 'manual',
    headers: { Cookie: cookie, 'User-Agent': USER_AGENT },
  });
  const location = res.headers.get('location') || '';
  const match = location.match(/access_token=([^&]+)/);
  if (!match) {
    let where = '';
    try { const u = new URL(location); where = ` Riot redirected to ${u.host}${u.pathname}.`; } catch { /* no location */ }
    const hint = res.status === 403
      ? 'Riot blocked the request from this server.'
      : 'Riot did not accept the login cookie (wrong value or expired).';
    throw new LoginError(`Login failed (HTTP ${res.status}). ${hint}${where}`);
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

// ---------- game data (official skin list + tiers) ----------

async function fetchGameData() {
  const [version, weapons, tiers, themes] = await Promise.all([
    getJson('https://valorant-api.com/v1/version'),
    getJson('https://valorant-api.com/v1/weapons'),
    getJson('https://valorant-api.com/v1/contenttiers'),
    getJson('https://valorant-api.com/v1/themes'),
  ]);
  return { clientVersion: version.data.riotClientVersion, weapons: weapons.data, tiers: tiers.data, themes: themes.data };
}

// Turns raw game data into: a level-id -> skin lookup, and the ranking of all Exclusive/Ultra skins.
function buildCatalog({ weapons, tiers, themes }) {
  const tierName = Object.fromEntries(tiers.map(t => [t.uuid, t.devName]));
  const themeName = Object.fromEntries(themes.map(t => [t.uuid, t.displayName]));
  const byLevel = {};
  const topSkins = [];
  for (const w of weapons) {
    for (const s of w.skins || []) {
      const skin = {
        id: s.uuid,
        name: s.displayName,
        weapon: w.displayName,
        tier: tierName[s.contentTierUuid] || 'Other',
        theme: themeName[s.themeUuid] || '',
        icon: (s.levels && s.levels[0] && s.levels[0].displayIcon) || s.displayIcon
          || (s.chromas && s.chromas[0] && s.chromas[0].fullRender) || '',
      };
      for (const lvl of s.levels || []) byLevel[lvl.uuid] = skin;
      if (TOP.has(skin.tier)) topSkins.push(skin);
    }
  }
  const ranking = R.rankSkins(topSkins);
  return { byLevel, ranking };
}

async function fetchStorefront(auth, clientVersion) {
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

function parseStore(storefront, catalog) {
  const { byLevel, ranking } = catalog;
  const item = (offerId, extra) => {
    const skin = byLevel[offerId] || { id: offerId, name: 'Unknown item', weapon: '', tier: 'Other', icon: '' };
    const r = ranking.byId[skin.id];
    return {
      ...skin, ...extra, offerId,
      rank: r ? r.rank : null,
      list: r ? r.list : null,
      favourite: r ? r.favourite : false,
      rated: r ? r.rated : false,
    };
  };
  const panel = storefront.SkinsPanelLayout || {};
  const daily = (panel.SingleItemStoreOffers || []).map(o => item(o.OfferID, { price: o.Cost[VP] }));
  const bonus = storefront.BonusStore;
  const night = bonus && bonus.BonusStoreOffers ? bonus.BonusStoreOffers.map(b => item(b.Offer.OfferID, {
    price: b.DiscountCosts[VP], was: b.Offer.Cost[VP], discount: b.DiscountPercent,
  })) : [];
  return {
    daily,
    dailyLeft: panel.SingleItemOffersRemainingDurationInSeconds || 0,
    night,
    nightLeft: bonus ? bonus.BonusStoreRemainingDurationInSeconds : 0,
  };
}

// ---------- reminder logic ----------

const isTopRank = s => s.rank !== null && s.rank <= R.TOP_RANK;
const listName = s => (s.list === 'knife' ? 'knife' : 'gun');

function line(s, { discount = false } = {}) {
  const rank = s.rank ? `#${s.rank} ${listName(s)}` : s.tier;
  const fav = s.favourite ? '❤️ ' : '';
  const price = discount && s.was ? `${s.price} VP (-${s.discount}%)` : `${s.price} VP`;
  return `${fav}${rank} · ${s.name} · ${s.tier} · ${price}`;
}

// Which reminder stages are due, given how long is left in the store.
function dueStages(secondsLeft) {
  const h = secondsLeft / 3600;
  const due = ['first'];
  if (h < R.MID_REMINDER_H) due.push('mid');
  if (h < R.LAST_CALL_H) due.push('last');
  return due;
}

// Who gets reminded at each stage:
//   first: every Exclusive/Ultra skin (once is fine)
//   mid:   top-50 ranks and favourites (twice a day)
//   last:  favourites only (extra last-chance ping)
const QUALIFIES = {
  first: s => s.rank !== null,
  mid: s => s.favourite || isTopRank(s),
  last: s => s.favourite,
};

async function handleDaily(store, state) {
  const sig = store.daily.map(s => s.offerId).sort().join(',');
  const prev = state.daily && state.daily.sig === sig ? state.daily : { sig, sent: [] };
  const due = dueStages(store.dailyLeft);
  const unsent = due.filter(st => !prev.sent.includes(st));

  if (unsent.length) {
    const items = store.daily.filter(s => unsent.some(st => QUALIFIES[st](s)));
    if (items.length) {
      const stage = unsent[unsent.length - 1];
      const hasFav = items.some(s => s.favourite);
      const left = fmtDuration(store.dailyLeft);
      const title = stage === 'last'
        ? `LAST CHANCE: favourite skin leaves in ${left}`
        : stage === 'mid'
          ? `Reminder: still in your store (${left} left)`
          : hasFav ? 'FAVOURITE skin in your store!' : 'Top-tier skin in your store';
      const priority = hasFav ? 'urgent' : items.some(isTopRank) ? 'high' : 'default';
      await notify({
        title,
        message: items.map(s => line(s)).join('\n'),
        priority,
        tags: [hasFav ? 'heart' : 'star'],
      });
    }
  }
  return { sig, sent: [...new Set([...prev.sent, ...due])] };
}

async function handleNight(store, state) {
  const sig = store.night.map(s => s.offerId).sort().join(',');
  const out = { sig: store.night.length ? sig : '', endingSig: state.night ? state.night.endingSig || '' : '' };
  if (!store.night.length) return out;

  if (!state.night || state.night.sig !== sig) {
    const hasFav = store.night.some(s => s.favourite);
    await notify({
      title: hasFav ? 'Night Market is LIVE - with a FAVOURITE!' : 'Night Market is LIVE',
      message: `${store.night.map(s => line(s, { discount: true })).join('\n')}\n\nEnds in ${fmtDuration(store.nightLeft)}`,
      priority: hasFav ? 'urgent' : 'high',
      tags: ['crescent_moon'],
    });
  }
  if (store.nightLeft < 86400 && out.endingSig !== sig) {
    const favs = store.night.filter(s => s.favourite);
    await notify({
      title: 'Night Market ends soon',
      message: `Ends in ${fmtDuration(store.nightLeft)}. Last chance to buy.`
        + (favs.length ? `\n\n${favs.map(s => line(s, { discount: true })).join('\n')}` : ''),
      priority: favs.length ? 'urgent' : 'default',
      tags: ['hourglass'],
    });
    out.endingSig = sig;
  }
  return out;
}

// ---------- webpages ----------

const STYLE = `
  :root { --bg:#0f1419; --panel:#1a2129; --text:#ece8e1; --muted:#8b949e; --line:#2a333d; --accent:#ff4655; --fav:#ff5c8a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 28px 16px 48px; }
  header { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
  header h1 { margin:0; font-size: 28px; letter-spacing: .04em; text-transform: uppercase; }
  header h1 span { color: var(--accent); }
  nav a { color: var(--muted); text-decoration:none; margin-left: 14px; font-size: 14px; }
  nav a.on { color: var(--text); font-weight: 600; }
  .status { margin: 14px 0 26px; padding: 12px 14px; border-radius: 10px; background: var(--panel);
            border-left: 4px solid var(--muted); }
  .status.hit { border-left-color: #f5955b; }
  .status.fav { border-left-color: var(--fav); }
  .status.err { border-left-color: var(--accent); }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted);
       margin: 28px 0 10px; display:flex; justify-content:space-between; gap: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
  .card { display:flex; gap:14px; align-items:center; background: var(--panel); border:1px solid var(--line);
          border-left: 4px solid var(--tier); border-radius: 10px; padding: 12px; }
  .card.top { box-shadow: 0 0 0 1px var(--tier), 0 6px 24px -10px var(--tier); }
  .card.fav { box-shadow: 0 0 0 2px var(--fav), 0 6px 28px -8px var(--fav); }
  .art { width: 120px; height: 60px; flex: none; display:flex; align-items:center; justify-content:center; }
  .art img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .tier { font-size: 12px; font-weight: 600; color: var(--tier); text-transform: uppercase; letter-spacing: .08em; }
  .rank { display:inline-block; margin-top: 4px; font-size: 12px; color: var(--muted); }
  .rank b { color: var(--text); }
  .heart { color: var(--fav); }
  h3 { margin: 2px 0 4px; font-size: 16px; }
  .price { font-weight: 600; }
  s { color: var(--muted); }
  .off { color: #2fb59a; font-weight: 600; }
  table { width:100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align:left; padding: 7px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing:.08em; }
  td.n { color: var(--muted); width: 3.5em; font-variant-numeric: tabular-nums; }
  td.t { font-size: 12px; font-weight: 600; text-transform: uppercase; }
  tr.top50 td.n { color: var(--text); }
  tr.fav td { background: color-mix(in srgb, var(--fav) 10%, transparent); }
  .cut td { border-bottom: 2px dashed var(--accent); }
  .muted { color: var(--muted); font-size: 13px; }
  footer { margin-top: 36px; color: var(--muted); font-size: 13px; }
  @media (max-width: 420px) { .grid { grid-template-columns: 1fr; } .art { width: 90px; } td.c { display:none; } }
`;

function shell({ title, active, body }) {
  const updated = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>Store <span>Watch</span></h1>
    <nav><a href="./" class="${active === 'store' ? 'on' : ''}">Today</a><a href="rankings.html" class="${active === 'rank' ? 'on' : ''}">Rankings</a></nav>
  </header>
  ${body}
  <footer>Updated ${esc(updated)} (Qatar/Riyadh time). Store resets daily at 3:00 AM. Checked every 2 hours.</footer>
</main>
</body>
</html>`;
}

function card(s) {
  const colour = TIER_COLOUR[s.tier] || '#8a8f98';
  const top = TOP.has(s.tier);
  const price = s.was
    ? `<span class="price">${s.price} VP</span> <s>${s.was}</s> <span class="off">-${s.discount}%</span>`
    : `<span class="price">${s.price} VP</span>`;
  const rank = s.rank
    ? `<div class="rank">Rank <b>#${s.rank}</b> ${listName(s)}${s.rated ? '' : ' (no vote data)'}</div>`
    : '';
  return `
    <article class="card${top ? ' top' : ''}${s.favourite ? ' fav' : ''}" style="--tier:${colour}">
      <div class="art">${s.icon ? `<img src="${esc(s.icon)}" alt="" loading="lazy">` : ''}</div>
      <div class="meta">
        <div class="tier">${s.favourite ? '<span class="heart">❤ </span>' : top ? '★ ' : ''}${esc(s.tier)}${s.weapon === 'Melee' ? ' · Melee' : ''}</div>
        <h3>${esc(s.name)}</h3>
        <div>${price}</div>
        ${rank}
      </div>
    </article>`;
}

function storePage(store) {
  const favs = [...store.daily, ...store.night].filter(s => s.favourite);
  const tops = [...store.daily, ...store.night].filter(s => s.rank !== null);
  const status = favs.length
    ? `<div class="status fav"><strong>❤ Favourite in your store: ${esc(favs.map(s => s.name).join(', '))}</strong></div>`
    : tops.length
      ? `<div class="status hit"><strong>★ ${tops.length} top-tier skin${tops.length > 1 ? 's' : ''} today.</strong> Best: #${Math.min(...tops.map(s => s.rank))}.</div>`
      : `<div class="status">Nothing Ultra or Exclusive today. Keep waiting.</div>`;
  let body = `${status}
  <h2><span>Daily store</span><span>refreshes in ${fmtDuration(store.dailyLeft)}</span></h2>
  <div class="grid">${store.daily.map(card).join('')}</div>`;
  if (store.night.length) {
    body += `<h2><span>Night Market</span><span>ends in ${fmtDuration(store.nightLeft)}</span></h2>
  <div class="grid">${store.night.map(card).join('')}</div>`;
  }
  return shell({ title: 'Store Today', active: 'store', body });
}

function rankTable(list, label) {
  const rows = list.map(s => `
      <tr class="${s.rank <= R.TOP_RANK ? 'top50' : ''}${s.favourite ? ' fav' : ''}${s.rank === R.TOP_RANK ? ' cut' : ''}">
        <td class="n">${s.rank}</td>
        <td>${s.favourite ? '<span class="heart">❤ </span>' : ''}${esc(s.name)}${s.rated ? '' : ' <span class="muted">(no vote data)</span>'}</td>
        <td class="t" style="color:${TIER_COLOUR[s.tier]}">${esc(s.tier)}</td>
        <td class="c muted">${esc(s.collection)}</td>
      </tr>`).join('');
  return `<h2><span>${label}</span><span>${list.length} skins</span></h2>
  <table><thead><tr><th>#</th><th>Skin</th><th>Tier</th><th class="c">Collection</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function rankingsPage(ranking) {
  const body = `
  <p class="muted">Every Exclusive and Ultra skin in the game, from live game data. Guns are ranked together; knives separately.
  Ranks 1–${R.TOP_RANK} (above the red line) get reminded twice a day. ❤ = your favourites (urgent alerts + last-chance ping).
  "No vote data" = not in any vote dataset yet; sits mid-table until it is.</p>
  ${rankTable(ranking.guns, 'Guns')}
  ${rankTable(ranking.knives, 'Knives')}`;
  return shell({ title: 'Skin Rankings', active: 'rank', body });
}

function errorPage(message) {
  return shell({
    title: 'Store Today', active: 'store',
    body: `<div class="status err"><strong>Couldn't check the store right now.</strong><br>${esc(message)}</div>`,
  });
}

function writeFile(name, html) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), html);
  console.log(`Wrote site/${name}`);
}

// ---------- state ----------

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- main ----------

// Everything after the network calls - separated so it can be tested offline.
async function process_(gameData, storefront) {
  const catalog = buildCatalog(gameData);
  const store = parseStore(storefront, catalog);

  for (const s of store.daily) {
    console.log(`  ${s.favourite ? '♥' : s.rank ? '*' : ' '} ${s.name} (${s.tier}${s.rank ? `, #${s.rank} ${listName(s)}` : ''}) ${s.price} VP`);
  }

  writeFile('index.html', storePage(store));
  writeFile('rankings.html', rankingsPage(catalog.ranking));

  const state = loadState();
  const daily = await handleDaily(store, state);
  const night = await handleNight(store, state);
  saveState({ daily, night, errorNotified: false });
  return { store, catalog };
}

async function main() {
  const auth = await login();
  const gameData = await fetchGameData();
  const storefront = await fetchStorefront(auth, gameData.clientVersion);
  await process_(gameData, storefront);
}

async function onError(err) {
  console.error(err);
  const isLogin = err instanceof LoginError;
  writeFile('index.html', errorPage(isLogin ? err.message : 'Something went wrong. Check the GitHub Actions log.'));
  // Only ping once per outage, not every 2 hours
  const state = loadState();
  if (!state.errorNotified) {
    const msg = isLogin
      ? `${err.message} Paste a fresh cookie line into the RIOT_SSID secret.`
      : `Store check failed: ${err.message}`;
    try { await notify({ title: 'VALORANT store check failed', message: msg, priority: 'high', tags: ['warning'] }); } catch { /* ignore */ }
    saveState({ ...state, errorNotified: true });
  }
  // Exit 0 so the error page still gets published.
}

if (require.main === module) {
  main().catch(onError);
}

module.exports = {
  process_, buildCatalog, parseStore, dueStages,
  setNotifier: fn => { sendNotification = fn; },
  STATE_FILE,
};
