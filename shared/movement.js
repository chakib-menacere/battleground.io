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
} from './constants.js';

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
  } else {
    state.grounded = false;
    if (state.sliding) state.sliding = false; // slides don't survive going airborne
  }
}
