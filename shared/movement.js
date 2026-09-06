// Movement physics shared by client (prediction) and server (authority) so they never disagree.
import {
  PLAYER_SPEED,
  PLAYER_RADIUS,
  GROUND_Y,
  GRAVITY,
  JUMP_VELOCITY,
  CROUCH_SPEED_MULT,
  SLIDE_SPEED,
  SLIDE_DURATION_MS,
  PLATFORMS,
  COVER_BOXES,
  MANTLE_TOLERANCE,
  ARENA_HALF_SIZE,
  LOBBY_CENTER,
  LOBBY_HALF_SIZE,
  CORRIDOR_HALF_WIDTH,
  WALLKICK_RANGE,
  WALLKICK_UP_VELOCITY,
  WALLKICK_PUSH_SPEED,
  WALLKICK_DRAG,
} from './constants.js';

// Finds the nearest wall surface within `range` of (x, z) — a cover-box face or the arena's
// outer boundary — and returns the direction pointing away from it (for a wall kick to launch
// along), or null if nothing is close enough. Checks whichever face distance is smallest
// across every candidate, so a corner between two walls picks the closer one.
function findWallKickNormal(x, z, range) {
  let best = null;
  let bestDist = range;
  const consider = (nx, nz, dist) => {
    if (dist > 0 && dist < bestDist) {
      bestDist = dist;
      best = { x: nx, z: nz };
    }
  };

  for (const b of COVER_BOXES) {
    const hx = b.sx / 2;
    const hz = b.sz / 2;
    if (z > b.z - hz - 0.4 && z < b.z + hz + 0.4) {
      consider(-1, 0, (b.x - hx) - x);
      consider(1, 0, x - (b.x + hx));
    }
    if (x > b.x - hx - 0.4 && x < b.x + hx + 0.4) {
      consider(0, -1, (b.z - hz) - z);
      consider(0, 1, z - (b.z + hz));
    }
  }

  // The arena's four outer walls, treated the same way (push back toward the interior).
  consider(1, 0, x - -ARENA_HALF_SIZE);
  consider(-1, 0, ARENA_HALF_SIZE - x);
  consider(0, 1, z - -ARENA_HALF_SIZE);
  consider(0, -1, ARENA_HALF_SIZE - z);

  return best;
}

// One continuous playable space — arena, connecting corridor, and lobby — instead of two
// separate walled-off zones. Which segment applies is picked by z alone, since all three sit
// on the same x=0 centerline; a closed door (see collidesWithCover) is what actually stops
// you from wandering into the arena, not this clamp.
export function clampToWorld(pos) {
  // The branch threshold must exactly match the lobby clamp's own z-max below — otherwise a
  // 0.5-unit gap opens between "clamped back into the lobby" and "far enough to count as the
  // corridor", which traps the player at that exact z forever (found by walking into it).
  const lobbyZMax = LOBBY_CENTER.z + (LOBBY_HALF_SIZE - 0.5);
  if (pos.z >= -ARENA_HALF_SIZE) {
    const m = ARENA_HALF_SIZE - 0.5;
    pos.x = Math.max(-m, Math.min(m, pos.x));
    pos.z = Math.max(-m, Math.min(m, pos.z));
  } else if (pos.z >= lobbyZMax) {
    const m = CORRIDOR_HALF_WIDTH - 0.4;
    pos.x = Math.max(-m, Math.min(m, pos.x));
    pos.z = Math.max(lobbyZMax, Math.min(-ARENA_HALF_SIZE, pos.z));
  } else {
    const m = LOBBY_HALF_SIZE - 0.5;
    pos.x = Math.max(LOBBY_CENTER.x - m, Math.min(LOBBY_CENTER.x + m, pos.x));
    pos.z = Math.max(LOBBY_CENTER.z - m, Math.min(LOBBY_CENTER.z + m, pos.z));
  }
}

// The ground level at a point is normally GROUND_Y, but rises to a surface's top while
// standing over its footprint — this is how "walk through it, but can stand on top" cover
// (and jump-pad-only high ground) works without a full 3D collision system.
//
// `priorY` is the player's height *before* this tick's fall is applied. A surface only
// counts if priorY is already within MANTLE_TOLERANCE of its top, so simply walking up to a
// box at ground level does not teleport you onto it — you have to jump (or already be
// standing there). Tall platforms stay out of normal jump range on purpose, so they still
// require a jump pad's much higher launch to reach.
export function getGroundLevel(x, z, priorY) {
  let level = GROUND_Y;
  const consider = (matches, height) => {
    if (matches && priorY >= height - MANTLE_TOLERANCE) level = Math.max(level, height);
  };
  for (const p of PLATFORMS) {
    consider(x >= p.x - p.halfX && x <= p.x + p.halfX && z >= p.z - p.halfZ && z <= p.z + p.halfZ, p.height);
  }
  for (const b of COVER_BOXES) {
    consider(x >= b.x - b.sx / 2 && x <= b.x + b.sx / 2 && z >= b.z - b.sz / 2 && z <= b.z + b.sz / 2, b.sy);
  }
  return level;
}

export function createMovementState() {
  return {
    vy: 0,
    grounded: true,
    crouching: false,
    sliding: false,
    slideTimeLeft: 0,
    slideDirX: 0,
    slideDirZ: 0,
    kickVX: 0, // outward shove from a wall kick, decays via WALLKICK_DRAG; layered onto normal movement
    kickVZ: 0,
    wallKicked: false, // one wall kick per airborne stretch — cleared the moment you touch ground
  };
}

// World-space move direction from yaw + local forward/right axes (matches camera facing at yaw=0 -> -Z).
export function computeWorldDir(yaw, forward, right) {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return {
    x: -sin * forward + cos * right,
    z: -cos * forward - sin * right,
  };
}

export function applyJump(state) {
  if (state.grounded && !state.sliding) {
    state.vy = JUMP_VELOCITY;
    state.grounded = false;
  }
}

// Jump input handling: a normal jump off the ground, or — if already airborne, near a wall,
// and this airborne stretch hasn't used one yet — a wall kick launching up and away from it.
// Returns true if anything happened (useful for triggering VFX at the call site).
export function attemptJump(state, x, z) {
  if (state.grounded) {
    applyJump(state);
    return state.vy === JUMP_VELOCITY;
  }
  if (state.wallKicked) return false;
  const wall = findWallKickNormal(x, z, WALLKICK_RANGE);
  if (!wall) return false;
  state.vy = WALLKICK_UP_VELOCITY;
  state.kickVX = wall.x * WALLKICK_PUSH_SPEED;
  state.kickVZ = wall.z * WALLKICK_PUSH_SPEED;
  state.wallKicked = true;
  state.sliding = false;
  return true;
}

export function applySlideStart(state, dirX, dirZ) {
  if (!state.grounded || state.sliding) return;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.001) return;
  state.sliding = true;
  state.slideTimeLeft = SLIDE_DURATION_MS;
  state.slideDirX = dirX / len;
  state.slideDirZ = dirZ / len;
}

/**
 * Advances one physics step in place, mutating `pos` ({x,y,z}) and `state`.
 * `input` is { forward, right, yaw, crouch }. `dtMs` is elapsed time in milliseconds.
 */
export function stepMovement(state, pos, input, dtMs, collidesWithCover, clampToArena) {
  const dt = dtMs / 1000;
  state.crouching = !!input.crouch;

  let forward = input.forward || 0;
  let right = input.right || 0;
  const inputLen = Math.hypot(forward, right);
  if (inputLen > 1) {
    forward /= inputLen;
    right /= inputLen;
  }

  let moveX = 0;
  let moveZ = 0;

  if (state.sliding) {
    state.slideTimeLeft -= dtMs;
    const t = Math.max(0, state.slideTimeLeft / SLIDE_DURATION_MS);
    const speed = SLIDE_SPEED * t + PLAYER_SPEED * CROUCH_SPEED_MULT * (1 - t);
    moveX = state.slideDirX * speed * dt;
    moveZ = state.slideDirZ * speed * dt;
    if (state.slideTimeLeft <= 0) state.sliding = false;
  } else if (forward !== 0 || right !== 0) {
    const speed = state.crouching ? PLAYER_SPEED * CROUCH_SPEED_MULT : PLAYER_SPEED;
    const dir = computeWorldDir(input.yaw, forward, right);
    moveX = dir.x * speed * dt;
    moveZ = dir.z * speed * dt;
  }

  // A wall kick's outward shove rides on top of normal movement and decays on its own —
  // it's a burst, not a persistent velocity system.
  if (state.kickVX || state.kickVZ) {
    moveX += state.kickVX * dt;
    moveZ += state.kickVZ * dt;
    const decay = Math.max(0, 1 - WALLKICK_DRAG * dt);
    state.kickVX *= decay;
    state.kickVZ *= decay;
  }

  if (moveX !== 0 || moveZ !== 0) {
    const nx = pos.x + moveX;
    const nz = pos.z + moveZ;
    // pos.y here is still last tick's resolved height (vertical resolution happens below),
    // so this only blocks entry while below a surface's top — walking on top of a mantled
    // box, or flying over it mid-jump, moves freely across the same footprint.
    if (!collidesWithCover(nx, pos.z, pos.y, PLAYER_RADIUS)) pos.x = nx;
    if (!collidesWithCover(pos.x, nz, pos.y, PLAYER_RADIUS)) pos.z = nz;
    clampToArena(pos);
  }

  // Vertical resolution uses the (possibly just-moved) x/z so landing on a surface's
  // footprint is detected in the same tick the player's feet cross into it.
  const priorY = pos.y;
  state.vy += GRAVITY * dt;
  pos.y += state.vy * dt;
  const groundLevel = getGroundLevel(pos.x, pos.z, priorY);
  if (pos.y <= groundLevel) {
    pos.y = groundLevel;
    state.vy = 0;
    state.grounded = true;
    state.wallKicked = false; // touching ground refreshes the wall kick for the next airflight
  } else {
    state.grounded = false;
    if (state.sliding) state.sliding = false; // slides don't survive going airborne
  }
}
