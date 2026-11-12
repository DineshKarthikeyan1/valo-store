// rankings.js - how skins are ranked, and your favourites.
//
// The full skin list and official tiers come live from game data (valorant-api.com)
// on every run, so new bundles appear automatically. Only Exclusive and Ultra skins
// are ranked. Guns are ranked all together; knives get their own list.
//
// How a skin's score is built:
//   guns:   collection score x weapon popularity + standout-skin bonus
//   knives: the knife's own community score (if it has one), else its collection score
// Collection score = YOUR_TIERS if set, otherwise the COMMUNITY vote consensus.

// ---- Your favourite collections: urgent alerts + an extra last-chance reminder ----
const FAVOURITES = ['Spectrum', 'Ayakashi', 'Radiant Entertainment System', 'ORA'];

// ---- Skins you own ----
// "Name Weapon" matches that skin; "Collection *" matches the whole bundle (knife included).
// Numbers are ignored when matching, so "PRX 25 Classic" matches the PRX Classic however Riot names it.
const OWNED = [
  'Phaseguard Vandal',
  'Popmonz *',            // whole bundle: Phantom, Odin, Sheriff, Stinger, knife
  'Nocturnum Phantom',
  'Forsaken Guardian',
  'PRX 25 Classic',
  'Evori Dreamwings Spectre',
  'Aeris Vandal',
];

// ---- Guns you don't own a Premium-or-better skin for yet ----
// Any Premium, Exclusive or Ultra skin for these gets flagged and pinged once, even if it isn't top-ranked.
// Remove a gun from this list once you've bought a skin for it.
const NEED_GUNS = ['Shorty', 'Frenzy', 'Ghost', 'Judge', 'Bucky', 'Bandit', 'Outlaw',
  'Bulldog', 'Marshal', 'Operator', 'Warden'];
const GAP_TIERS = new Set(['Premium', 'Exclusive', 'Ultra']);

// ---- Reminder rules ----
const TOP_RANK = 50;        // ranks 1-50 (in their list) get reminded twice a day
const MID_REMINDER_H = 12;  // 2nd reminder when this many hours are left in the store
const LAST_CALL_H = 3;      // favourites also get a last-chance ping this close to reset

// ---- Your tier list (survey, Nov 2026). Wins over the community vote scores. ----
// Ordering inside each tier came from your head-to-head picks and "which lean higher" answers.
// Community votes now only break ties. Delete a line to fall back to the vote score.

// Your S tier, in your head-to-head order (best first).
const S_ORDER = ['Ayakashi', 'Radiant Entertainment System', 'Spectrum', 'ORA',
  'Prelude to Chaos', 'Kuronami', 'Aeris', 'RGX 11z Pro'];

const YOUR_TIERS = {
  // A+
  'Elderflame': 'A+', 'Neo Frontier': 'A+', 'Bubblegum Deathwish': 'A+', 'Evori Dreamwings': 'A+',
  // A, leaning to the top
  'EX.O': 'A^', 'Doombringer': 'A^',
  'Popmonz': 'A^', 'Phaseguard': 'A^',
  // A
  'Primordium': 'A', 'Singularity': 'A', 'Imperium': 'A', 'Mystbloom': 'A',
  'Blackspyre': 'A', 'Blackthorn': 'A', 'Arcane': 'A',
  // B+
  'Nocturnum': 'B+', 'Araxys': 'B+', 'Overdrive': 'B+', 'Holo Meridian': 'B+', 'Magepunk': 'B+',
  // B
  'Protocol 781-A': 'B', 'Sentinels of Light': 'B', 'ChronoVoid': 'B', 'Ruination': 'B',
  'Rogue': 'B', 'Divergence': 'B', "Dolmir's Revenge": 'B',
  // C
  'Glitchpop': 'C', 'BlastX': 'C', 'CYRAX': 'C', 'SplashX': 'C',
};
S_ORDER.forEach(name => { YOUR_TIERS[name] = 'S'; });

// Individual guns you rated differently from their bundle.
// From "which guns in this bundle are top-tier": unpicked S-bundle guns drop to A+;
// Neo Frontier's Sheriff, Marshal and Odin go up to S.
const SKIN_TIERS = {
  'Spectrum Bulldog': 'A+', 'Spectrum Guardian': 'A+',
  'Radiant Entertainment System Bulldog': 'A+',
  'RGX 11z Pro Guardian': 'A+',
  'Prelude to Chaos Operator': 'A+',
  'Neo Frontier Sheriff': 'S', 'Neo Frontier Marshal': 'S', 'Neo Frontier Odin': 'S',
};

const TIER_BASE = { S: 91.8, 'A+': 88, 'A^': 85.5, A: 84, 'B+': 81, B: 78, C: 70 };
const TIER_LABEL = { S: 'S', 'A+': 'A+', 'A^': 'A', A: 'A', 'B+': 'B+', B: 'B', C: 'C' };

// Event-only skins never appear in the daily store, so they're left out of the rankings.
const EVENT_ONLY = /champions|\bvct\b|lock\s*\/\/\s*in/i;

// ---- Community collection scores (0-100), from VOTE DATA ONLY ----
// No single-author articles. Every number below comes from aggregated votes:
//   Premate.gg   - Elo from 50,000+ head-to-head votes (100k+ votes per top Vandal)
//   SkinRanks.gg - Elo from head-to-head votes (10k-17k votes per Vandal)
//   DailyVal     - star ratings (3k-10k ratings per skin)
//   300k-vote knife poll (Sep 2025)
// A collection's score comes mostly from how its Vandal/Phantom/knife place in those votes.
// Collections marked "no vote data" weren't in any vote dataset I could read: they sit at
// a neutral 78 and show as "no vote data" on the Rankings page. Override them if you like.
const DEFAULT_SCORE = 78;
const NO_VOTE_DATA = 78;
const COMMUNITY = {
  // S
  'Prelude to Chaos': 95,  // Premate #1 Vandal; SkinRanks #4-5; DailyVal 4.8 (8.4k)
  'Champions 2021': 94,    // Premate #2 Vandal; SkinRanks #2; Premate #3 knife
  'Kuronami': 94,          // Premate #3 Vandal; SkinRanks #8; DailyVal 4.7; #1 knife in 3 votes
  'Primordium': 93,        // SkinRanks #1 Vandal; Premate #4; DailyVal 4.8 (7.1k)
  'RGX 11z Pro': 93,       // SkinRanks #11 Vandal; DailyVal 4.7; Premate #1 knife
  'Champions 2024': 92,    // Premate #1 Phantom
  // A+
  'Araxys': 90,            // SkinRanks #15 Vandal; Operator beats Ion head-to-head
  'Ayakashi': 88,          // Premate #3 Phantom (only 3.3k votes - newer)
  'Champions 2023': 88,    // SkinRanks #23 Vandal
  'Champions 2025': 88,    // DailyVal Vandal 4.6 (5.2k), Butterfly 4.7; VCT 2025 Karambit Premate #4
  'Nocturnum': 87,         // Premate #4 Phantom
  'Radiant Entertainment System': 87, // Premate #5 Phantom; Operator loses to Ion
  // A
  'Overdrive': 84,         // SkinRanks #27 Vandal
  'Sentinels of Light': 84,// SkinRanks #29 Vandal
  'Imperium': 83,          // SkinRanks #33 Vandal
  'Glitchpop': 83,         // SkinRanks #37 Vandal
  'Elderflame': 83,        // SkinRanks #38 Vandal; Operator beats Ion
  'Singularity': 83,       // DailyVal Sheriff 4.8 (5.1k); Butterfly top-15 in 300k vote
  'EX.O': 82,              // EX.O Edge #13 in 300k knife vote
  'Phaseguard': 82,        // DailyVal Ghost 4.8 (3.2k)
  'Neo Frontier': 82,      // DailyVal Sheriff 4.6 (3.7k)
  // B
  'Mystbloom': 79,         // Operator loses to Ion
  'ChronoVoid': 79,        // flagship Vandal outside SkinRanks top 40
  'SplashX': 77,           // Operator loses to Ion
  'Divergence': 76,        // DailyVal Vandal 4.3 - lowest-rated of the most-rated skins
  'ORA': 76,               // Operator loses to Ion 37-63
  // No vote data available (neutral)
  'Champions 2022': NO_VOTE_DATA,
  'Champions 2026': NO_VOTE_DATA,
  'Spectrum': NO_VOTE_DATA,
  'Protocol 781-A': NO_VOTE_DATA,
  'Evori Dreamwings': NO_VOTE_DATA,
  'Ruination': NO_VOTE_DATA,
  'BlastX': NO_VOTE_DATA,
  'CYRAX': NO_VOTE_DATA,
  'Doombringer': NO_VOTE_DATA,
  'Arcane': NO_VOTE_DATA,
  'Magepunk': NO_VOTE_DATA,
  'Bubblegum Deathwish': NO_VOTE_DATA,
  "Dolmir's Revenge": NO_VOTE_DATA,
  'Aeris': NO_VOTE_DATA,
  'Blackspyre': NO_VOTE_DATA,
  'Blackthorn': NO_VOTE_DATA,
  'Holo Meridian': NO_VOTE_DATA,
  'Rogue': NO_VOTE_DATA,
  'Popmonz': NO_VOTE_DATA,
  // Niche one-offs
  'Ignite': 62,
  'VCT': 60,
};

// ---- Individual gun skins that vote above their own collection ----
const GUN_BONUS = {
  'Champions 2024 Phantom': 4,   // Premate #1 Phantom
  'Ayakashi Phantom': 4,         // Premate #3 Phantom
  'Nocturnum Phantom': 4,        // Premate #4 Phantom
  'Radiant Entertainment System Phantom': 4, // Premate #5 Phantom
  'Prelude to Chaos Vandal': 2,
  'Champions 2021 Vandal': 2,
  'Kuronami Vandal': 2,
  'Primordium Vandal': 2,
  'Singularity Sheriff': 4,      // DailyVal 4.8
  'Phaseguard Ghost': 4,         // DailyVal 4.8
  'Neo Frontier Sheriff': 3,     // DailyVal 4.6
  'Elderflame Operator': 3,      // beats Ion Operator head-to-head
  'Kuronami Operator': 3,        // beats Ion Operator head-to-head
  'Araxys Operator': 2,          // beats Ion Operator head-to-head
};

// ---- Knife scores from votes (knives are judged on their own) ----
// Knives not listed fall back to their collection score.
const KNIFE_SCORES = {
  'RGX 11z Pro Karambit': 97,    // Premate #1 knife (80.8k votes)
  'RGX 11z Pro Blade': 97,       // (same knife, alternate name)
  'Kuronami no Yaiba': 96,       // Premate #2; #1 in 300k vote; DailyVal 4.8
  'Champions 2021 Karambit': 95, // Premate #3
  'VCT 2025 Karambit': 93,       // Premate #4
  'Champions 2025 Butterfly': 91,// DailyVal 4.7 (3k)
  'EX.O Edge': 87,               // #13 in 300k vote
  'Singularity Butterfly': 86,   // #14-15 in 300k vote
};

// ---- Weapon popularity (how much a skin on that gun matters) ----
// From your survey: how much a skin on each gun matters to you (1 = normal).
// The weight multiplies how good the skin is above a C-tier baseline, so a great skin on a
// 1.5x gun climbs a lot, while a weak skin on it barely moves.
const WEAPON_WEIGHT = {
  // 1.5x group, with an extra 1.2x on top for these four (1.5 x 1.2 = 1.8x)
  Vandal: 1.8, Phantom: 1.8, Operator: 1.8, Sheriff: 1.8,
  // 1.5x group, Ghost with an extra 1.1x (1.5 x 1.1 = 1.65x)
  Ghost: 1.65,
  Stinger: 1.5, Spectre: 1.5, Classic: 1.5, Outlaw: 1.5, Guardian: 1.5,
  Bulldog: 1.5, Judge: 1.5, Bucky: 1.5,
};
const DEFAULT_WEAPON_WEIGHT = 1;   // Shorty, Frenzy, Marshal, Ares, Odin, Bandit, Warden
const WEIGHT_FLOOR = 60;

// ---------------------------------------------------------------------------

// Your tier -> a score. S follows your head-to-head order; other tiers use votes as a tie-break.
const tieBreak = name => Math.max(-0.6, Math.min(0.6, ((COMMUNITY[name] ?? NO_VOTE_DATA) - 82) / 20));
const YOUR_OVERRIDES = Object.fromEntries(Object.entries(YOUR_TIERS).map(([name, tier]) => {
  const i = S_ORDER.indexOf(name);
  const score = i !== -1 ? 95 - i * 0.5 : TIER_BASE[tier] + tieBreak(name);
  return [name, Math.round(score * 10) / 10];
}));
const COLLECTIONS = { ...COMMUNITY, ...YOUR_OVERRIDES };
const norm = s => String(s || '').toLowerCase().replace(/ø/g, 'o').replace(/[^a-z0-9]/g, '');

// Longest matching key wins, so "Champions 2021" beats "Champions" and "RGX 11z Pro" beats "RGX".
const COLLECTION_KEYS = Object.keys(COLLECTIONS).sort((a, b) => norm(b).length - norm(a).length);

function findCollection(themeName, skinName) {
  const t = norm(themeName);
  const s = norm(skinName);
  for (const key of COLLECTION_KEYS) {
    const k = norm(key);
    if (k.length <= 3) {
      // Short keys like "ORA" or "VCT" must match the start of a word, not the middle.
      const re = new RegExp(`^${key}\\b`, 'i');
      if (re.test(themeName || '') || re.test(skinName || '')) return key;
    } else if (t.includes(k) || s.startsWith(k)) {
      return key;
    }
  }
  return null;
}

function isFavourite(themeName, skinName) {
  return FAVOURITES.some(f => {
    const k = norm(f);
    if (k.length <= 3) {
      const re = new RegExp(`^${f}\\b`, 'i');
      return re.test(themeName || '') || re.test(skinName || '');
    }
    return norm(themeName).includes(k) || norm(skinName).startsWith(k);
  });
}

// Riot sometimes uses short names ("RES Phantom"). Expand them so matching never misses.
const ALIASES = [[/^\s*RES\b/i, 'Radiant Entertainment System']];
const canon = str => ALIASES.reduce((acc, [re, full]) => acc.replace(re, full), String(str || ''));

const lookupByPrefix = (table, name) => {
  const n = norm(name);
  const hit = Object.entries(table).find(([k]) => n.startsWith(norm(k)));
  return hit ? hit[1] : null;
};

// skins: [{ id, name, weapon, tier, theme }] for every Exclusive/Ultra skin.
// Guns only: knives are left out on purpose, and so are event-only skins (Champions, VCT).
function rankSkins(skins) {
  const scored = skins
    .filter(s => s.weapon !== 'Melee' && !EVENT_ONLY.test(`${s.theme || ''} ${s.name}`))
    .map(orig => {
      const s = { ...orig, name: canon(orig.name), theme: canon(orig.theme) };
      const collection = findCollection(s.theme, s.name);
      const skinTier = lookupByPrefix(SKIN_TIERS, s.name);
      const colTier = collection && YOUR_TIERS[collection] ? YOUR_TIERS[collection] : null;
      let colScore = collection ? COLLECTIONS[collection] : DEFAULT_SCORE;
      if (skinTier) colScore = TIER_BASE[skinTier] + (collection ? tieBreak(collection) : 0);
      const w = WEAPON_WEIGHT[s.weapon] ?? DEFAULT_WEAPON_WEIGHT;
      // Community standout bonus is scaled down: your tiers decide, votes only break ties.
      const base = colScore + (lookupByPrefix(GUN_BONUS, s.name) || 0) * 0.25;
      const score = WEIGHT_FLOOR + (base - WEIGHT_FLOOR) * w;
      const tierKey = skinTier || colTier;
      return {
        ...orig,
        collection: collection || orig.theme || '',
        rated: Boolean(tierKey) || (Boolean(collection) && COLLECTIONS[collection] !== NO_VOTE_DATA),
        yourTier: tierKey ? TIER_LABEL[tierKey] : null,
        favourite: isFavourite(s.theme, s.name),
        score: Math.round(score * 10) / 10,
        list: 'gun',
      };
    });

  const order = (a, b) => b.score - a.score || (b.tier === 'Ultra') - (a.tier === 'Ultra') || a.name.localeCompare(b.name);
  const guns = scored.sort(order);
  guns.forEach((s, i) => { s.rank = i + 1; });
  const byId = Object.fromEntries(guns.map(s => [s.id, s]));
  return { guns, knives: [], byId };
}

// Owned-skin matching (see OWNED above).
const normWords = s => String(s || '').toLowerCase().replace(/ø/g, 'o').split(/[^a-z0-9]+/).filter(Boolean);
const OWNED_RULES = OWNED.map(entry => {
  const words = normWords(entry);
  if (entry.trim().endsWith('*')) return { words: words.filter(w => !/^\d+$/.test(w)), weapon: null };
  return { weapon: words[words.length - 1], words: words.slice(0, -1).filter(w => !/^\d+$/.test(w)) };
});
function isOwned(skin) {
  const hay = normWords(`${skin.name} ${skin.theme || ''}`).join(' ');
  const weapon = String(skin.weapon || '').toLowerCase();
  return OWNED_RULES.some(r => (!r.weapon || r.weapon === weapon || (r.weapon === 'knife' && weapon === 'melee'))
    && r.words.length && r.words.every(w => hay.split(' ').includes(w)));
}

// Spelling-tolerant ("Marshall" = "Marshal").
const gunKey = w => String(w || '').toLowerCase().replace(/l+$/, 'l');
const NEED_KEYS = new Set(NEED_GUNS.map(gunKey));
const needsGun = weapon => NEED_KEYS.has(gunKey(weapon));
const fillsGap = (weapon, tier) => needsGun(weapon) && GAP_TIERS.has(tier);

module.exports = {
  OWNED, isOwned,
  NEED_GUNS, needsGun, fillsGap,
  FAVOURITES, TOP_RANK, MID_REMINDER_H, LAST_CALL_H,
  COLLECTIONS, COMMUNITY, YOUR_OVERRIDES, YOUR_TIERS, SKIN_TIERS, S_ORDER, WEAPON_WEIGHT, rankSkins, findCollection, isFavourite,
};
