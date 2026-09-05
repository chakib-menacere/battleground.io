// Shared between client and server — keep authoritative gameplay numbers in one place.
export const TICK_RATE = 30; // server simulation steps per second
export const PLAYER_SPEED = 6; // units/sec
export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_MAX_HEALTH = 100;
export const RESPAWN_TIME_MS = 3000;
export const GUN_DAMAGE = 20;
export const GUN_RANGE = 100;
export const GUN_FIRE_COOLDOWN_MS = 150;

export const STARTING_MONEY = 800;
export const KILL_REWARD = 200;

// Shop — purchasable only while in the lobby (pre-deploy), like Valorant's buy phase. A
// purchase persists across respawns for the rest of the session (no round resets here).
export const SHOP_WEAPONS = [
  { id: 'rifle', name: 'Rifle', cost: 0, damage: 20, fireCooldownMs: 150, range: 100, magSize: 30 },
  { id: 'pistol', name: 'Light Pistol', cost: 200, damage: 14, fireCooldownMs: 90, range: 80, magSize: 12 },
  { id: 'heavy', name: 'Heavy Rifle', cost: 500, damage: 35, fireCooldownMs: 230, range: 120, magSize: 20 },
];
export const DEFAULT_WEAPON_ID = 'rifle';
export const ARMOR_COST = 650;
export const ARMOR_DAMAGE_REDUCTION = 0.25; // fraction of incoming damage absorbed

// Ammo: each weapon has its own magazine; reloading refills it from a reserve pool sized as
// a multiple of the mag. Switching weapons (a new purchase) resets both to full.
export const RESERVE_MAG_MULTIPLIER = 3;
export const RELOAD_TIME_MS = 1600;

export const GROUND_Y = 1; // baseline feet height used by spawn points and gravity
export const GRAVITY = -20; // units/sec^2
export const JUMP_VELOCITY = 7.5;

// How close (in world units) the player's height must already be to a surface's top before
// getGroundLevel() will snap them onto it — see shared/movement.js. A normal jump's apex is
// ~1.4 units above GROUND_Y, so this lets a jump mantle the cover boxes (up to ~2.4 tall)
// while keeping the much taller jump-pad platforms out of reach without the pad's boost.
export const MANTLE_TOLERANCE = 0.5;

export const CROUCH_SPEED_MULT = 0.5;
export const STAND_EYE_HEIGHT = 1.7;
export const CROUCH_EYE_HEIGHT = 1.1;
export const STAND_HIT_CENTER = 0.9; // hitbox sphere center offset above feet, standing
export const CROUCH_HIT_CENTER = 0.55; // hitbox sphere center offset above feet, crouched

export const SLIDE_SPEED = 11; // initial slide speed, decays to crouch speed over the slide
export const SLIDE_DURATION_MS = 550;
export const SLIDE_MIN_INPUT = 0.1; // must have some movement input to trigger a slide

export const ARENA_HALF_SIZE = 40; // flat ground is an 80x80 square centered at origin

// Valorant-style layout: two open "sites" (north/south) connected by a walled mid corridor,
// with a forward mid structure (the central PLATFORMS tower) and flank crates along the
// jump-pad routes on the east/west edges.
export const COVER_BOXES = [
  // Mid corridor walls — a chokepoint funnel running under the central tower.
  { x: 5, z: 0, sx: 1, sy: 2.4, sz: 24 },
  { x: -5, z: 0, sx: 1, sy: 2.4, sz: 24 },

  // Site A (north)
  { x: 10, z: 30, sx: 2, sy: 1.6, sz: 2 },
  { x: -10, z: 30, sx: 2, sy: 1.6, sz: 2 },
  { x: 0, z: 35, sx: 8, sy: 1.4, sz: 1 },
  { x: 16, z: 26, sx: 1, sy: 2.4, sz: 12 },
  { x: -16, z: 26, sx: 1, sy: 2.4, sz: 12 },

  // Site B (south)
  { x: 10, z: -30, sx: 2, sy: 1.6, sz: 2 },
  { x: -10, z: -30, sx: 2, sy: 1.6, sz: 2 },
  { x: 0, z: -35, sx: 8, sy: 1.4, sz: 1 },
  { x: 16, z: -26, sx: 1, sy: 2.4, sz: 12 },
  { x: -16, z: -26, sx: 1, sy: 2.4, sz: 12 },

  // Flank crates along the east/west jump-pad routes
  { x: 30, z: 14, sx: 3, sy: 2, sz: 3 },
  { x: -30, z: -14, sx: 3, sy: 2, sz: 3 },
  { x: 30, z: -14, sx: 3, sy: 2, sz: 3 },
  { x: -30, z: 14, sx: 3, sy: 2, sz: 3 },
];

export const SPAWN_POINTS = [
  { x: 32, y: 1, z: 32 },
  { x: -32, y: 1, z: 32 },
  { x: 32, y: 1, z: -32 },
  { x: -32, y: 1, z: -32 },
  { x: 0, y: 1, z: 32 },
  { x: 0, y: 1, z: -32 },
  { x: 32, y: 1, z: 0 },
  { x: -32, y: 1, z: 0 },
];

// Players spawn in a safe lobby, well clear of the arena's walled boundary (a good long walk
// of open ground separates the two), and must walk into the portal to deploy. The per-zone
// clamp (see clampToLobby/clampToArena) keeps lobby players from ever reaching the arena on
// foot regardless of the gap — the portal teleport is the only way in.
export const LOBBY_CENTER = { x: 0, z: -115 };
export const LOBBY_HALF_SIZE = 8;

export const LOBBY_SPAWN_POINTS = [
  { x: -3, y: 1, z: -118 },
  { x: 3, y: 1, z: -118 },
  { x: -3, y: 1, z: -112 },
  { x: 3, y: 1, z: -112 },
  { x: 0, y: 1, z: -120 },
];

export const PORTAL_POSITION = { x: 0, y: 1.1, z: -109 };
export const PORTAL_RADIUS = 1.8;

// The shop kiosk sits in the lobby, off to the side of the spawn cluster and portal path.
// Buying is proximity-gated to standing near it (see SHOP_RADIUS), not a global menu.
export const SHOP_POSITION = { x: -6, z: -115 };
export const SHOP_RADIUS = 3;

// Jump pads: standing on one while grounded launches the player upward, much higher than a
// normal jump. Same server-authoritative + client-predicted pattern as jump/slide.
export const JUMP_PAD_VELOCITY = 15;
export const JUMP_PAD_RADIUS = 1.6;
export const JUMP_PADS = [
  { x: 20, z: 20 },
  { x: -20, z: -20 },
  { x: 20, z: -20 },
  { x: -20, z: 20 },
  { x: 0, z: 0 },
];

// Elevated platforms — too high to reach by walking or a normal jump, but within a jump
// pad's launch arc (apex ≈ JUMP_PAD_VELOCITY^2 / (2*|GRAVITY|) ≈ 5.6 units above ground).
// Movement's getGroundLevel() treats these as local high ground: standing/landing on their
// footprint sets the player's ground level to the platform top instead of GROUND_Y.
export const PLATFORMS = [
  { x: 20, z: 27, halfX: 4, halfZ: 4, height: 5.5 }, // reached from the (20,20) pad
  { x: -20, z: -27, halfX: 4, halfZ: 4, height: 5.5 }, // reached from the (-20,-20) pad
  { x: 0, z: 7, halfX: 5, halfZ: 5, height: 6 }, // central tower, reached from the (0,0) pad
];

// Ammo crates: walk over one (in the arena, alive) to fully refill your mag + reserve. Each
// crate then goes on cooldown — invisible/inert — before respawning, same pattern as a
// pickup in most shooters. Spread near the sites, mid lane, and flank routes.
export const AMMO_CRATE_RADIUS = 1.4;
export const AMMO_CRATE_RESPAWN_MS = 20000;
export const AMMO_CRATES = [
  { id: 'crateA', x: 0, z: 18 }, // site A approach
  { id: 'crateB', x: 0, z: -18 }, // site B approach
  { id: 'crateMidE', x: 13, z: 0 }, // mid lane, east side
  { id: 'crateMidW', x: -13, z: 0 }, // mid lane, west side
  { id: 'crateFlankE', x: 25, z: -7 }, // east flank route
  { id: 'crateFlankW', x: -25, z: 7 }, // west flank route
];

export const MSG = {
  INIT: 'init',
  STATE: 'state',
  INPUT: 'input',
  SHOOT: 'shoot',
  HIT: 'hit',
  JOIN: 'join',
  LEAVE: 'leave',
  KILL: 'kill',
  RESPAWN: 'respawn',
  JUMP: 'jump',
  SLIDE: 'slide',
  ENTER: 'enter',
  MONEY: 'money',
  BUY: 'buy',
  LOADOUT: 'loadout',
  AMMO: 'ammo',
  RELOAD: 'reload',
  CRATE: 'crate',
};
