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

// Variant name from Riot's chroma name, e.g. "Kuronami Vandal Level 4\n(Variant 1 Black)" -> "Black".
function variantName(chroma, index) {
  if (index === 0) return 'Base';
  const m = String(chroma.displayName || '').match(/\(([^)]+)\)/);
  const raw = m ? m[1] : '';
  const cleaned = raw.replace(/^variant\s*\d+\s*/i, '').trim();
  return cleaned || raw || `Variant ${index}`;
}

// Every colour variant of a skin, each with its MAX-LEVEL demo video where one exists.
// Base variant: the highest level's demo video (shows all upgrades: VFX, animation, finisher).
// Other variants: Riot's video for that variant, which shows the fully upgraded weapon in that colour.
function skinVariants(s) {
  const levels = s.levels || [];
  const maxLevelVideo = [...levels].reverse().map(l => l.streamedVideo).find(Boolean) || null;
  const maxLevelIcon = [...levels].reverse().map(l => l.displayIcon).find(Boolean) || null;
  const chromas = s.chromas && s.chromas.length ? s.chromas : [{}];
  return chromas.map((c, i) => ({
    name: variantName(c, i),
    swatch: c.swatch || null,
    image: c.fullRender || c.displayIcon || (i === 0 ? maxLevelIcon || s.displayIcon : null) || null,
    video: i === 0 ? (maxLevelVideo || c.streamedVideo || null) : (c.streamedVideo || null),
  }));
}

// Turns raw game data into: a level-id -> skin lookup, and the ranking of all Exclusive/Ultra skins.
function buildCatalog({ weapons, tiers, themes }) {
  const tierName = Object.fromEntries(tiers.map(t => [t.uuid, t.devName]));
  const tierIcon = Object.fromEntries(tiers.map(t => [t.uuid, t.displayIcon || '']));
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
        tierIcon: tierIcon[s.contentTierUuid] || '',
        theme: themeName[s.themeUuid] || '',
        icon: (s.levels && s.levels[0] && s.levels[0].displayIcon) || s.displayIcon
          || (s.chromas && s.chromas[0] && s.chromas[0].fullRender) || '',
        variants: skinVariants(s),
      };
      skin.owned = R.isOwned(skin);
      for (const lvl of s.levels || []) byLevel[lvl.uuid] = skin;
      if (TOP.has(skin.tier)) topSkins.push(skin);
    }
  }
  const ranking = R.rankSkins(topSkins);
  // Your best skin on each weapon (ranked if it's Exclusive/Ultra, otherwise unranked).
  const ownedByWeapon = {};
  for (const sk of Object.values(byLevel)) {
    if (!sk.owned) continue;
    const r = ranking.byId[sk.id];
    const cur = ownedByWeapon[sk.weapon];
    const rank = r ? r.rank : null;
    if (!cur || (rank !== null && (cur.rank === null || rank < cur.rank))) ownedByWeapon[sk.weapon] = { name: sk.name, rank };
  }
  // White weapon silhouettes for the rankings weapon tabs.
  const weaponIcons = Object.fromEntries(weapons.map(w => [w.displayName, w.killStreamIcon || w.displayIcon || '']));
  return { byLevel, ranking, weaponIcons, ownedByWeapon };
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
  const { byLevel, ranking, ownedByWeapon = {} } = catalog;
  const item = (offerId, extra) => {
    const skin = byLevel[offerId] || { id: offerId, name: 'Unknown item', weapon: '', tier: 'Other', icon: '' };
    const r = ranking.byId[skin.id];
    return {
      ...skin, ...extra, offerId,
      rank: r ? r.rank : null,
      list: r ? r.list : null,
      favourite: r ? r.favourite : false,
      rated: r ? r.rated : false,
      yourTier: r ? r.yourTier : null,
      gap: R.fillsGap(skin.weapon, skin.tier) && !ownedByWeapon[skin.weapon],
      upgradeOver: (() => {
        const own = ownedByWeapon[skin.weapon];
        if (!r || !own || skin.owned) return null;
        return own.rank === null || r.rank < own.rank ? own.name : null;
      })(),
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
  const fav = s.favourite ? '❤️ ' : '';
  const price = discount && s.was ? `${s.price} VP (-${s.discount}%)` : `${s.price} VP`;
  const gap = s.gap ? ` · first Premium+ ${s.weapon} for you` : s.upgradeOver ? ` · upgrade over your ${s.upgradeOver}` : '';
  const rank = s.rank ? `#${s.rank} ${listName(s)} · ` : '';
  const untiered = s.rank && !s.yourTier ? ' · not on your tier list yet' : '';
  return `${fav}${rank}${s.name} · ${s.tier} · ${price}${gap}${untiered}`;
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
  first: s => s.rank !== null || s.gap,
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
          : hasFav ? 'FAVOURITE skin in your store!'
            : items.some(s => s.rank !== null) ? 'Top-tier skin in your store'
              : `New Premium+ skin for your ${items[0].weapon}`;
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

// New Exclusive/Ultra collections that aren't on your tier list: ping once so you can rank them.
// The first run only records what's there, so you don't get pinged about old untiered stuff.
async function handleNewBundles(ranking, state) {
  const now = [...new Set(ranking.guns.filter(s => !s.yourTier).map(s => s.collection))].sort();
  if (Array.isArray(state.untiered)) {
    const fresh = now.filter(c => !state.untiered.includes(c));
    if (fresh.length) {
      await notify({
        title: 'New bundle to rank',
        message: `${fresh.join(', ')} ${fresh.length > 1 ? 'are' : 'is'} new and not on your tier list yet. It sits mid-table until you rank it.`,
        priority: 'default',
        tags: ['new'],
      });
    }
  }
  return now;
}

// ---------- webpages ----------
// Design: Valorant's own palette (ink navy, bone, red) and clipped HUD corners.
// One bold moment: the bone hero with today's verdict and the best skin playing at max level.

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Big+Shoulders+Display:wght@700;800;900&display=swap" rel="stylesheet">';

const STYLE = `
  :root {
    --ink: #0F1923; --ink-2: #16212C; --steel: #1C252E; --line: #2B3640;
    --bone: #ECE8E1; --bone-2: #DCD6CC; --red: #FF4655; --red-deep: #BD3944;
    --slate: #7B8590; --text: #ECE8E1;
    --display: "Big Shoulders Display", "Arial Narrow", sans-serif;
    --body: "Barlow", system-ui, -apple-system, "Segoe UI", sans-serif;
    --clip: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px));
    --clip-sm: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 0 100%);
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  @view-transition { navigation: auto; }  /* smooth fade between Today and Rankings */
  .off { display: none !important; }
  body { margin: 0; background: var(--ink); color: var(--text); font: 400 16px/1.5 var(--body); }
  body::before { /* faint tactical grid */
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: .5;
    background-image: linear-gradient(rgb(255 255 255 / .025) 1px, transparent 1px),
                      linear-gradient(90deg, rgb(255 255 255 / .025) 1px, transparent 1px);
    background-size: 48px 48px;
  }
  a { color: inherit; }
  .wrap { position: relative; z-index: 1; max-width: 1180px; margin: 0 auto; padding: 0 20px; }

  /* top bar */
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 0; }
  .logo { display: flex; align-items: center; gap: 10px; text-decoration: none; white-space: nowrap;
          font: 900 26px/1 var(--display); letter-spacing: .02em; text-transform: uppercase; }
  .logo i { width: 14px; height: 26px; background: var(--red); transform: skewX(-18deg); display: inline-block; }
  .tabs { display: flex; gap: 4px; background: var(--ink-2); padding: 4px; clip-path: var(--clip-sm); }
  .tabs a { text-decoration: none; padding: 8px 16px; font-weight: 600; font-size: 15px; color: var(--slate); }
  .tabs a.on { background: var(--bone); color: var(--ink); }
  .tabs a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--red); outline-offset: 2px; }

  /* HERO: the one loud moment */
  .hero { position: relative; background: var(--bone); color: var(--ink); clip-path: var(--clip);
          display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 28px; align-items: center;
          padding: 36px; margin-top: 6px; overflow: hidden; }
  .hero::after { /* red slash that sweeps in on load */
    content: ""; position: absolute; left: -10%; top: 0; bottom: 0; width: 38%; background: var(--red);
    transform: skewX(-22deg) translateX(-140%); opacity: .95; animation: slash 1.1s cubic-bezier(.7,0,.2,1) .1s forwards;
    pointer-events: none; }
  @keyframes slash { 0% { transform: skewX(-22deg) translateX(-140%); } 55% { transform: skewX(-22deg) translateX(120%); } 100% { transform: skewX(-22deg) translateX(420%); } }
  .verdict { font: 900 clamp(56px, 9vw, 120px)/.86 var(--display); text-transform: uppercase; margin: 0;
             letter-spacing: -.005em; }
  .verdict span { display: block; overflow: hidden; }
  .verdict span b { display: block; font-weight: 900; transform: translateY(105%); animation: rise .7s cubic-bezier(.2,.8,.2,1) forwards; }
  .verdict span:nth-child(2) b { animation-delay: .12s; }
  @keyframes rise { to { transform: none; } }
  .hero.fav .verdict { color: var(--red-deep); }
  .hero.solo { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
  .hero.solo .verdict { grid-column: 1 / -1; }
  .hero.solo .lede { margin-top: 0; }
  .lede { font-size: 18px; line-height: 1.45; max-width: 34ch; margin: 18px 0 0; color: #2A3540; }
  .lede strong { color: var(--ink); }
  .clock { display: inline-flex; align-items: baseline; gap: 8px; margin-top: 20px; padding: 10px 14px;
           background: var(--ink); color: var(--bone); clip-path: var(--clip-sm); }
  .clock b { font: 800 28px/1 var(--display); font-variant-numeric: tabular-nums; letter-spacing: .02em; }
  .clock small { font-size: 14px; color: var(--bone-2); }
  .hero .feature { position: relative; }
  .hero .feature .viewer { background: var(--ink); padding: 10px; clip-path: var(--clip); }
  .hero .feature .vbar { color: var(--bone); }
  .hero .feature .name { font: 800 22px/1.1 var(--display); text-transform: uppercase; margin: 12px 0 0; color: var(--ink); }

  /* sections */
  .sec { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 44px 0 14px; }
  .sec h2 { margin: 0; font: 800 34px/1 var(--display); text-transform: uppercase; }
  .sec .meta { color: var(--slate); font-size: 15px; }
  .sec .meta b { color: var(--bone); font-variant-numeric: tabular-nums; }

  /* skin cards */
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .card { --tier: var(--slate); position: relative; background: var(--steel); clip-path: var(--clip); padding: 12px; }
  .card::before { content: ""; position: absolute; left: 0; top: 0; width: 4px; height: 100%; background: var(--tier); }
  .card.fav { background: linear-gradient(var(--steel), var(--steel)) padding-box; }
  .card.fav::after { /* animated border for favourites - rare, so it gets the flash */
    content: ""; position: absolute; inset: 0; clip-path: var(--clip); pointer-events: none; padding: 2px;
    background: conic-gradient(from var(--a, 0deg), var(--red), transparent 30%, var(--red) 50%, transparent 80%, var(--red));
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude; animation: spin 4s linear infinite; }
  @property --a { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
  @keyframes spin { to { --a: 360deg; } }
  .info { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: end; padding: 12px 6px 4px 10px; }
  .info h3 { margin: 0; font: 800 26px/1 var(--display); text-transform: uppercase; }
  .tierline { display: flex; align-items: center; gap: 6px; color: var(--tier); font-weight: 600; font-size: 14px; }
  .tierline img { width: 18px; height: 18px; }
  .heart { color: var(--red); }
  .price { text-align: right; font: 800 24px/1 var(--display); }
  .price small { display: block; font: 500 13px/1.3 var(--body); color: var(--slate); }
  .price s { color: var(--slate); font-weight: 600; }
  .price .disc { color: #3FD1A5; }
  .rankchip { justify-self: start; display: inline-flex; gap: 6px; align-items: baseline; font-size: 14px; color: var(--slate); }
  .rankchip b { font: 800 20px/1 var(--display); color: var(--bone); }
  .gaptag { grid-column: 1 / -1; justify-self: start; display: inline-flex; align-items: center; gap: 8px; margin-top: 6px;
            padding: 6px 10px; background: rgb(255 70 85 / .12); color: #FF7A85; font-size: 14px; font-weight: 600; clip-path: var(--clip-sm); }
  .gaptag::before { content: ""; width: 8px; height: 8px; background: var(--red); transform: rotate(45deg); }
  .gaptag.up { background: rgb(63 209 165 / .12); color: #3FD1A5; }
  .gaptag.up::before { background: #3FD1A5; }
  .owned { display: inline-block; margin-left: 8px; padding: 2px 7px; font: 700 11px/1.4 var(--body); color: var(--ink);
           background: var(--bone-2); vertical-align: 2px; clip-path: var(--clip-sm); }
  .row.mine .n { opacity: .45; }
  .wtab { position: relative; }
  .wtab.need::after { content: ""; position: absolute; top: 7px; right: 9px; width: 7px; height: 7px; background: var(--red); transform: rotate(45deg); }
  .row .who .need { color: #FF7A85; }

  /* video viewer */
  .player { position: relative; aspect-ratio: 16 / 9; background: #05090D; overflow: hidden;
            display: flex; align-items: center; justify-content: center; }
  .player video, .player img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .player .nov { color: var(--slate); font-size: 14px; }
  .player::before { /* shimmer while the video loads */
    content: ""; position: absolute; inset: 0; z-index: 1; pointer-events: none;
    background: linear-gradient(100deg, transparent 30%, rgb(236 232 225 / .07) 50%, transparent 70%);
    background-size: 220% 100%; animation: shim 1.3s linear infinite; }
  .player.ready::before { display: none; }
  @keyframes shim { from { background-position: 120% 0; } to { background-position: -120% 0; } }
  .vbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; flex-wrap: wrap; padding: 0 2px; }
  .vlabel { font-size: 14px; color: var(--slate); }
  .vlabel b { color: var(--bone); font-weight: 600; }
  .variants { display: flex; gap: 6px; flex-wrap: wrap; }
  .sw { width: 36px; height: 36px; padding: 0; border: 2px solid var(--line); background: var(--ink-2); cursor: pointer;
        overflow: hidden; display: flex; align-items: center; justify-content: center; color: var(--slate);
        font: 700 11px/1 var(--body); clip-path: var(--clip-sm); transition: border-color .15s, transform .15s; }
  .sw img { width: 100%; height: 100%; object-fit: cover; }
  .sw:active { transform: scale(.94); }
  .sw.on { border-color: var(--red); color: var(--bone); }

  /* status / error */
  .note { margin-top: 20px; padding: 14px 16px; background: var(--steel); clip-path: var(--clip-sm); border-left: 4px solid var(--red); }

  /* rankings */
  .intro { color: var(--slate); max-width: 70ch; margin: 18px 0 0; }
  .tools { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
           padding: 12px 0; margin-top: 18px; background: linear-gradient(var(--ink) 80%, transparent); }
  .seg { display: flex; background: var(--ink-2); padding: 4px; clip-path: var(--clip-sm); }
  .seg button, .chip { border: 0; background: none; color: var(--slate); font: 600 15px/1 var(--body); padding: 9px 14px; cursor: pointer; }
  .seg button { transition: background .2s, color .2s; }
  .seg button[aria-pressed="true"] { background: var(--bone); color: var(--ink); }
  .chip { background: var(--ink-2); clip-path: var(--clip-sm); }
  .chip { transition: background .2s, color .2s; }
  .chip[aria-pressed="true"] { background: var(--red); color: #fff; }
  .count { color: var(--slate); font-size: 14px; margin-left: auto; font-variant-numeric: tabular-nums; }
  .weapons { flex: 1 1 100%; display: flex; gap: 8px; overflow-x: auto; scroll-snap-type: x proximity; scrollbar-width: none;
             padding: 2px 2px 4px; -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 32px), transparent);
             mask-image: linear-gradient(90deg, #000 calc(100% - 32px), transparent); }
  .weapons::-webkit-scrollbar { display: none; }
  .wtab { flex: none; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 6px;
          min-width: 96px; height: 70px; padding: 8px 12px; background: var(--ink-2); border: 1px solid var(--line);
          color: var(--slate); font: 600 14px/1 var(--body); cursor: pointer; scroll-snap-align: start;
          clip-path: var(--clip-sm); transition: background .2s, color .2s, border-color .2s; }
  .wtab img { height: 22px; max-width: 76px; object-fit: contain; opacity: .55; transition: opacity .2s, filter .2s; }
  .wtab small { font-size: 12px; color: inherit; opacity: .8; font-weight: 500; }
  .wtab:hover { border-color: var(--slate); color: var(--bone); }
  .wtab:hover img { opacity: .9; }
  .wtab[aria-pressed="true"] { background: var(--bone); color: var(--ink); border-color: var(--bone); }
  .wtab[aria-pressed="true"] img { opacity: 1; filter: invert(1); }
  .wtab .all { font: 900 22px/1 var(--display); }
  .row.in { animation: rowIn .4s cubic-bezier(.2,.8,.2,1) both; }
  @keyframes rowIn { from { opacity: 0; transform: translateX(-14px); } }
  .row .n { transition: color .2s; }
  .search { flex: 1 1 200px; min-width: 0; background: var(--ink-2); border: 1px solid var(--line); color: var(--bone);
            font: 500 15px/1 var(--body); padding: 10px 12px; }
  .search::placeholder { color: var(--slate); }
  .rows { list-style: none; margin: 4px 0 0; padding: 0; }
  .row { --tier: var(--slate); display: grid; grid-template-columns: 64px 92px minmax(0, 1fr) auto 44px; gap: 14px; align-items: center;
         padding: 8px 0; border-bottom: 1px solid var(--line); }
  .row .n { font: 900 32px/1 var(--display); color: var(--slate); text-align: right; font-variant-numeric: tabular-nums; }
  .row.top .n { color: var(--bone); }
  .row.fav .n { color: var(--red); }
  .row .thumb { height: 40px; display: flex; align-items: center; justify-content: center; }
  .row .thumb img { max-width: 100%; max-height: 40px; object-fit: contain; }
  .row .who { min-width: 0; }
  .row .who b { display: block; font: 700 17px/1.2 var(--body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .who span { font-size: 13px; color: var(--slate); }
  .row .tierline { justify-self: end; }
  .row.cut { border-bottom: 2px solid var(--red); }
  .play { width: 40px; height: 40px; border: 1px solid var(--line); background: var(--steel); color: var(--bone);
          cursor: pointer; clip-path: var(--clip-sm); font-size: 13px; transition: background .15s; }
  .play:hover { background: var(--red); border-color: var(--red); }
  .empty { color: var(--slate); padding: 24px 0; }
  dialog { width: min(980px, calc(100vw - 24px)); max-height: calc(100vh - 24px); background: var(--steel); color: var(--bone);
           border: 0; padding: 14px; clip-path: var(--clip); }
  dialog::backdrop { background: rgb(5 9 13 / .82); backdrop-filter: blur(3px); }
  dialog[open] { animation: pop .22s cubic-bezier(.2,.8,.2,1); }
  @keyframes pop { from { transform: translateY(12px) scale(.98); opacity: 0; } }
  .dhead { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; }
  .dhead h3 { margin: 0; font: 800 28px/1 var(--display); text-transform: uppercase; }
  .x { background: var(--ink-2); border: 0; color: var(--bone); width: 40px; height: 40px; cursor: pointer; clip-path: var(--clip-sm); font-size: 16px; }

  /* watchlist strip */
  .watch { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(210px, 1fr); gap: 12px; overflow-x: auto;
           scroll-snap-type: x proximity; padding-bottom: 10px; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
  .wcard { --tier: var(--slate); position: relative; display: flex; flex-direction: column; gap: 10px; text-align: left;
           background: var(--steel); border: 0; color: var(--bone); padding: 14px 14px 12px; cursor: pointer;
           clip-path: var(--clip); scroll-snap-align: start; transition: transform .25s cubic-bezier(.2,.8,.2,1), background .2s; }
  .wcard::before { content: ""; position: absolute; left: 0; top: 0; width: 100%; height: 3px; background: var(--tier); }
  .wcard:hover { transform: translateY(-3px); background: #222D37; }
  .wcard .pic { height: 64px; display: flex; align-items: center; justify-content: center; }
  .wcard .pic img { max-width: 100%; max-height: 64px; object-fit: contain; transition: transform .35s cubic-bezier(.2,.8,.2,1); }
  .wcard:hover .pic img { transform: scale(1.06) rotate(-2deg); }
  .wcard b { font: 800 19px/1.05 var(--display); text-transform: uppercase; }
  .wcard span { font-size: 13px; color: var(--slate); }
  .wcard span em { font-style: normal; color: var(--bone); font-weight: 600; }

  footer { margin: 56px 0 40px; color: var(--slate); font-size: 14px; max-width: 70ch; }

  @media (max-width: 820px) {
    .hero { grid-template-columns: 1fr; padding: 24px 20px 22px; gap: 20px; }
    .grid { grid-template-columns: 1fr; }
    .lede { font-size: 17px; }
    .row { grid-template-columns: 44px 64px minmax(0, 1fr) 40px; gap: 10px; }
    .row .tierline { display: none; }
    .row .n { font-size: 26px; }
    .hero.solo { grid-template-columns: 1fr; }
    .search { order: 3; flex-basis: 100%; }
    .weapons { order: 4; }
    .tools { position: static; background: none; }
    .logo { font-size: 22px; }
    .sec h2 { font-size: 28px; }
  }
  @media (max-width: 440px) {
    .logo { font-size: 19px; gap: 8px; } .logo i { width: 11px; height: 20px; }
    .tabs a { padding: 8px 11px; font-size: 14px; }
  }
  @media (max-width: 360px) { .wrap { padding: 0 12px; } .tabs a { padding: 7px 9px; } }
  @media (prefers-reduced-motion: reduce) {
    .hero::after { display: none; }
    .verdict span b { transform: none; animation: none; }
    .card.fav::after { animation: none; }
    .row.in { animation: none; }
    .player::before { animation: none; }
    .wcard, .wcard .pic img { transition: none; }
    @view-transition { navigation: none; }
    dialog[open] { animation: none; }
  }
`;

// Media for the skins on a page, as compact JSON the viewer script reads.
function mediaJson(skins) {
  const out = {};
  for (const s of skins) {
    if (!s || !s.id || out[s.id]) continue;
    const v = (s.variants || []).map(x => ({ n: x.name, s: x.swatch, i: x.image, vd: x.video }));
    if (!v.length && s.icon) v.push({ n: 'Base', s: null, i: s.icon, vd: null });
    out[s.id] = { n: s.name, v };
  }
  return JSON.stringify(out).replace(/</g, '\\u003c');
}

// Client script: video viewer with variant buttons, live countdowns, rankings filters + preview dialog.
const CLIENT_JS = `
(function () {
  var MEDIA = window.MEDIA || {};
  var PAGE = window.PAGE || {};
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  function render(box, idx, play) {
    var m = MEDIA[box.dataset.id]; if (!m || !m.v.length) return;
    var v = m.v[idx] || m.v[0];
    var player = box.querySelector('.player');
    if (v.vd) {
      player.innerHTML = '<video controls loop muted playsinline preload="metadata"></video>';
      player.classList.remove('ready');
      var vid = player.firstChild; vid.src = v.vd; if (v.i) vid.poster = v.i;
      vid.addEventListener('loadeddata', function () { player.classList.add('ready'); }, { once: true });
      if (play) vid.play().catch(function () {});
    } else if (v.i) {
      player.classList.remove('ready');
      player.innerHTML = '<img alt="">'; player.firstChild.alt = m.n + ', ' + v.n;
      player.firstChild.addEventListener('load', function () { player.classList.add('ready'); }, { once: true });
      player.firstChild.src = v.i;
    } else {
      player.classList.add('ready');
      player.innerHTML = '<div class="nov">No preview from Riot for this one</div>';
    }
    box.querySelector('.vlabel').innerHTML = '<b>' + esc(v.n) + '</b> ' + (v.vd ? 'at max level' : '(render, no video)');
    box.querySelectorAll('.sw').forEach(function (b, i) { b.classList.toggle('on', i === idx); b.setAttribute('aria-pressed', i === idx); });
  }
  function mount(box) {
    var m = MEDIA[box.dataset.id]; if (!m) return;
    var bar = box.querySelector('.variants'); bar.innerHTML = '';
    if (m.v.length > 1) m.v.forEach(function (v, i) {
      var b = document.createElement('button');
      b.className = 'sw'; b.type = 'button'; b.title = v.n; b.setAttribute('aria-label', 'Show ' + v.n + ' variant');
      if (v.s) { var img = document.createElement('img'); img.src = v.s; img.alt = ''; b.appendChild(img); }
      else b.textContent = i === 0 ? 'Base' : String(i);
      b.addEventListener('click', function () { render(box, i, true); });
      bar.appendChild(b);
    });
    render(box, 0, false);
  }
  document.querySelectorAll('.viewer[data-id]').forEach(mount);

  // Store page: play muted while on screen, pause when scrolled away.
  var autos = document.querySelectorAll('.viewer[data-auto]');
  if (!reduce && autos.length && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var vid = e.target.querySelector('video'); if (!vid) return;
        if (e.isIntersecting) vid.play().catch(function () {}); else vid.pause();
      });
    }, { threshold: 0.5 });
    autos.forEach(function (a) { io.observe(a); });
  }

  // Live countdowns.
  function fmt(ms) {
    if (ms <= 0) return 'now';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? d + 'd ' + h + 'h' : h + 'h ' + String(m).padStart(2, '0') + 'm';
  }
  function tick() {
    document.querySelectorAll('[data-until]').forEach(function (el) { el.textContent = fmt(+el.dataset.until - Date.now()); });
  }
  tick(); setInterval(tick, 20000);

  // Rankings: list tabs, weapon tabs, search and filters.
  var rows = Array.prototype.slice.call(document.querySelectorAll('.row'));
  if (rows.length) {
    var state = { list: 'gun', weapon: 'all', q: '', fav: false, top: false, need: false, hideOwned: false, untiered: false };
    var empty = document.querySelector('.empty');
    var count = document.querySelector('.count');
    var weaponBar = document.querySelector('.weapons');
    function apply(animate) {
      var shown = [];
      rows.forEach(function (r) {
        var ok = r.dataset.list === state.list
          && (state.list !== 'gun' || state.weapon === 'all' || r.dataset.weapon === state.weapon)
          && (!state.q || r.dataset.name.indexOf(state.q) !== -1)
          && (!state.fav || r.classList.contains('fav'))
          && (!state.top || r.classList.contains('top'))
          && (!state.need || r.dataset.need === '1')
          && (!state.hideOwned || !r.classList.contains('mine'))
          && (!state.untiered || r.classList.contains('untiered'));
        r.classList.toggle('off', !ok);
        r.classList.remove('in');
        if (ok) shown.push(r);
      });
      if (empty) empty.classList.toggle('off', shown.length > 0);
      if (count) count.textContent = shown.length + (shown.length === 1 ? ' skin' : ' skins');
      if (weaponBar) weaponBar.classList.toggle('off', state.list !== 'gun');
      // Cascade the first rows in so the change is visible.
      if (animate && !reduce) {
        void document.body.offsetWidth;
        shown.slice(0, 24).forEach(function (r, i) { r.style.animationDelay = (i * 22) + 'ms'; r.classList.add('in'); });
      }
    }
    function pressOnly(sel, el) {
      document.querySelectorAll(sel).forEach(function (x) { x.setAttribute('aria-pressed', x === el ? 'true' : 'false'); });
    }
    document.querySelectorAll('.seg button').forEach(function (b) {
      b.addEventListener('click', function () { state.list = b.dataset.list; pressOnly('.seg button', b); apply(true); });
    });
    document.querySelectorAll('.wtab').forEach(function (b) {
      b.addEventListener('click', function () {
        state.weapon = b.dataset.weapon; pressOnly('.wtab', b); apply(true);
        if (b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduce ? 'auto' : 'smooth' });
      });
    });
    document.querySelectorAll('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        var on = c.getAttribute('aria-pressed') !== 'true';
        c.setAttribute('aria-pressed', on ? 'true' : 'false'); state[c.dataset.f] = on;
        if (c.dataset.f === 'need' && on && state.list !== 'gun') { var g = document.querySelector('.seg button[data-list="gun"]'); if (g) { g.click(); return; } }
        apply(true);
      });
    });
    var search = document.querySelector('.search');
    var t;
    if (search) search.addEventListener('input', function () {
      clearTimeout(t); t = setTimeout(function () { state.q = search.value.trim().toLowerCase(); apply(true); }, 120);
    });
    apply(false);
  }

  // Rankings: preview dialog.
  var dlg = document.getElementById('dlg');
  if (dlg) {
    var box = dlg.querySelector('.viewer');
    document.querySelectorAll('[data-preview]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        box.dataset.id = btn.dataset.preview;
        dlg.querySelector('h3').textContent = (MEDIA[btn.dataset.preview] || {}).n || '';
        mount(box); dlg.showModal();
        var vid = box.querySelector('video'); if (vid && !reduce) vid.play().catch(function () {});
      });
    });
    function stop() { var vid = box.querySelector('video'); if (vid) vid.pause(); }
    dlg.querySelector('.x').addEventListener('click', function () { stop(); dlg.close(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) { stop(); dlg.close(); } });
    dlg.addEventListener('close', stop);
  }
})();
`;

function shell({ title, active, body, media = '{}', page = {} }) {
  const updated = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0F1923">
<title>${esc(title)}</title>
${FONTS}
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <nav class="bar" aria-label="Main">
    <a class="logo" href="./"><i aria-hidden="true"></i>Store Watch</a>
    <div class="tabs"><a href="./"${active === 'store' ? ' class="on" aria-current="page"' : ''}>Today</a><a href="rankings.html"${active === 'rank' ? ' class="on" aria-current="page"' : ''}>Rankings</a></div>
  </nav>
  <main>
  ${body}
  </main>
  <footer>Last checked ${esc(updated)}, Qatar time. Checks run every 2 hours and the store resets at 3:00 AM. Videos show each skin fully upgraded.</footer>
</div>
<script>window.MEDIA = ${media}; window.PAGE = ${JSON.stringify(page)};</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

const viewerHtml = (id, auto) => `
      <div class="viewer" data-id="${esc(id)}"${auto ? ' data-auto="1"' : ''}>
        <div class="player"></div>
        <div class="vbar"><span class="vlabel"></span><div class="variants" role="group" aria-label="Variants"></div></div>
      </div>`;

const tierLine = (s, heart = true) => `<span class="tierline">${s.tierIcon ? `<img src="${esc(s.tierIcon)}" alt="">` : ''}${heart && s.favourite ? '<span class="heart" aria-label="Favourite">❤</span>' : ''}${esc(s.tier)}${s.weapon === 'Melee' ? ' melee' : ''}</span>`;

const dialogHtml = () => `
  <dialog id="dlg" aria-label="Skin preview">
    <div class="dhead"><h3></h3><button class="x" type="button" aria-label="Close preview">✕</button></div>
    ${viewerHtml('', false)}
  </dialog>`;

// Your favourites, best-ranked first, as a swipeable strip with previews.
function watchlist(ranking) {
  const favs = [...ranking.guns, ...ranking.knives].filter(s => s.favourite && !s.owned)
    .sort((a, b) => (a.list === b.list ? a.rank - b.rank : a.list === 'gun' ? -1 : 1));
  if (!favs.length) return { html: '', skins: [] };
  const tiles = favs.map(s => `
      <button class="wcard" type="button" data-preview="${esc(s.id)}" style="--tier:${TIER_COLOUR[s.tier] || '#7B8590'}" aria-label="Preview ${esc(s.name)}">
        <span class="pic">${s.icon ? `<img src="${esc(s.icon)}" alt="" loading="lazy">` : ''}</span>
        <b>${esc(s.name)}</b>
        <span><em>#${s.rank}</em> ${listName(s)}, ${esc(s.tier)}</span>
      </button>`).join('');
  return {
    html: `
  <div class="sec"><h2>Your watchlist</h2><span class="meta">${favs.length} favourite skins you're waiting for</span></div>
  <div class="watch">${tiles}</div>`,
    skins: favs,
  };
}

function card(s) {
  const colour = TIER_COLOUR[s.tier] || '#7B8590';
  const price = s.was
    ? `${s.price} VP<small><s>${s.was}</s> <span class="disc">${s.discount}% off</span></small>`
    : `${s.price} VP`;
  const rank = s.rank
    ? `<span class="rankchip"><b>#${s.rank}</b>${listName(s)}${s.rated ? '' : ', no vote data'}</span>`
    : `<span class="rankchip">${s.weapon === 'Melee' ? 'Knife, not tracked' : 'Not ranked'}</span>`;
  return `
    <article class="card${s.favourite ? ' fav' : ''}" style="--tier:${colour}">
      ${viewerHtml(s.id, true)}
      <div class="info">
        <div>${tierLine(s)}<h3>${esc(s.name)}</h3></div>
        <div class="price">${price}</div>
        ${rank}
        ${s.gap ? `<span class="gaptag">Your first Premium+ ${esc(s.weapon)}</span>` : ''}
        ${s.upgradeOver ? `<span class="gaptag up">Upgrade over your ${esc(s.upgradeOver)}</span>` : ''}
      </div>
    </article>`;
}

// Picks the skin to feature in the hero: a favourite, else the best-ranked, else the first.
function featured(items) {
  return items.find(s => s.favourite)
    || items.filter(s => s.rank !== null).sort((a, b) => a.rank - b.rank)[0]
    || items.find(s => s.gap)
    || items[0];
}

function storePage(store, ranking) {
  const now = Date.now();
  const resetAt = now + store.dailyLeft * 1000;
  const nightEndAt = now + store.nightLeft * 1000;
  const all = [...store.daily, ...store.night];
  const favs = all.filter(s => s.favourite);
  const tops = all.filter(s => s.rank !== null);
  const pick = featured(all);

  let lines, lede, cls = '';
  if (favs.length) {
    cls = ' fav';
    lines = ["It's", 'here.'];
    lede = `<strong>${esc(favs.map(s => s.name).join(' and '))}</strong> ${favs.length > 1 ? 'are' : 'is'} in your ${store.night.includes(favs[0]) ? 'Night Market' : 'store'}. One of your favourites.`;
  } else if (tops.length) {
    const best = tops.sort((a, b) => a.rank - b.rank)[0];
    lines = ['Worth a', 'look.'];
    lede = `<strong>${esc(best.name)}</strong> is #${best.rank} on the ${listName(best)} rankings${tops.length > 1 ? `, and ${tops.length - 1} more top-tier skin${tops.length > 2 ? 's are' : ' is'} in today` : ''}.`;
  } else if (all.some(s => s.gap)) {
    const g = all.filter(s => s.gap);
    lines = ['Fills a', 'gap.'];
    lede = `<strong>${esc(g[0].name)}</strong> would be your first Premium-or-better ${esc(g[0].weapon)}${g.length > 1 ? `, and ${g.length - 1} more skin${g.length > 2 ? 's' : ''} today would fill a gap too` : ''}.`;
  } else {
    lines = ['Keep', 'waiting.'];
    lede = 'Nothing Exclusive or Ultra in your store today, and nothing for the guns you still need a skin for.';
  }

  const hero = `
  <section class="hero${cls}" aria-label="Today's verdict">
    <div>
      <h1 class="verdict">${lines.map(l => `<span><b>${esc(l)}</b></span>`).join('')}</h1>
      <p class="lede">${lede}</p>
      <div class="clock"><b data-until="${resetAt}">${fmtDuration(store.dailyLeft)}</b><small>until the store resets</small></div>
    </div>
    ${pick ? `<div class="feature">${viewerHtml(pick.id, true)}<p class="name">${esc(pick.name)}</p></div>` : ''}
  </section>`;

  let body = `${hero}
  <div class="sec"><h2>Your store</h2><span class="meta">New skins in <b data-until="${resetAt}">${fmtDuration(store.dailyLeft)}</b></span></div>
  <div class="grid">${store.daily.map(card).join('')}</div>`;
  if (store.night.length) {
    body += `
  <div class="sec"><h2>Night Market</h2><span class="meta">Ends in <b data-until="${nightEndAt}">${fmtDuration(store.nightLeft)}</b></span></div>
  <div class="grid">${store.night.map(card).join('')}</div>`;
  }
  const watch = ranking ? watchlist(ranking) : { html: '', skins: [] };
  body += watch.html + dialogHtml();
  return shell({ title: 'Store Watch', active: 'store', body, media: mediaJson([...all, ...watch.skins]) });
}

function rankRow(s) {
  const colour = TIER_COLOUR[s.tier] || '#7B8590';
  const cls = ['row', s.rank <= R.TOP_RANK ? 'top' : '', s.favourite ? 'fav' : '', s.rank === R.TOP_RANK ? 'cut' : '', s.owned ? 'mine' : '', s.yourTier ? '' : 'untiered'].filter(Boolean).join(' ');
  return `
      <li class="${cls}" data-list="${s.list}" data-need="${R.needsGun(s.weapon) && s.list === 'gun' ? '1' : ''}" data-weapon="${esc(s.weapon)}" data-name="${esc(s.name.toLowerCase())}" style="--tier:${colour}">
        <span class="n">${s.rank}</span>
        <span class="thumb">${s.icon ? `<img src="${esc(s.icon)}" alt="" loading="lazy">` : ''}</span>
        <span class="who"><b>${s.favourite ? '<span class="heart" aria-label="Favourite">❤ </span>' : ''}${esc(s.name)}${s.owned ? '<span class="owned">Owned</span>' : ''}</b><span>${esc(s.collection)}${s.yourTier ? `, your ${esc(s.yourTier)} tier` : ', not on your tier list yet'}${R.needsGun(s.weapon) && s.list === 'gun' ? `, <span class="need">you need ${/^[aeiou]/i.test(s.weapon) ? 'an' : 'a'} ${esc(s.weapon)} skin</span>` : ''}</span></span>
        ${tierLine(s, false)}
        <button class="play" type="button" data-preview="${esc(s.id)}" aria-label="Preview ${esc(s.name)}">▶</button>
      </li>`;
}

const WEAPON_ORDER = ['Vandal', 'Phantom', 'Operator', 'Sheriff', 'Ghost', 'Spectre', 'Classic', 'Marshal', 'Outlaw',
  'Bulldog', 'Guardian', 'Judge', 'Bucky', 'Stinger', 'Frenzy', 'Shorty', 'Ares', 'Odin'];

function weaponTabs(guns, icons) {
  const counts = {};
  for (const s of guns) counts[s.weapon] = (counts[s.weapon] || 0) + 1;
  const names = Object.keys(counts).sort((a, b) => {
    const ia = WEAPON_ORDER.indexOf(a), ib = WEAPON_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const tab = (key, label, inner, n, on) => `<button class="wtab${key !== 'all' && R.needsGun(key) ? ' need' : ''}" type="button" data-weapon="${esc(key)}" aria-pressed="${on}" aria-label="${esc(label)}, ${n} skins">${inner}<span>${esc(label)}</span><small>${n}</small></button>`;
  return `<div class="weapons" role="group" aria-label="Filter by weapon">${
    tab('all', 'All guns', '<span class="all">ALL</span>', guns.length, true)
  }${names.map(w => tab(w, w, icons && icons[w] ? `<img src="${esc(icons[w])}" alt="">` : '', counts[w], false)).join('')}</div>`;
}

function rankingsPage(ranking, weaponIcons) {
  const body = `
  <section class="hero solo" aria-label="Rankings">
    <h1 class="verdict"><span><b>The rankings.</b></span></h1>
    <p class="lede">Every Exclusive and Ultra gun skin you can get from the store, ranked by your own tier list and gun weights. Knives and event-only skins like Champions are left out.</p>
    <div><p class="lede">Ranks 1 to ${R.TOP_RANK} get two reminders a day when they show up in your store. Your favourites get urgent alerts and a last-chance ping. Press ▶ on any skin to watch it fully upgraded, in every variant. Red diamonds mark the guns you don't have a Premium-or-better skin for yet.</p></div>
  </section>
  <div class="tools">
    <input class="search" type="search" placeholder="Search skins" aria-label="Search skins">
    <button class="chip" type="button" data-f="fav" aria-pressed="false">❤ Favourites</button>
    <button class="chip" type="button" data-f="top" aria-pressed="false">Top ${R.TOP_RANK}</button>
    <button class="chip" type="button" data-f="need" aria-pressed="false">Guns I need</button>
    <button class="chip" type="button" data-f="hideOwned" aria-pressed="false">Hide owned</button>
    <button class="chip" type="button" data-f="untiered" aria-pressed="false">Not on my list</button>
    <span class="count" aria-live="polite"></span>
    ${weaponTabs(ranking.guns, weaponIcons)}
  </div>
  <ol class="rows">${[...ranking.guns, ...ranking.knives].map(rankRow).join('')}</ol>
  <p class="empty off">No skins match. Clear the search or filters.</p>
  ${dialogHtml()}`;
  return shell({ title: 'Rankings · Store Watch', active: 'rank', body, media: mediaJson([...ranking.guns, ...ranking.knives]) });
}

function errorPage(message) {
  return shell({
    title: 'Store Watch', active: 'store',
    body: `
  <section class="hero solo" aria-label="Status">
    <h1 class="verdict"><span><b>Check failed.</b></span></h1>
    <p class="lede">${esc(message)}</p>
    <div><p class="lede">The bot tries again every 2 hours. If this is a login problem, paste a fresh cookie line into the RIOT_SSID secret on GitHub.</p></div>
  </section>`,
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

  writeFile('index.html', storePage(store, catalog.ranking));
  writeFile('rankings.html', rankingsPage(catalog.ranking, catalog.weaponIcons));

  const state = loadState();
  const daily = await handleDaily(store, state);
  const night = await handleNight(store, state);
  const untiered = await handleNewBundles(catalog.ranking, state);
  saveState({ daily, night, untiered, errorNotified: false });
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
