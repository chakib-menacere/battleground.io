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
  LOBBY_SPAWN_POINTS,
  DOOR_POSITION,
  DOOR_RADIUS,
  DOOR_GAP_HALF_WIDTH,
  DOOR_HOLD_MS,
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
  KNIFE_WEAPON,
  DEFAULT_SLOT,
  MSG,
} from '../shared/constants.js';
import { createMovementState, stepMovement, attemptJump, applySlideStart, computeWorldDir, clampToWorld } from '../shared/movement.js';

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
    this.activeSlot = DEFAULT_SLOT; // 'primary' (purchased gun) or 'secondary' (knife)
    this.lastShotAt = 0;
    this.lastStabAt = 0;
    this.doorHolding = false;
    this.doorHoldStart = 0;
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

// The knife (secondary slot) is free, has no ammo/reload, and isn't in SHOP_WEAPONS since
// it's never purchased — every player always has it.
function getActiveWeapon(player) {
  return player.activeSlot === 'secondary' ? KNIFE_WEAPON : getWeapon(player.weaponId);
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

function enterArena(player) {
  player.inArena = true;
  player.doorHolding = false;
  player.doorHoldStart = 0;
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
// longer blocks you, so you can stand and walk around on top. The arena's entrance door is a
// permanent, full-height barrier with no such exception — it never becomes walk-through, since
// "opening" it (holding E, see the tick loop) teleports you into the arena instead.
function collidesWithCover(x, z, y, radius) {
  for (const box of COVER_BOXES) {
    const hx = box.sx / 2 + radius;
    const hz = box.sz / 2 + radius;
    if (Math.abs(x - box.x) < hx && Math.abs(z - box.z) < hz && y < box.sy - 0.05) return true;
  }
  const doorHalfX = DOOR_GAP_HALF_WIDTH + radius;
  const doorHalfZ = 0.5 + radius;
  if (Math.abs(x - DOOR_POSITION.x) < doorHalfX && Math.abs(z - DOOR_POSITION.z) < doorHalfZ) return true;
  return false;
}

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
      ammo: player.ammo, reserveAmmo: player.reserveAmmo, activeSlot: player.activeSlot,
    },
    knife: KNIFE_WEAPON,
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
    } else if (msg.type === MSG.STAB) {
      handleStab(player);
    } else if (msg.type === MSG.JUMP) {
      if (player.alive) attemptJump(player.move, player.x, player.z);
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
    } else if (msg.type === MSG.SWITCH) {
      if (!player.alive) return;
      const slot = msg.slot === 'secondary' ? 'secondary' : 'primary';
      if (slot === player.activeSlot) return;
      player.activeSlot = slot;
      player.reloading = false;
      send(player.ws, { type: MSG.SWITCH, slot });
    } else if (msg.type === MSG.INTERACT) {
      if (player.inArena) return; // the door's the only interactable, and it's only in the lobby
      if (msg.holding) {
        const nearDoor = Math.hypot(player.x - DOOR_POSITION.x, player.z - DOOR_POSITION.z) < DOOR_RADIUS;
        if (!nearDoor) return;
        player.doorHolding = true;
        player.doorHoldStart = Date.now();
      } else {
        player.doorHolding = false;
        send(player.ws, { type: MSG.DOOR_PROGRESS, progress: 0 });
      }
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
  if (!player.alive || !player.inArena || player.reloading || player.activeSlot === 'secondary') return;
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

// Raycasts from the shooter's eye along yaw/pitch against every other living in-arena player
// (as spheres), returning the closest hit within `range`, or null.
function findClosestTarget(shooter, eyeY, dir, range) {
  let closestHit = null;
  let closestDist = range;
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
  return closestHit;
}

// Applies damage to a hit target, broadcasts it, and handles death/respawn if it's lethal.
// Shared by gunfire, knife slashes, and backstabs so the kill/respawn flow only lives once.
function applyDamage(shooter, target, damage) {
  target.health -= damage;
  broadcast({ type: MSG.HIT, targetId: target.id, health: Math.max(0, target.health), byId: shooter.id });

  if (target.health <= 0) {
    target.alive = false;
    target.deaths += 1;
    shooter.kills += 1;
    shooter.money += KILL_REWARD;
    broadcast({ type: MSG.KILL, victimId: target.id, killerId: shooter.id, kills: shooter.kills, deaths: target.deaths });
    send(shooter.ws, { type: MSG.MONEY, money: shooter.money });

    setTimeout(() => {
      if (!players.has(target.id)) return;
      const spawn = randomSpawn();
      target.x = spawn.x;
      target.y = spawn.y;
      target.z = spawn.z;
      target.health = PLAYER_MAX_HEALTH;
      target.alive = true;
      target.move = createMovementState();
      resetAmmo(target);
      send(target.ws, { type: MSG.AMMO, ammo: target.ammo, reserveAmmo: target.reserveAmmo, reloading: false });
      broadcast({ type: MSG.RESPAWN, id: target.id, x: target.x, y: target.y, z: target.z, health: target.health });
    }, RESPAWN_TIME_MS);
  }
}

function handleShoot(shooter) {
  const usingKnife = shooter.activeSlot === 'secondary';
  if (!shooter.alive || !shooter.inArena) return;
  if (!usingKnife && (shooter.reloading || shooter.ammo <= 0)) return;
  const weapon = getActiveWeapon(shooter);
  const now = Date.now();
  if (now - shooter.lastShotAt < weapon.fireCooldownMs) return;
  shooter.lastShotAt = now;
  if (!usingKnife) {
    shooter.ammo -= 1;
    send(shooter.ws, { type: MSG.AMMO, ammo: shooter.ammo, reserveAmmo: shooter.reserveAmmo, reloading: false });
  }

  const eyeY = shooter.y + (shooter.move.crouching ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT);
  const dir = yawPitchToDir(shooter.yaw, shooter.pitch);
  const closestHit = findClosestTarget(shooter, eyeY, dir, weapon.range);

  broadcast({
    type: MSG.SHOOT,
    id: shooter.id,
    origin: { x: shooter.x, y: eyeY, z: shooter.z },
    dir,
  });

  if (closestHit) {
    const damage = closestHit.armor ? weapon.damage * (1 - ARMOR_DAMAGE_REDUCTION) : weapon.damage;
    applyDamage(shooter, closestHit, damage);
  }
}

// Right-click with the knife out: a stab that instantly kills if you're roughly behind the
// target (their facing points away from you), otherwise lands as a normal knife hit. Backstabs
// bypass armor entirely — they're a reward for the risk of closing distance undetected.
function handleStab(shooter) {
  if (!shooter.alive || !shooter.inArena || shooter.activeSlot !== 'secondary') return;
  const now = Date.now();
  if (now - shooter.lastStabAt < KNIFE_WEAPON.stabCooldownMs) return;
  shooter.lastStabAt = now;

  const eyeY = shooter.y + (shooter.move.crouching ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT);
  const dir = yawPitchToDir(shooter.yaw, shooter.pitch);
  const target = findClosestTarget(shooter, eyeY, dir, KNIFE_WEAPON.range);

  broadcast({ type: MSG.STAB, id: shooter.id, origin: { x: shooter.x, y: eyeY, z: shooter.z }, dir });

  if (!target) return;

  const targetForward = yawPitchToDir(target.yaw, 0);
  const toAttacker = { x: shooter.x - target.x, z: shooter.z - target.z };
  const len = Math.hypot(toAttacker.x, toAttacker.z) || 1;
  const dot = targetForward.x * (toAttacker.x / len) + targetForward.z * (toAttacker.z / len);
  const isBackstab = dot < -0.5; // attacker sits within ~120° behind the target's facing

  if (isBackstab) {
    broadcast({ type: MSG.BACKSTAB, targetId: target.id, byId: shooter.id });
    applyDamage(shooter, target, target.health); // lethal regardless of armor
  } else {
    applyDamage(shooter, target, target.armor ? KNIFE_WEAPON.damage * (1 - ARMOR_DAMAGE_REDUCTION) : KNIFE_WEAPON.damage);
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
    activeSlot: p.activeSlot,
  };
}

// Fixed-rate authoritative simulation: integrate movement from last received input.
const dtMs = 1000 / TICK_RATE;
setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) continue;
    stepMovement(p.move, p, { forward: p.input.forward, right: p.input.right, crouch: p.input.crouch, yaw: p.yaw }, dtMs, collidesWithCover, clampToWorld);

    if (!p.inArena) {
      const nearDoor = Math.hypot(p.x - DOOR_POSITION.x, p.z - DOOR_POSITION.z) < DOOR_RADIUS;
      if (p.doorHolding && nearDoor) {
        const heldMs = Date.now() - p.doorHoldStart;
        send(p.ws, { type: MSG.DOOR_PROGRESS, progress: Math.min(1, heldMs / DOOR_HOLD_MS) });
        if (heldMs >= DOOR_HOLD_MS) enterArena(p);
      } else if (p.doorHolding) {
        // Walked out of range mid-hold — cancel and reset the client's progress bar.
        p.doorHolding = false;
        send(p.ws, { type: MSG.DOOR_PROGRESS, progress: 0 });
      }
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

    if (p.inArena) {
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
