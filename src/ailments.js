// Damage type + ailment system.
//
// Damage types are derived from a Path of Exile-style model: physical is the
// default base damage type for every attack, with elemental/chaos types layered
// on top via per-source damage breakdowns.
//
// Ailments are applied based on the *threat ratio* of a hit (hit damage relative
// to enemy max HP). Stronger hits relative to the target's HP have a higher
// chance to apply, and apply with greater magnitude/duration. Bosses and elites
// resist hard-disabling ailments (freeze).

export const DAMAGE_TYPES = ["physical", "fire", "cold", "lightning", "chaos"];

// Each ailment is gated by a damage type (which damage flavour the hit must
// contain to roll for the ailment) and a base threshold ratio. The threshold
// ratio is `hitDamage / enemyMaxHp` required for the ailment to apply with
// "full" strength (chance = chanceMax, magnitude = magnitudeMax, duration =
// durationMax). Smaller hits scale chance/magnitude/duration linearly down to
// the floor.
//
// Hard ailments (freeze) additionally require a *boss-resistance-adjusted*
// threshold so that small hits cannot trivially perma-CC bosses.
export const AILMENT_CONFIG = {
  bleed: {
    sources: ["physical"],
    threshold: 0.18,
    chanceFloor: 0.05,
    chanceMax: 0.85,
    durationMin: 1.5,
    durationMax: 5,
    tickRate: 0.25,
    // Bleed deals 70% of the physical hit as DOT over duration; doubled while
    // the enemy is moving.
    dotFraction: 0.7,
    movingBonus: 2,
    stack: false,
  },
  poison: {
    sources: ["physical", "chaos"],
    threshold: 0.12,
    chanceFloor: 0.05,
    chanceMax: 0.7,
    durationMin: 2,
    durationMax: 6,
    tickRate: 0.4,
    dotFraction: 0.3,
    stack: true,
    maxStacks: 8,
  },
  ignite: {
    sources: ["fire"],
    threshold: 0.15,
    chanceFloor: 0.05,
    chanceMax: 0.9,
    durationMin: 1.5,
    durationMax: 4,
    tickRate: 0.25,
    dotFraction: 0.9,
    stack: false,
  },
  chill: {
    sources: ["cold"],
    threshold: 0.05,
    chanceFloor: 0.5,
    chanceMax: 1,
    durationMin: 1.5,
    durationMax: 3,
    magnitudeMin: 0.1,
    magnitudeMax: 0.3,
    stack: false,
  },
  freeze: {
    sources: ["cold"],
    threshold: 0.45,
    chanceFloor: 0.05,
    chanceMax: 0.6,
    durationMin: 0.4,
    durationMax: 2.5,
    bossResistance: 4,
    eliteResistance: 1.6,
    stack: false,
  },
  shock: {
    sources: ["lightning"],
    threshold: 0.08,
    chanceFloor: 0.4,
    chanceMax: 1,
    durationMin: 1.5,
    durationMax: 3,
    magnitudeMin: 0.1,
    magnitudeMax: 0.5,
    stack: false,
  },
  scorch: {
    sources: ["fire"],
    threshold: 0.06,
    chanceFloor: 0.3,
    chanceMax: 0.9,
    durationMin: 2,
    durationMax: 4,
    magnitudeMin: 0.1,
    magnitudeMax: 0.3,
    stack: false,
  },
  brittle: {
    sources: ["cold"],
    threshold: 0.06,
    chanceFloor: 0.25,
    chanceMax: 0.85,
    durationMin: 2,
    durationMax: 4,
    magnitudeMin: 0.05,
    magnitudeMax: 0.15,
    stack: false,
  },
  sap: {
    sources: ["lightning"],
    threshold: 0.05,
    chanceFloor: 0.4,
    chanceMax: 1,
    durationMin: 2,
    durationMax: 4,
    magnitudeMin: 0.05,
    magnitudeMax: 0.2,
    stack: false,
  },
};

const HARD_DISABLE_AILMENTS = new Set(["freeze"]);

// Frozen iteration order for AILMENT_CONFIG. Hot paths use this instead of
// Object.keys(AILMENT_CONFIG) to avoid an array allocation per hit/per frame.
// Order MUST match insertion order in AILMENT_CONFIG so RNG-driven rolls
// remain deterministic across versions.
const AILMENT_NAMES = ["bleed", "poison", "ignite", "chill", "freeze", "shock", "scorch", "brittle", "sap"];

export function emptyAilmentState() {
  return {};
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function computeRollStrength(name, cfg, hitDamage, enemyMaxHp, rank) {
  if (!hitDamage || !enemyMaxHp) return 0;
  let threshold = cfg.threshold;
  if (rank === "boss" && cfg.bossResistance) threshold *= cfg.bossResistance;
  else if (rank === "elite" && cfg.eliteResistance) threshold *= cfg.eliteResistance;
  const ratio = hitDamage / Math.max(1, enemyMaxHp);
  return clamp01(ratio / threshold);
}

function pickDamageOfTypes(breakdown, totalDamage, types) {
  if (!breakdown) {
    // Legacy hits with no breakdown only carry physical.
    return types.indexOf("physical") >= 0 ? totalDamage : 0;
  }
  let sum = 0;
  for (let i = 0; i < types.length; i += 1) sum += breakdown[types[i]] ?? 0;
  return sum;
}

// Apply ailment rolls for a single hit. Mutates `enemy.ailments`.
// `hit` shape: { damage, damageType?, breakdown?, ownerId? }
export function applyAilmentsFromHit(enemy, hit, rng) {
  if (!enemy || !hit || !(hit.damage > 0) || enemy.hp <= 0) return;
  if (!enemy.ailments) enemy.ailments = {};
  const breakdown = hit.breakdown ?? null;
  const fallbackType = hit.damageType ?? "physical";
  const enemyMaxHp = enemy.maxHp;
  const enemyRank = enemy.rank;
  for (let ni = 0; ni < AILMENT_NAMES.length; ni += 1) {
    const name = AILMENT_NAMES[ni];
    const cfg = AILMENT_CONFIG[name];
    const sources = cfg.sources;
    let typedDamage = breakdown
      ? pickDamageOfTypes(breakdown, hit.damage, sources)
      : sources.indexOf(fallbackType) >= 0
        ? hit.damage
        : 0;
    if (typedDamage <= 0) continue;
    if (name === "poison" && hit.poisonDotMultiplier > 0 && hit.poisonDotMultiplier !== 1) {
      typedDamage *= hit.poisonDotMultiplier;
    }
    if (name === "ignite" && hit.igniteDotMultiplier > 0 && hit.igniteDotMultiplier !== 1) {
      typedDamage *= hit.igniteDotMultiplier;
    }
    const strength = computeRollStrength(name, cfg, typedDamage, enemyMaxHp, enemyRank);
    if (strength <= 0) continue;
    const chance = lerp(cfg.chanceFloor, cfg.chanceMax, strength);
    if (rng.next() >= chance) continue;
    const duration = lerp(cfg.durationMin, cfg.durationMax, strength);
    let magnitude =
      cfg.magnitudeMin !== undefined ? lerp(cfg.magnitudeMin, cfg.magnitudeMax, strength) : 0;
    if (name === "scorch" && hit.scorchMagnitudeBonus > 0 && magnitude > 0) {
      magnitude += hit.scorchMagnitudeBonus;
    } else if (name === "brittle" && hit.brittleMagnitudeBonus > 0) {
      magnitude = Math.min(1, magnitude + hit.brittleMagnitudeBonus);
    } else if (name === "shock" && hit.shockMagnitudeBonus > 0) {
      // Additive bonus, capped at 1.0 so shocked enemies never take >2x damage.
      magnitude = Math.min(1, magnitude + hit.shockMagnitudeBonus);
    } else if (name === "sap" && hit.sapMagnitudeBonus > 0) {
      // Additive bonus, capped at 0.6 so sap can never zero out enemy damage.
      magnitude = Math.min(0.6, magnitude + hit.sapMagnitudeBonus);
    }
    const dotTotal = cfg.dotFraction ? typedDamage * cfg.dotFraction : 0;
    const dotPerSecond = duration > 0 ? dotTotal / duration : 0;
    const maxStacksOverride =
      name === "poison" && hit.poisonMaxStacks > 0 ? hit.poisonMaxStacks : 0;
    applyAilment(
      enemy,
      name,
      cfg,
      duration,
      magnitude,
      dotPerSecond,
      hit.ownerId ?? null,
      maxStacksOverride,
    );
  }
}

function applyAilment(enemy, name, cfg, duration, magnitude, dotPerSecond, ownerId, maxStacksOverride) {
  const tickRate = cfg.tickRate ?? 0.25;
  if (cfg.stack) {
    if (!enemy.ailments[name]) enemy.ailments[name] = { stacks: [] };
    const stacks = enemy.ailments[name].stacks;
    stacks.push({
      remaining: duration,
      tickAccumulator: 0,
      tickRate,
      dotPerSecond,
      magnitude,
      ownerId,
    });
    const cap = maxStacksOverride > 0 ? maxStacksOverride : cfg.maxStacks;
    if (cap && stacks.length > cap) {
      stacks.sort((a, b) => a.dotPerSecond - b.dotPerSecond);
      stacks.splice(0, stacks.length - cap);
    }
    enemy._hasActiveAilments = true;
    return;
  }
  const existing = enemy.ailments[name];
  // Replace if new instance is stronger (longer remaining or higher dps/magnitude).
  const newStrength = (dotPerSecond || 0) + (magnitude || 0) * 10;
  const oldStrength = existing
    ? (existing.dotPerSecond || 0) + (existing.magnitude || 0) * 10
    : -Infinity;
  if (!existing || newStrength >= oldStrength || (existing.remaining ?? 0) < duration * 0.5) {
    enemy.ailments[name] = {
      remaining: duration,
      tickAccumulator: 0,
      tickRate,
      dotPerSecond,
      magnitude,
      ownerId,
    };
  } else if (existing) {
    existing.remaining = Math.max(existing.remaining, duration);
  }
  enemy._hasActiveAilments = true;
}

// Tick all DOTs and decay durations. Calls simulation.damageEnemy with
// {fromAilment:true} for damage so we don't recurse into ailment rolls.
export function updateAilments(simulation, enemy, dt) {
  const ailments = enemy.ailments;
  if (!ailments) return;
  // Fast bail when the enemy has no active ailments — the common case for the
  // bulk of enemies on screen. Avoids an Object.keys allocation per enemy
  // per frame. The _hasActiveAilments flag in simulation hot paths short-
  // circuits the call entirely; this is a redundancy guard for direct callers.
  let hasAny = false;
  for (const k in ailments) { hasAny = true; break; }
  if (!hasAny) {
    enemy._hasActiveAilments = false;
    return;
  }
  for (let ni = 0; ni < AILMENT_NAMES.length; ni += 1) {
    const name = AILMENT_NAMES[ni];
    const entry = ailments[name];
    if (!entry) continue;
    if (entry.stacks) {
      const stacks = entry.stacks;
      let writeIdx = 0;
      for (let j = 0; j < stacks.length; j += 1) {
        const stack = stacks[j];
        tickStack(simulation, enemy, name, stack, dt);
        if (stack.remaining > 0) {
          if (writeIdx !== j) stacks[writeIdx] = stack;
          writeIdx += 1;
        }
      }
      if (writeIdx !== stacks.length) stacks.length = writeIdx;
      if (!writeIdx) delete ailments[name];
    } else {
      tickStack(simulation, enemy, name, entry, dt);
      if (entry.remaining <= 0) delete ailments[name];
    }
  }
  // Refresh the cached "any active ailment" flag so simulation hot paths
  // (updateEnemyStatusDamage, updateEnemies) can skip the call entirely on
  // the next frame when this enemy has no active ailments.
  let stillAny = false;
  for (const k in ailments) { stillAny = true; break; }
  enemy._hasActiveAilments = stillAny;
}

function tickStack(simulation, enemy, name, stack, dt) {
  stack.remaining -= dt;
  if (stack.dotPerSecond > 0 && enemy.hp > 0) {
    stack.tickAccumulator = (stack.tickAccumulator || 0) + dt;
    const tickRate = stack.tickRate || 0.25;
    while (stack.tickAccumulator >= tickRate && enemy.hp > 0) {
      stack.tickAccumulator -= tickRate;
      let tickDamage = stack.dotPerSecond * tickRate;
      // Bleed ramps up if enemy is moving.
      if (name === "bleed" && (enemy.speed ?? 0) > 0) {
        const cfg = AILMENT_CONFIG.bleed;
        tickDamage *= cfg.movingBonus ?? 1;
      }
      simulation.damageEnemy(enemy, tickDamage, {
        ownerId: stack.ownerId,
        x: enemy.x,
        y: enemy.y,
        vx: 0,
        vy: 0,
        allowSubUnitDamage: true,
        ignoreArmor: true,
        fromAilment: true,
        ailment: name,
      });
    }
  }
}

// Speed multiplier applied by chill/freeze. Returns a value in [0, 1].
export function getAilmentSpeedMultiplier(enemy) {
  const ail = enemy.ailments;
  if (!ail) return 1;
  let mult = 1;
  if (ail.chill) mult *= 1 - (ail.chill.magnitude || 0);
  if (ail.freeze && ail.freeze.remaining > 0) mult = 0;
  if (ail.sap) mult *= 1; // sap affects damage dealt, not movement
  return mult < 0 ? 0 : mult;
}

// Damage-taken multiplier applied by shock (and brittle for crit-like effects
// where crit isn't routed through enemy state — exposed here so callers can
// query). Also folds in scorch as an extra fire-damage-taken bonus when the
// caller passes the damage type.
export function getAilmentDamageTakenMultiplier(enemy, damageType) {
  const ail = enemy.ailments;
  if (!ail) return 1;
  let mult = 1;
  if (ail.shock) mult *= 1 + (ail.shock.magnitude || 0);
  if (damageType === "fire" && ail.scorch) mult *= 1 + (ail.scorch.magnitude || 0);
  return mult;
}

// Outgoing damage multiplier for sapped enemies (when enemies do damage).
export function getAilmentOutgoingDamageMultiplier(enemy) {
  const ail = enemy.ailments;
  if (!ail || !ail.sap) return 1;
  return 1 - (ail.sap.magnitude || 0);
}

// Returns true if enemy is fully frozen (cannot move/act).
export function isFrozen(enemy) {
  return !!(enemy.ailments && enemy.ailments.freeze && enemy.ailments.freeze.remaining > 0);
}

// Crit-chance bonus from brittle. Returns additive crit chance (0..1).
export function getAilmentCritChanceBonus(enemy) {
  const ail = enemy && enemy.ailments;
  if (!ail || !ail.brittle) return 0;
  return ail.brittle.magnitude || 0;
}

// Ordered list of ailments to display. Order in this array IS the canonical
// render priority — earlier entries draw first and survive truncation.
// Field reference (consumed by getActiveAilmentDisplay / drawAilmentPips and
// available to future tooltip/HUD code):
//   shortLabel     single glyph used by compact pip rendering
//   label          longer tag for tooltips/HUD
//   priority       1 = highest. Lower = more important; survives +N truncation
//   category       "control" | "dot" | "debuff" — drives visual emphasis
//   showStackCount opt-in to numeric stack badges (currently poison only)
export const AILMENT_DISPLAY = [
  { name: "freeze",  label: "FRZ", shortLabel: "F", color: "#bff4ff", priority: 1, category: "control", showStackCount: false },
  { name: "shock",   label: "SHK", shortLabel: "S", color: "#ffe66b", priority: 2, category: "control", showStackCount: false },
  { name: "chill",   label: "CHL", shortLabel: "c", color: "#7ed1ff", priority: 3, category: "control", showStackCount: false },
  { name: "ignite",  label: "IGN", shortLabel: "I", color: "#ff7a3a", priority: 4, category: "dot",     showStackCount: false },
  { name: "bleed",   label: "BLD", shortLabel: "B", color: "#ff5a73", priority: 5, category: "dot",     showStackCount: false },
  { name: "poison",  label: "PSN", shortLabel: "P", color: "#a8ff5a", priority: 6, category: "dot",     showStackCount: true  },
  { name: "brittle", label: "BRT", shortLabel: "b", color: "#cfe7ff", priority: 7, category: "debuff",  showStackCount: false },
  { name: "scorch",  label: "SCR", shortLabel: "x", color: "#ffb27a", priority: 8, category: "debuff",  showStackCount: false },
  { name: "sap",     label: "SAP", shortLabel: "s", color: "#ffd76b", priority: 9, category: "debuff",  showStackCount: false },
];

// Validate AILMENT_CONFIG (and matching display entries) for common config
// mistakes. Returns an array of human-readable error strings; empty array
// means the config is valid. Intended for tests / dev-mode startup — not
// called from runtime hot paths.
export function validateAilmentConfig(
  config = AILMENT_CONFIG,
  display = AILMENT_DISPLAY,
  { allowedDisplayOnly = [] } = {},
) {
  const errors = [];
  const validTypes = new Set(DAMAGE_TYPES);
  const configNames = new Set(Object.keys(config));
  const displayNames = new Set(display.map((d) => d.name));

  for (const [name, cfg] of Object.entries(config)) {
    if (!Array.isArray(cfg.sources) || cfg.sources.length === 0) {
      errors.push(`${name}: sources must be a non-empty array`);
    } else {
      for (const t of cfg.sources) {
        if (!validTypes.has(t)) errors.push(`${name}: unknown damage type "${t}" in sources`);
      }
    }
    if (!(cfg.threshold > 0)) errors.push(`${name}: threshold must be > 0`);
    if (!(cfg.chanceFloor >= 0 && cfg.chanceFloor <= 1))
      errors.push(`${name}: chanceFloor must be in [0,1]`);
    if (!(cfg.chanceMax >= 0 && cfg.chanceMax <= 1))
      errors.push(`${name}: chanceMax must be in [0,1]`);
    if (cfg.chanceFloor > cfg.chanceMax)
      errors.push(`${name}: chanceFloor (${cfg.chanceFloor}) > chanceMax (${cfg.chanceMax})`);
    if (!(cfg.durationMin >= 0)) errors.push(`${name}: durationMin must be >= 0`);
    if (!(cfg.durationMax >= 0)) errors.push(`${name}: durationMax must be >= 0`);
    if (cfg.durationMin > cfg.durationMax)
      errors.push(`${name}: durationMin (${cfg.durationMin}) > durationMax (${cfg.durationMax})`);
    const hasMagMin = cfg.magnitudeMin !== undefined;
    const hasMagMax = cfg.magnitudeMax !== undefined;
    if (hasMagMin !== hasMagMax)
      errors.push(`${name}: magnitudeMin and magnitudeMax must both be set or both omitted`);
    if (hasMagMin && hasMagMax && cfg.magnitudeMin > cfg.magnitudeMax)
      errors.push(`${name}: magnitudeMin > magnitudeMax`);
    if (cfg.stack && !(cfg.maxStacks >= 1))
      errors.push(`${name}: stacking ailment must define maxStacks >= 1`);
    if (cfg.tickRate !== undefined && !(cfg.tickRate > 0))
      errors.push(`${name}: tickRate must be > 0 when set`);
    if (cfg.dotFraction !== undefined && !(cfg.dotFraction >= 0))
      errors.push(`${name}: dotFraction must be >= 0`);
    if (!displayNames.has(name)) errors.push(`${name}: missing AILMENT_DISPLAY entry`);
  }

  const allowed = new Set(allowedDisplayOnly);
  for (const entry of display) {
    if (!configNames.has(entry.name) && !allowed.has(entry.name)) {
      errors.push(`display "${entry.name}": no matching AILMENT_CONFIG entry`);
    }
    if (!entry.label) errors.push(`display "${entry.name}": missing label`);
    if (!entry.color) errors.push(`display "${entry.name}": missing color`);
  }
  return errors;
}

// Pure helper: returns the active display entries for an enemy in render
// (priority) order. Each entry is a plain object containing both the display
// metadata (label/shortLabel/color/priority/category) and live state derived
// from the enemy's ailments (stacks, remaining, magnitude). Safe for tests
// and UI/tooltip consumers — does not depend on canvas or render state.
export function getActiveAilmentDisplay(enemy) {
  const ail = enemy && enemy.ailments;
  if (!ail) return [];
  const out = [];
  for (const entry of AILMENT_DISPLAY) {
    const a = ail[entry.name];
    if (!a) continue;
    let stacks;
    let remaining;
    let magnitude;
    if (a.stacks) {
      if (!Array.isArray(a.stacks) || a.stacks.length === 0) continue;
      stacks = a.stacks.length;
      remaining = a.stacks.reduce((m, s) => Math.max(m, s?.remaining ?? 0), 0);
      magnitude = a.stacks[0]?.magnitude ?? 0;
    } else {
      remaining = a.remaining ?? 0;
      if (remaining <= 0) continue;
      stacks = 1;
      magnitude = a.magnitude ?? 0;
    }
    out.push({
      id: entry.name,
      name: entry.name,
      label: entry.label,
      shortLabel: entry.shortLabel,
      color: entry.color,
      priority: entry.priority,
      category: entry.category,
      isControl: entry.category === "control",
      isDot: entry.category === "dot",
      isDebuff: entry.category === "debuff",
      showStackCount: !!entry.showStackCount && stacks > 1,
      stacks,
      remaining,
      magnitude,
    });
  }
  return out;
}

// Pure helper: clamp a display list to `maxVisible` entries and report how
// many were dropped. Intended for compact pip rendering or HUDs that want a
// "+N" overflow indicator. Lower-priority entries (later in AILMENT_DISPLAY)
// are dropped first since `getActiveAilmentDisplay` returns priority order.
export function truncateAilmentDisplay(entries, maxVisible) {
  if (!Array.isArray(entries)) return { visible: [], overflow: 0 };
  if (!(maxVisible > 0) || entries.length <= maxVisible) {
    return { visible: entries, overflow: 0 };
  }
  return {
    visible: entries.slice(0, maxVisible),
    overflow: entries.length - maxVisible,
  };
}
