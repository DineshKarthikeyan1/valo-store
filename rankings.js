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

// ---- Reminder rules ----
const TOP_RANK = 50;        // ranks 1-50 (in their list) get reminded twice a day
const MID_REMINDER_H = 12;  // 2nd reminder when this many hours are left in the store
const LAST_CALL_H = 3;      // favourites also get a last-chance ping this close to reset

// ---- Your own tier corrections (these win over the community scores) ----
// S = 91-95, A+ = 87-90, A = 82-86, B = 76-81, C = below 76.
// Delete a line to go back to the community score for that collection.
const YOUR_OVERRIDES = {
  'Ayakashi': 93,          // S   (community: A, 86)
  'ORA': 93,               // S   (community: C, 73)
  'Prelude to Chaos': 91,  // S   (community: S, 91 - agrees)
  'Champions 2024': 91,    // S   (community: S, 91 - agrees)
  'Champions 2025': 91,    // S   (community: A+, 87)
  'Champions 2026': 91,    // S   (community: A, 85)
  'Elderflame': 89,        // A+  (community: S, 92)
  'Neo Frontier': 87,      // A+  (community: B, 78)
  'Bubblegum Deathwish': 87, // A+ (community: C, 74)
  'Champions 2021': 85,    // A   (community: S, 94)
};

// ---- Community consensus collection scores (0-100) ----
// Built from 16 rankings (Nov 2026): ranked articles and tier lists from 2025-26,
// the VLR.gg community skinline ranking, Premate live popularity data, popularity/sales
// rankings, and several knife tier lists. Collections near the top of many lists score
// high; polarising ones (top in some, bottom in others) land in the middle.
// "limited data" = released in 2026, too new for most rankings.
const DEFAULT_SCORE = 75;
const COMMUNITY = {
  // S
  'RGX 11z Pro': 95,         // top 3 in almost every list
  'Champions 2021': 94,      // Vandal + Karambit are all-time favourites
  'Glitchpop': 93,
  'Elderflame': 92,          // most popular bundle by sales; a few lists dislike it
  'Kuronami': 92,
  'Prelude to Chaos': 91,    // #1 Vandal on Premate popularity
  'Champions 2024': 91,      // #1 Phantom on Premate popularity
  // A+
  'Champions 2023': 90,
  'Araxys': 90,
  'Champions 2022': 90,
  'Protocol 781-A': 88,
  'Sentinels of Light': 88,
  'Champions 2025': 87,
  'Spectrum': 87,            // Phantom and Waveform rated highly; rest of bundle mid
  // A
  'Radiant Entertainment System': 86,
  'Ayakashi': 86,            // #3 Phantom on Premate popularity; limited data (2026)
  'Primordium': 86,
  'ChronoVoid': 85,          // polarising: top-2 Vandal in some lists, "bad" in others
  'Champions 2026': 85,      // limited data
  'EX.O': 84,                // called the best release of 2025 in one review
  'Singularity': 83,
  'Mystbloom': 83,
  'CYRAX': 82,
  'Evori Dreamwings': 82,
  // B
  'Nocturnum': 81,
  'Ruination': 81,
  'Doombringer': 80,
  'Imperium': 79,
  'Overdrive': 79,
  'Neo Frontier': 78,
  'Aeris': 78,               // limited data
  'Blackspyre': 78,          // limited data
  'Arcane': 77,
  'Blackthorn': 77,          // limited data
  'Popmonz': 77,             // limited data (Oct 2026)
  'Magepunk': 76,
  'Divergence': 76,
  'Holo Meridian': 76,       // limited data
  'Rogue': 76,               // limited data
  // C
  'BlastX': 75,
  'Bubblegum Deathwish': 74, // listed among 2025's least impressive
  'Phaseguard': 74,          // listed among 2025's least impressive
  'ORA': 73,                 // listed among 2025's least impressive / worst tier
  "Dolmir's Revenge": 70,
  'SplashX': 70,
  'Ignite': 62,
  'VCT': 55,
};

// ---- Individual gun skins the community rates above their own collection ----
const GUN_BONUS = {
  'Spectrum Phantom': 4,
  'Protocol 781-A Phantom': 3,
  'Radiant Entertainment System Phantom': 3,
  'Ayakashi Phantom': 3,
  'Champions 2024 Phantom': 3,
  'Champions 2022 Phantom': 2,
  'Champions 2023 Vandal': 3,
  'Champions 2021 Vandal': 2,
  'ChronoVoid Vandal': 3,
  'Araxys Vandal': 3,
  'Kuronami Vandal': 2,
  'Prelude to Chaos Vandal': 3,
  'Primordium Vandal': 2,
  'Primordium Phantom': 2,
  'Nocturnum Phantom': 3,
  'RGX 11z Pro Vandal': 2,
  'Elderflame Vandal': 2,
  'Elderflame Operator': 3,
  'Glitchpop Phantom': 1,
};

// ---- Knife community scores (knives are judged on their own, not by bundle) ----
const KNIFE_SCORES = {
  'Kuronami no Yaiba': 96,
  'Champions 2021 Karambit': 95,
  'RGX 11z Pro Blade': 93,
  'Champions 2022 Butterfly': 93,
  'Glitchpop Dagger': 92,
  'Blades of Primordia': 92,
  'EX.O Edge': 90,
  'Champions 2023 Kunai': 88,
  'Elderflame Dagger': 88,
  'Mystbloom Kunai': 87,
  'Nocturnum Scythe': 85,
  'RGX 11z Pro Firefly': 85,
  'Waveform': 85,
  'Ruin Dagger': 83,
  'Araxys Bio Harvester': 80,
  'Singularity Butterfly': 80,
  'Blade of Chaos': 78,
  'Personal Administrative Melee Unit': 76,
  'Blade of Imperium': 75,
  'Terminus A Quo': 74,
  'Glitchpop Axe': 74,
  'Magepunk Sparkswitch': 70,
  'Overdrive Blade': 69,
  'NEO Frontier Axe': 68,
  'BlastX Polymer': 66,
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
      rated: Boolean(collection),
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

module.exports = {
  FAVOURITES, TOP_RANK, MID_REMINDER_H, LAST_CALL_H,
  COLLECTIONS, COMMUNITY, YOUR_OVERRIDES, WEAPON_WEIGHT, rankSkins, findCollection, isFavourite,
};
