// rankings.js - how skins are ranked, and your favourites.
//
// The full skin list and official tiers come live from game data (valorant-api.com)
// on every run, so new bundles appear automatically. Only Exclusive and Ultra skins
// are ranked. Guns are ranked all together; knives get their own list.
//
// How a skin's score is built:
//   guns:   collection score x weapon popularity + standout-skin bonus
//   knives: the knife's own community score (if it has one), else its collection score
// Collection score = YOUR_OVERRIDES if set, otherwise the COMMUNITY consensus.

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
];

// ---- Guns you don't own a Premium-or-better skin for yet ----
// Any Premium, Exclusive or Ultra skin for these gets flagged and pinged once, even if it isn't top-ranked.
// Remove a gun from this list once you've bought a skin for it.
const NEED_GUNS = ['Shorty', 'Frenzy', 'Ghost', 'Spectre', 'Judge', 'Bucky', 'Bandit', 'Outlaw',
  'Bulldog', 'Marshal', 'Operator', 'Warden'];
const GAP_TIERS = new Set(['Premium', 'Exclusive', 'Ultra']);

// ---- Reminder rules ----
const TOP_RANK = 50;        // ranks 1-50 (in their list) get reminded twice a day
const MID_REMINDER_H = 12;  // 2nd reminder when this many hours are left in the store
const LAST_CALL_H = 3;      // favourites also get a last-chance ping this close to reset

// ---- Your own tier corrections (these win over the community scores) ----
// S = 91-95, A+ = 87-90, A = 82-86, B = 76-81, C = below 76.
// Delete a line to go back to the community score for that collection.
const YOUR_OVERRIDES = {
  'Ayakashi': 93,          // S   (votes: A+, 88)
  'ORA': 93,               // S   (votes: B, 76)
  'Prelude to Chaos': 91,  // S   (votes: S, 95)
  'Champions 2024': 91,    // S   (votes: S, 92)
  'Champions 2025': 91,    // S   (votes: A+, 88)
  'Champions 2026': 91,    // S   (no vote data yet)
  'Elderflame': 89,        // A+  (votes: A, 83)
  'Neo Frontier': 87,      // A+  (votes: A, 82)
  'Bubblegum Deathwish': 87, // A+ (no vote data)
  'Champions 2021': 85,    // A   (votes: S, 94)
};

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
const WEAPON_WEIGHT = {
  Vandal: 1.0, Phantom: 1.0, Operator: 0.85, Sheriff: 0.8, Ghost: 0.75,
  Spectre: 0.7, Classic: 0.6, Marshal: 0.55, Outlaw: 0.55, Bulldog: 0.5,
  Guardian: 0.5, Judge: 0.45, Frenzy: 0.45, Stinger: 0.45, Odin: 0.45,
  Ares: 0.4, Shorty: 0.4, Bucky: 0.4,
};
const DEFAULT_WEAPON_WEIGHT = 0.45;

// ---------------------------------------------------------------------------

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

const lookupByPrefix = (table, name) => {
  const n = norm(name);
  const hit = Object.entries(table).find(([k]) => n.startsWith(norm(k)));
  return hit ? hit[1] : null;
};

// skins: [{ id, name, weapon, tier, theme }] for every Exclusive/Ultra skin.
// Returns { guns, knives } ranked lists and byId lookup with rank info.
function rankSkins(skins) {
  const scored = skins.map(s => {
    const collection = findCollection(s.theme, s.name);
    const colScore = collection ? COLLECTIONS[collection] : DEFAULT_SCORE;
    const knife = s.weapon === 'Melee';
    let score;
    if (knife) {
      const own = lookupByPrefix(KNIFE_SCORES, s.name);
      // If you overrode the collection, shift its knife by the same amount.
      const shift = collection && collection in YOUR_OVERRIDES && collection in COMMUNITY
        ? YOUR_OVERRIDES[collection] - COMMUNITY[collection] : 0;
      score = own !== null ? own + shift : colScore;
    } else {
      const w = WEAPON_WEIGHT[s.weapon] ?? DEFAULT_WEAPON_WEIGHT;
      score = colScore * (0.6 + 0.4 * w) + (lookupByPrefix(GUN_BONUS, s.name) || 0);
    }
    return {
      ...s,
      collection: collection || s.theme || '',
      rated: Boolean(collection) && (COLLECTIONS[collection] !== NO_VOTE_DATA || collection in YOUR_OVERRIDES),
      favourite: isFavourite(s.theme, s.name),
      score: Math.round(score * 10) / 10,
      list: knife ? 'knife' : 'gun',
    };
  });

  const order = (a, b) => b.score - a.score || (b.tier === 'Ultra') - (a.tier === 'Ultra') || a.name.localeCompare(b.name);
  const guns = scored.filter(s => s.list === 'gun').sort(order);
  const knives = scored.filter(s => s.list === 'knife').sort(order);
  guns.forEach((s, i) => { s.rank = i + 1; });
  knives.forEach((s, i) => { s.rank = i + 1; });

  const byId = Object.fromEntries([...guns, ...knives].map(s => [s.id, s]));
  return { guns, knives, byId };
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
  COLLECTIONS, COMMUNITY, YOUR_OVERRIDES, WEAPON_WEIGHT, rankSkins, findCollection, isFavourite,
};
