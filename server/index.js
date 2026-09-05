import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  TICK_RATE,
  PLAYER_MAX_HEALTH,
  RESPAWN_TIME_MS,
  ARENA_HALF_SIZE,
  COVER_BOXES,
  SPAWN_POINTS,
  LOBBY_CENTER,
  LOBBY_HALF_SIZE,
  LOBBY_SPAWN_POINTS,
  PORTAL_POSITION,
  PORTAL_RADIUS,
  SHOP_POSITION,
  SHOP_RADIUS,
  JUMP_PADS,
  JUMP_PAD_RADIUS,
  JUMP_PAD_VELOCITY,
  STAND_EYE_HEIGHT,
  CROUCH_EYE_HEIGHT,
  STAND_HIT_CENTER,
  CROUCH_HIT_CENTER,
  SLIDE_MIN_INPUT,
  STARTING_MONEY,
  KILL_REWARD,
  SHOP_WEAPONS,
  DEFAULT_WEAPON_ID,
  ARMOR_COST,
  ARMOR_DAMAGE_REDUCTION,
  RESERVE_MAG_MULTIPLIER,
  RELOAD_TIME_MS,
  AMMO_CRATES,
  AMMO_CRATE_RADIUS,
  AMMO_CRATE_RESPAWN_MS,
  MSG,
} from '../shared/constants.js';
import { createMovementState, stepMovement, applyJump, applySlideStart, computeWorldDir } from '../shared/movement.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8090;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'dist')));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

/** @type {Map<string, Player>} */
const players = new Map();
let nextId = 1;

function randomSpawn() {
  const p = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
  return { x: p.x, y: p.y, z: p.z };
}

function randomLobbySpawn() {
  const p = LOBBY_SPAWN_POINTS[Math.floor(Math.random() * LOBBY_SPAWN_POINTS.length)];
  return { x: p.x, y: p.y, z: p.z };
}

class Player {
  constructor(id, ws, name) {
    this.id = id;
    this.ws = ws;
    this.name = name;
    const spawn = randomLobbySpawn();
    this.x = spawn.x;
    this.y = spawn.y;
    this.z = spawn.z;
    this.yaw = 0;
    this.pitch = 0;
    this.health = PLAYER_MAX_HEALTH;
    this.alive = true;
    this.inArena = false;
    this.kills = 0;
    this.deaths = 0;
    this.money = STARTING_MONEY;
    this.weaponId = DEFAULT_WEAPON_ID;
    this.armor = false;
    this.lastShotAt = 0;
    this.input = { forward: 0, right: 0, crouch: false };
    this.move = createMovementState();
    const startWeapon = SHOP_WEAPONS.find((w) => w.id === DEFAULT_WEAPON_ID);
    this.ammo = startWeapon.magSize;
    this.reserveAmmo = startWeapon.magSize * RESERVE_MAG_MULTIPLIER;
    this.reloading = false;
  }
}

function getWeapon(id) {
  return SHOP_WEAPONS.find((w) => w.id === id) || SHOP_WEAPONS[0];
}

// Buying a new weapon (or spawning with the default one) refills both the mag and reserve.
function resetAmmo(player) {
  const weapon = getWeapon(player.weaponId);
  player.ammo = weapon.magSize;
  player.reserveAmmo = weapon.magSize * RESERVE_MAG_MULTIPLIER;
  player.reloading = false;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.id === exceptId || !p.ws) continue;
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
  }
}

function clampToArena(pos) {
  const m = ARENA_HALF_SIZE - 0.5;
  pos.x = Math.max(-m, Math.min(m, pos.x));
  pos.z = Math.max(-m, Math.min(m, pos.z));
}

function clampToLobby(pos) {
  const m = LOBBY_HALF_SIZE - 0.5;
  pos.x = Math.max(LOBBY_CENTER.x - m, Math.min(LOBBY_CENTER.x + m, pos.x));
  pos.z = Math.max(LOBBY_CENTER.z - m, Math.min(LOBBY_CENTER.z + m, pos.z));
}

function enterArena(player) {
  player.inArena = true;
  const spawn = randomSpawn();
  player.x = spawn.x;
  player.y = spawn.y;
  player.z = spawn.z;
  player.health = PLAYER_MAX_HEALTH;
  player.move = createMovementState();
  broadcast({ type: MSG.ENTER, id: player.id, x: player.x, y: player.y, z: player.z, health: player.health });
}

// Cover boxes, walls, and crates block horizontal movement below their top — but once you're
// at or above that height (mantled onto one, or clearing it mid-jump), the same footprint no
// longer blocks you, so you can stand and walk around on top.
function collidesWithCover(x, z, y, radius) {
  for (const box of COVER_BOXES) {
    const hx = box.sx / 2 + radius;
    const hz = box.sz / 2 + radius;
    if (Math.abs(x - box.x) < hx && Math.abs(z - box.z) < hz && y < box.sy - 0.05) return true;
  }
  return false;
}

// A stationary-ish wandering target dummy for testing shooting/hit VFX. It has no socket
// (`ws: null`, guarded in send/broadcast) — its input is driven by updateBotAI() each tick
// instead of client messages, but otherwise it's a normal Player through the shoot/respawn code.
function createBot(id, name) {
  const spawn = randomSpawn();
  return {
    id,
    ws: null,
    name,
    x: spawn.x,
    y: spawn.y,
    z: spawn.z,
    yaw: 0,
    pitch: 0,
    health: PLAYER_MAX_HEALTH,
    alive: true,
    inArena: true,
    kills: 0,
    deaths: 0,
    money: STARTING_MONEY,
    weaponId: DEFAULT_WEAPON_ID,
    armor: false,
    lastShotAt: 0,
    input: { forward: 0, right: 0, crouch: false },
    move: createMovementState(),
    isBot: true,
    wanderTarget: null,
  };
}

function updateBotAI(bot) {
  if (!bot.alive) {
    bot.input.forward = 0;
    bot.input.right = 0;
    return;
  }
  if (!bot.wanderTarget || Math.hypot(bot.x - bot.wanderTarget.x, bot.z - bot.wanderTarget.z) < 2) {
    const spawn = randomSpawn();
    bot.wanderTarget = { x: spawn.x, z: spawn.z };
  }
  const dx = bot.wanderTarget.x - bot.x;
  const dz = bot.wanderTarget.z - bot.z;
  bot.yaw = Math.atan2(-dx, -dz);
  bot.input.forward = 1;
  bot.input.right = 0;
  if (bot.move.grounded && Math.random() < 0.01) applyJump(bot.move);
}

const bot = createBot('bot1', 'TrainingDummy');
players.set(bot.id, bot);

// Ammo crates: { id, x, z, active }. Picking one up (see the tick loop) deactivates it and
// schedules a respawn broadcast after AMMO_CRATE_RESPAWN_MS.
const crates = AMMO_CRATES.map((c) => ({ ...c, active: true }));

function serializeCrates() {
  return crates.map((c) => ({ id: c.id, active: c.active }));
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  const name = `Soldier${id}`;
  const player = new Player(id, ws, name);
  players.set(id, player);

  send(ws, {
    type: MSG.INIT,
    id,
    arenaHalfSize: ARENA_HALF_SIZE,
    coverBoxes: COVER_BOXES,
    self: {
      x: player.x, y: player.y, z: player.z, health: player.health, inArena: player.inArena,
      money: player.money, weaponId: player.weaponId, armor: player.armor,
      ammo: player.ammo, reserveAmmo: player.reserveAmmo,
    },
    shop: { weapons: SHOP_WEAPONS, armorCost: ARMOR_COST, position: SHOP_POSITION, radius: SHOP_RADIUS },
    crates: serializeCrates(),
    players: [...players.values()].map(serializePublic),
  });

  broadcast({ type: MSG.JOIN, player: serializePublic(player) }, id);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === MSG.INPUT) {
      if (!player.alive) return;
      player.input.forward = clampAxis(msg.forward);
      player.input.right = clampAxis(msg.right);
      player.input.crouch = !!msg.crouch;
      if (typeof msg.yaw === 'number') player.yaw = msg.yaw;
      if (typeof msg.pitch === 'number') player.pitch = msg.pitch;
    } else if (msg.type === MSG.SHOOT) {
      handleShoot(player);
    } else if (msg.type === MSG.JUMP) {
      if (player.alive) applyJump(player.move);
    } else if (msg.type === MSG.SLIDE) {
      if (!player.alive) return;
      const { forward, right } = player.input;
      if (Math.hypot(forward, right) > SLIDE_MIN_INPUT) {
        const dir = computeWorldDir(player.yaw, forward, right);
        applySlideStart(player.move, dir.x, dir.z);
      }
    } else if (msg.type === MSG.BUY) {
      handleBuy(player, msg);
    } else if (msg.type === MSG.RELOAD) {
      handleReload(player);
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: MSG.LEAVE, id });
  });
});

function clampAxis(v) {
  const n = Number(v) || 0;
  return Math.max(-1, Math.min(1, n));
}

function handleBuy(player, msg) {
  if (player.inArena) return; // buy phase only, in the lobby — matches the shop kiosk being there
  const dx = player.x - SHOP_POSITION.x;
  const dz = player.z - SHOP_POSITION.z;
  if (Math.hypot(dx, dz) > SHOP_RADIUS) return;

  if (msg.item === 'armor') {
    if (player.armor || player.money < ARMOR_COST) return;
    player.money -= ARMOR_COST;
    player.armor = true;
  } else {
    const weapon = SHOP_WEAPONS.find((w) => w.id === msg.item);
    if (!weapon || player.weaponId === weapon.id || player.money < weapon.cost) return;
    player.money -= weapon.cost;
    player.weaponId = weapon.id;
    resetAmmo(player);
  }

  send(player.ws, { type: MSG.MONEY, money: player.money });
  send(player.ws, {
    type: MSG.LOADOUT,
    weaponId: player.weaponId,
    armor: player.armor,
    ammo: player.ammo,
    reserveAmmo: player.reserveAmmo,
  });
}

function handleReload(player) {
  if (!player.alive || !player.inArena || player.reloading) return;
  const weapon = getWeapon(player.weaponId);
  if (player.ammo >= weapon.magSize || player.reserveAmmo <= 0) return;
  player.reloading = true;
  setTimeout(() => {
    if (!players.has(player.id)) return;
    const w = getWeapon(player.weaponId);
    const need = w.magSize - player.ammo;
    const take = Math.min(need, player.reserveAmmo);
    player.ammo += take;
    player.reserveAmmo -= take;
    player.reloading = false;
    send(player.ws, { type: MSG.AMMO, ammo: player.ammo, reserveAmmo: player.reserveAmmo, reloading: false });
  }, RELOAD_TIME_MS);
  send(player.ws, { type: MSG.AMMO, ammo: player.ammo, reserveAmmo: player.reserveAmmo, reloading: true });
}

function handleShoot(shooter) {
  if (!shooter.alive || !shooter.inArena || shooter.reloading || shooter.ammo <= 0) return;
  const weapon = SHOP_WEAPONS.find((w) => w.id === shooter.weaponId) || SHOP_WEAPONS[0];
  const now = Date.now();
  if (now - shooter.lastShotAt < weapon.fireCooldownMs) return;
  shooter.lastShotAt = now;
  shooter.ammo -= 1;
  send(shooter.ws, { type: MSG.AMMO, ammo: shooter.ammo, reserveAmmo: shooter.reserveAmmo, reloading: false });

  // Raycast from shooter's eye position along yaw/pitch against other players (as spheres).
  const eyeY = shooter.y + (shooter.move.crouching ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT);
  const dir = yawPitchToDir(shooter.yaw, shooter.pitch);

  let closestHit = null;
  let closestDist = weapon.range;

  for (const target of players.values()) {
    if (target.id === shooter.id || !target.alive || !target.inArena) continue;
    const targetCenterY = target.y + (target.move.crouching || target.move.sliding ? CROUCH_HIT_CENTER : STAND_HIT_CENTER);
    const dist = raySphereIntersect(
      shooter.x, eyeY, shooter.z,
      dir.x, dir.y, dir.z,
      target.x, targetCenterY, target.z,
      0.5
    );
    if (dist !== null && dist < closestDist) {
      closestDist = dist;
      closestHit = target;
    }
  }

  broadcast({
    type: MSG.SHOOT,
    id: shooter.id,
    origin: { x: shooter.x, y: eyeY, z: shooter.z },
    dir,
  });

  if (closestHit) {
    const damage = closestHit.armor ? weapon.damage * (1 - ARMOR_DAMAGE_REDUCTION) : weapon.damage;
    closestHit.health -= damage;
    broadcast({ type: MSG.HIT, targetId: closestHit.id, health: Math.max(0, closestHit.health), byId: shooter.id });

    if (closestHit.health <= 0) {
      closestHit.alive = false;
      closestHit.deaths += 1;
      shooter.kills += 1;
      shooter.money += KILL_REWARD;
      broadcast({ type: MSG.KILL, victimId: closestHit.id, killerId: shooter.id, kills: shooter.kills, deaths: closestHit.deaths });
      send(shooter.ws, { type: MSG.MONEY, money: shooter.money });

      setTimeout(() => {
        if (!players.has(closestHit.id)) return;
        const spawn = randomSpawn();
        closestHit.x = spawn.x;
        closestHit.y = spawn.y;
        closestHit.z = spawn.z;
        closestHit.health = PLAYER_MAX_HEALTH;
        closestHit.alive = true;
        closestHit.move = createMovementState();
        resetAmmo(closestHit);
        send(closestHit.ws, { type: MSG.AMMO, ammo: closestHit.ammo, reserveAmmo: closestHit.reserveAmmo, reloading: false });
        broadcast({ type: MSG.RESPAWN, id: closestHit.id, x: closestHit.x, y: closestHit.y, z: closestHit.z, health: closestHit.health });
      }, RESPAWN_TIME_MS);
    }
  }
}

function yawPitchToDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

function raySphereIntersect(ox, oy, oz, dx, dy, dz, cx, cy, cz, radius) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return null;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = radius * radius;
  if (d2 > r2) return null;
  const thc = Math.sqrt(r2 - d2);
  const t0 = tca - thc;
  return t0 >= 0 ? t0 : null;
}

function serializePublic(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    health: p.health,
    alive: p.alive,
    kills: p.kills,
    deaths: p.deaths,
    crouching: p.move.crouching,
    sliding: p.move.sliding,
    inArena: p.inArena,
  };
}

// Fixed-rate authoritative simulation: integrate movement from last received input.
const dtMs = 1000 / TICK_RATE;
setInterval(() => {
  for (const p of players.values()) {
    if (p.isBot) updateBotAI(p);
    if (!p.alive) continue;
    stepMovement(p.move, p, { forward: p.input.forward, right: p.input.right, crouch: p.input.crouch, yaw: p.yaw }, dtMs, collidesWithCover, p.inArena ? clampToArena : clampToLobby);

    if (!p.inArena) {
      const dx = p.x - PORTAL_POSITION.x;
      const dz = p.z - PORTAL_POSITION.z;
      if (Math.hypot(dx, dz) < PORTAL_RADIUS) enterArena(p);
    } else if (p.move.grounded) {
      for (const pad of JUMP_PADS) {
        const dx = p.x - pad.x;
        const dz = p.z - pad.z;
        if (Math.hypot(dx, dz) < JUMP_PAD_RADIUS) {
          p.move.vy = JUMP_PAD_VELOCITY;
          p.move.grounded = false;
          p.move.sliding = false;
          break;
        }
      }
    }

    if (p.inArena && !p.isBot) {
      for (const crate of crates) {
        if (!crate.active) continue;
        if (Math.hypot(p.x - crate.x, p.z - crate.z) >= AMMO_CRATE_RADIUS) continue;
        resetAmmo(p);
        send(p.ws, { type: MSG.AMMO, ammo: p.ammo, reserveAmmo: p.reserveAmmo, reloading: false });
        crate.active = false;
        broadcast({ type: MSG.CRATE, id: crate.id, active: false });
        setTimeout(() => {
          crate.active = true;
          broadcast({ type: MSG.CRATE, id: crate.id, active: true });
        }, AMMO_CRATE_RESPAWN_MS);
      }
    }
  }

  if (players.size > 0) {
    broadcast({ type: MSG.STATE, players: [...players.values()].map(serializePublic) });
  }
}, 1000 / TICK_RATE);

httpServer.listen(PORT, () => {
  console.log(`battleground.io server listening on http://localhost:${PORT}`);
});
