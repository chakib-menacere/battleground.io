import * as THREE from 'three';
import { Net } from './net.js';
import {
  PLAYER_MAX_HEALTH,
  ARENA_HALF_SIZE,
  COVER_BOXES as CLIENT_COVER,
  LOBBY_CENTER,
  LOBBY_HALF_SIZE,
  DOOR_POSITION,
  DOOR_RADIUS,
  DOOR_GAP_HALF_WIDTH,
  SHOP_POSITION,
  SHOP_RADIUS,
  JUMP_PADS,
  JUMP_PAD_RADIUS,
  JUMP_PAD_VELOCITY,
  PLATFORMS,
  AMMO_CRATES,
  STARTING_MONEY,
  DEFAULT_WEAPON_ID,
  SHOP_WEAPONS,
  KNIFE_WEAPON,
  DEFAULT_SLOT,
  ARMOR_COST,
  STAND_EYE_HEIGHT,
  CROUCH_EYE_HEIGHT,
  SLIDE_MIN_INPUT,
  MSG,
} from '../shared/constants.js';
import { createMovementState, stepMovement, attemptJump, applySlideStart, computeWorldDir, clampToWorld } from '../shared/movement.js';

const app = document.getElementById('app');
const overlay = document.getElementById('overlay');
const healthEl = document.getElementById('health');
const moneyEl = document.getElementById('money');
const ammoEl = document.getElementById('ammo');
const weaponNameEl = document.getElementById('weapon-name');
const slotPrimaryEl = document.getElementById('slot-primary');
const slotSecondaryEl = document.getElementById('slot-secondary');
const slotPrimaryNameEl = document.getElementById('slot-primary-name');
const scoreboardEl = document.getElementById('scoreboard');
const killfeedEl = document.getElementById('killfeed');
const respawnEl = document.getElementById('respawn');
const respawnTimerEl = document.getElementById('respawn-timer');
const lobbyHintEl = document.getElementById('lobby-hint');
const shopHintEl = document.getElementById('shop-hint');
const shopEl = document.getElementById('shop');
const shopItemsEl = document.getElementById('shop-items');
const shopCloseEl = document.getElementById('shop-close');
const damageFlashEl = document.getElementById('damage-flash');
const doorHintEl = document.getElementById('door-hint');
const doorProgressFillEl = document.getElementById('door-progress-fill');

let damageFlashTimeout = null;
function flashDamage() {
  damageFlashEl.classList.remove('show');
  void damageFlashEl.offsetWidth; // restart the fade-out transition even on rapid re-hits
  damageFlashEl.classList.add('show');
  clearTimeout(damageFlashTimeout);
  damageFlashTimeout = setTimeout(() => damageFlashEl.classList.remove('show'), 30);
}

// ---------- Shop ----------
let shopData = null; // { weapons, armorCost, position, radius } from INIT
let shopOpen = false;
let nearShop = false;

// ---------- Door (hold E to deploy) ----------
let nearDoor = false;
let doorHolding = false;
function startDoorHold() {
  if (doorHolding || !nearDoor || inArena || !alive) return;
  doorHolding = true;
  net.send({ type: MSG.INTERACT, holding: true });
}
function stopDoorHold() {
  if (!doorHolding) return;
  doorHolding = false;
  doorProgressFillEl.style.width = '0%';
  net.send({ type: MSG.INTERACT, holding: false });
}

function buildShopUI(shop) {
  shopData = shop;
  refreshShopUI();
}

function shopRow(id, name, stats, cost, isEquipped, canAfford) {
  const row = document.createElement('div');
  row.className = 'shop-item' + (isEquipped ? ' equipped' : !canAfford ? ' disabled' : '');
  row.innerHTML = `
    <div>
      <div class="name">${name}${isEquipped ? ' &middot; equipped' : ''}</div>
      <div class="stats">${stats}</div>
    </div>
    <div class="cost">${isEquipped ? 'OWNED' : `$${cost}`}</div>
  `;
  if (!isEquipped && canAfford) {
    row.addEventListener('click', () => net.send({ type: MSG.BUY, item: id }));
  }
  return row;
}

function refreshShopUI() {
  if (!shopData || !shopItemsEl) return;
  shopItemsEl.innerHTML = '';

  const weaponsLabel = document.createElement('div');
  weaponsLabel.className = 'shop-section-label';
  weaponsLabel.textContent = 'Weapons';
  shopItemsEl.appendChild(weaponsLabel);

  for (const w of shopData.weapons) {
    const stats = `DMG ${w.damage} &middot; RATE ${Math.round(1000 / w.fireCooldownMs * 10) / 10}/s &middot; RANGE ${w.range}`;
    shopItemsEl.appendChild(shopRow(w.id, w.name, stats, w.cost, weaponId === w.id, money >= w.cost));
  }

  const armorLabel = document.createElement('div');
  armorLabel.className = 'shop-section-label';
  armorLabel.textContent = 'Armor';
  shopItemsEl.appendChild(armorLabel);
  shopItemsEl.appendChild(
    shopRow('armor', 'Light Armor', `Absorbs 25% of incoming damage`, shopData.armorCost, hasArmor, money >= shopData.armorCost)
  );
}

function setShopOpen(open) {
  shopOpen = open;
  shopEl.classList.toggle('show', open);
  if (open) {
    refreshShopUI();
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

shopCloseEl.addEventListener('click', () => setShopOpen(false));

// ---------- Three.js scene ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fbce6);
scene.fog = new THREE.Fog(0x8fbce6, 45, 140);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 1.7, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
app.prepend(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const hemiLight = new THREE.HemisphereLight(0xfff6e0, 0x7a6a4f, 1.1);
scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
sunLight.position.set(30, 40, 10);
sunLight.castShadow = true;
sunLight.shadow.camera.left = -40;
sunLight.shadow.camera.right = 40;
sunLight.shadow.camera.top = 40;
sunLight.shadow.camera.bottom = -40;
sunLight.shadow.mapSize.set(2048, 2048);
scene.add(sunLight);

// ---------- Procedural textures (no external assets — small canvases, tiled) ----------
function makeProceduralTexture(draw, size, repeatX, repeatY) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  return tex;
}

function drawSandstone(ctx, size) {
  ctx.fillStyle = '#c9b58b';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 1200; i++) {
    ctx.fillStyle = `rgba(90,70,40,${Math.random() * 0.1})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgba(255,250,235,${Math.random() * 0.1})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }
  // Faint tile seams for a paved-plaza feel.
  ctx.strokeStyle = 'rgba(90,70,40,0.15)';
  ctx.lineWidth = 1;
  const step = size / 4;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }
}

function drawAsphalt(ctx, size) {
  ctx.fillStyle = '#6b7178';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 1200; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.15})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }
}

function drawCrate(ctx, size) {
  ctx.fillStyle = '#e4dcc8';
  ctx.fillRect(0, 0, size, size);
  // Teal accent stripe, Valorant-style.
  ctx.fillStyle = '#2fb5a3';
  ctx.fillRect(0, size * 0.42, size, size * 0.16);
  ctx.strokeStyle = 'rgba(40,40,35,0.3)';
  ctx.lineWidth = size * 0.045;
  ctx.strokeRect(size * 0.04, size * 0.04, size * 0.92, size * 0.92);
  for (let i = 0; i < 250; i++) {
    ctx.fillStyle = `rgba(40,40,35,${Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
}

// Weapon materials — flat colors alone read as plastic toys at close range (the first-person
// view model sits right in front of the camera), so these give metal a brushed-steel grain
// and polymer/rubber a fine matte speckle.
function drawBrushedMetal(ctx, size) {
  ctx.fillStyle = '#2a2c30';
  ctx.fillRect(0, 0, size, size);
  // Horizontal brushing streaks.
  for (let i = 0; i < 500; i++) {
    const y = Math.random() * size;
    const shade = Math.random() * 0.5;
    ctx.strokeStyle = `rgba(255,255,255,${shade * 0.12})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 2);
    ctx.stroke();
  }
  // Faint scratches at odd angles for wear.
  for (let i = 0; i < 30; i++) {
    ctx.strokeStyle = `rgba(255,255,255,${Math.random() * 0.15})`;
    const x = Math.random() * size, y = Math.random() * size;
    const len = Math.random() * size * 0.3;
    const angle = Math.random() * Math.PI;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  }
}

function drawPolymerGrain(ctx, size) {
  ctx.fillStyle = '#19191a';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2000; i++) {
    const v = Math.random();
    ctx.fillStyle = v > 0.5 ? `rgba(255,255,255,${(v - 0.5) * 0.1})` : `rgba(0,0,0,${(0.5 - v) * 0.15})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }
}

function drawRubberGrip(ctx, size) {
  ctx.fillStyle = '#242422';
  ctx.fillRect(0, 0, size, size);
  // A criss-cross checkered grip pattern, like molded pistol-grip texturing.
  const step = size / 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.5;
  for (let i = 1; i < 10; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.1})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }
}

const groundSize = ARENA_HALF_SIZE * 2;
const groundTexture = makeProceduralTexture(drawSandstone, 256, groundSize / 6, groundSize / 6);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(groundSize, groundSize),
  new THREE.MeshStandardMaterial({ map: groundTexture, roughness: 0.95 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Boundary walls (thin, just to make edges visible)
const wallMat = new THREE.MeshStandardMaterial({ color: 0xdcd3bf, roughness: 0.85 });
const wallHeight = 4;

// North wall: one solid span.
{
  const wall = new THREE.Mesh(new THREE.BoxGeometry(groundSize, wallHeight, 1), wallMat);
  wall.position.set(0, wallHeight / 2, ARENA_HALF_SIZE);
  wall.castShadow = true;
  scene.add(wall);
}

// South wall: split around the door gap instead of one solid span.
{
  const doorSpan = DOOR_GAP_HALF_WIDTH * 2;
  const sideWidth = (groundSize - doorSpan) / 2;
  [
    [-(doorSpan / 2 + sideWidth / 2), sideWidth],
    [doorSpan / 2 + sideWidth / 2, sideWidth],
  ].forEach(([x, w]) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallHeight, 1), wallMat);
    wall.position.set(x, wallHeight / 2, -ARENA_HALF_SIZE);
    wall.castShadow = true;
    scene.add(wall);
  });
}
[
  [-ARENA_HALF_SIZE, 0, 1, groundSize],
  [ARENA_HALF_SIZE, 0, 1, groundSize],
].forEach(([x, z, w, d]) => {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallHeight, d), wallMat);
  wall.position.set(x, wallHeight / 2, z);
  wall.castShadow = true;
  scene.add(wall);
});

// ---------- Lobby ----------
const lobbySize = LOBBY_HALF_SIZE * 2;
const lobbyTexture = makeProceduralTexture(drawAsphalt, 256, lobbySize / 3, lobbySize / 3);
const lobbyGround = new THREE.Mesh(
  new THREE.PlaneGeometry(lobbySize, lobbySize),
  new THREE.MeshStandardMaterial({ map: lobbyTexture, roughness: 0.85, metalness: 0.1 })
);
lobbyGround.rotation.x = -Math.PI / 2;
lobbyGround.position.set(LOBBY_CENTER.x, 0.01, LOBBY_CENTER.z);
lobbyGround.receiveShadow = true;
scene.add(lobbyGround);

// A connecting walkway between the arena wall and the lobby — a real, walkable corridor (see
// clampToWorld in shared/movement.js), not just a cosmetic backdrop. The door at its arena end
// is the only thing actually gating entry.
const walkwayNearZ = -ARENA_HALF_SIZE;
const walkwayFarZ = LOBBY_CENTER.z + LOBBY_HALF_SIZE;
const walkwayLength = walkwayNearZ - walkwayFarZ;
const walkwayWidth = 10;
const walkway = new THREE.Mesh(
  new THREE.PlaneGeometry(walkwayWidth, walkwayLength),
  new THREE.MeshStandardMaterial({ map: lobbyTexture, roughness: 0.85, metalness: 0.1 })
);
walkway.rotation.x = -Math.PI / 2;
walkway.position.set(0, 0.005, (walkwayNearZ + walkwayFarZ) / 2);
walkway.receiveShadow = true;
scene.add(walkway);

// The entrance door: a frame filling the gap in the south wall, plus two panels that swing
// open when a hold-E interaction completes (see MSG.ENTER handling below). Purely cosmetic —
// entry itself is a teleport to a random arena spawn, same as the portal it replaced.
const doorGroup = new THREE.Group();
doorGroup.position.set(DOOR_POSITION.x, 0, DOOR_POSITION.z);
scene.add(doorGroup);

const doorFrameMat = new THREE.MeshStandardMaterial({ color: 0x2b2f26, roughness: 0.5, metalness: 0.4 });
const doorPanelMat = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.6, metalness: 0.3 });
const doorAccentMat = new THREE.MeshStandardMaterial({ color: 0x2fe0c4, emissive: 0x1a8f7d, emissiveIntensity: 1.1, roughness: 0.4 });

const doorSpanWidth = DOOR_GAP_HALF_WIDTH * 2;
const doorHeight = wallHeight;
[-1, 1].forEach((side) => {
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, doorHeight, 0.6), doorFrameMat);
  post.position.set(side * (doorSpanWidth / 2 + 0.2), doorHeight / 2, 0);
  post.castShadow = true;
  doorGroup.add(post);
});
const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorSpanWidth + 0.8, 0.4, 0.6), doorFrameMat);
lintel.position.set(0, doorHeight, 0);
doorGroup.add(lintel);
const accentStrip = new THREE.Mesh(new THREE.BoxGeometry(doorSpanWidth + 0.6, 0.08, 0.62), doorAccentMat);
accentStrip.position.set(0, doorHeight - 0.3, 0);
doorGroup.add(accentStrip);

const doorPanels = [-1, 1].map((side) => {
  const pivot = new THREE.Group();
  pivot.position.set(side * 0.2, 0, 0); // hinge at the frame post, panel swings outward
  doorGroup.add(pivot);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(doorSpanWidth / 2 - 0.2, doorHeight - 0.4, 0.15), doorPanelMat);
  panel.position.set(side * (doorSpanWidth / 4 - 0.1), (doorHeight - 0.4) / 2, 0);
  panel.castShadow = true;
  pivot.add(panel);
  return pivot;
});

const doorLight = new THREE.PointLight(0x2fe0c4, 1.5, 8);
doorLight.position.set(0, 2, 0.5);
doorGroup.add(doorLight);

let doorOpenAmount = 0;
let doorOpenTarget = 0; // set to 1 whenever anyone deploys; decays back to 0 on its own

// Low perimeter wall with a glowing teal trim, enclosing the lobby platform.
const lobbyWallMat = new THREE.MeshStandardMaterial({ color: 0x1b2426, roughness: 0.7 });
const lobbyTrimMat = new THREE.MeshStandardMaterial({ color: 0x2fe0c4, emissive: 0x1a8a78, emissiveIntensity: 1 });
const lobbyWallHeight = 1.1;
[
  [LOBBY_CENTER.x, LOBBY_CENTER.z - LOBBY_HALF_SIZE, lobbySize, 0.4],
  [LOBBY_CENTER.x, LOBBY_CENTER.z + LOBBY_HALF_SIZE, lobbySize, 0.4],
  [LOBBY_CENTER.x - LOBBY_HALF_SIZE, LOBBY_CENTER.z, 0.4, lobbySize],
  [LOBBY_CENTER.x + LOBBY_HALF_SIZE, LOBBY_CENTER.z, 0.4, lobbySize],
].forEach(([x, z, w, d]) => {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, lobbyWallHeight, d), lobbyWallMat);
  wall.position.set(x, lobbyWallHeight / 2, z);
  wall.castShadow = true;
  scene.add(wall);
  const trim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.05, 0.08, d + 0.05), lobbyTrimMat);
  trim.position.set(x, lobbyWallHeight + 0.04, z);
  scene.add(trim);
});

// Floating title sign over the lobby.
const titleSignCanvas = document.createElement('canvas');
titleSignCanvas.width = 1024;
titleSignCanvas.height = 256;
{
  const ctx = titleSignCanvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, titleSignCanvas.width, titleSignCanvas.height);
  ctx.textAlign = 'center';
  ctx.font = '800 108px system-ui, sans-serif';
  ctx.shadowColor = '#2fe0c4';
  ctx.shadowBlur = 30;
  ctx.fillStyle = '#eafffb';
  ctx.fillText('BATTLEGROUND.IO', titleSignCanvas.width / 2, 150);
  ctx.shadowBlur = 0;
  ctx.font = '600 28px system-ui, sans-serif';
  ctx.fillStyle = '#ff5a5a';
  ctx.fillText('T A C T I C A L   D E P L O Y M E N T   Z O N E', titleSignCanvas.width / 2, 200);
}
const titleSignTexture = new THREE.CanvasTexture(titleSignCanvas);
const titleSign = new THREE.Sprite(new THREE.SpriteMaterial({ map: titleSignTexture, transparent: true, depthWrite: false }));
titleSign.scale.set(16, 4, 1);
titleSign.position.set(LOBBY_CENTER.x, 6.5, LOBBY_CENTER.z + LOBBY_HALF_SIZE - 1.5);
scene.add(titleSign);

// ---------- Shop kiosk ----------
const kioskGroup = new THREE.Group();
kioskGroup.position.set(SHOP_POSITION.x, 0, SHOP_POSITION.z);

const kioskCounter = new THREE.Mesh(
  new THREE.BoxGeometry(2.6, 1.1, 1.2),
  new THREE.MeshStandardMaterial({ color: 0x20282a, roughness: 0.6, metalness: 0.25 })
);
kioskCounter.position.y = 0.55;
kioskCounter.castShadow = true;
kioskCounter.receiveShadow = true;
kioskGroup.add(kioskCounter);

const kioskCounterTop = new THREE.Mesh(
  new THREE.BoxGeometry(2.7, 0.08, 1.3),
  new THREE.MeshStandardMaterial({ color: 0x2fe0c4, emissive: 0x0e6b5c, emissiveIntensity: 0.6, roughness: 0.4 })
);
kioskCounterTop.position.y = 1.14;
kioskGroup.add(kioskCounterTop);

const signCanvas = document.createElement('canvas');
signCanvas.width = 512;
signCanvas.height = 192;
{
  const ctx = signCanvas.getContext('2d');
  ctx.fillStyle = '#0c1517';
  ctx.fillRect(0, 0, signCanvas.width, signCanvas.height);
  ctx.strokeStyle = '#2fe0c4';
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, signCanvas.width - 12, signCanvas.height - 12);
  ctx.textAlign = 'center';
  ctx.font = '800 72px system-ui, sans-serif';
  ctx.fillStyle = '#2fe0c4';
  ctx.shadowColor = '#2fe0c4';
  ctx.shadowBlur = 20;
  ctx.fillText('ARMORY', signCanvas.width / 2, 122);
}
const kioskSign = new THREE.Mesh(
  new THREE.PlaneGeometry(2.4, 0.9),
  new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(signCanvas) })
);
kioskSign.position.set(0, 2.4, -0.62);
kioskGroup.add(kioskSign);

const kioskPostMat = new THREE.MeshStandardMaterial({ color: 0x2b2f26, roughness: 0.6 });
[-1.1, 1.1].forEach((sx) => {
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 0.12), kioskPostMat);
  post.position.set(sx, 1.2, -0.6);
  post.castShadow = true;
  kioskGroup.add(post);
});

const kioskLight = new THREE.PointLight(0x2fe0c4, 2, 8);
kioskLight.position.set(0, 2, 0.5);
kioskGroup.add(kioskLight);

scene.add(kioskGroup);

// ---------- Jump pads ----------
const jumpPads = JUMP_PADS.map((pad) => {
  const group = new THREE.Group();
  group.position.set(pad.x, 0, pad.z);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(JUMP_PAD_RADIUS, JUMP_PAD_RADIUS * 1.05, 0.15, 24),
    new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6, metalness: 0.3 })
  );
  base.position.y = 0.075;
  base.receiveShadow = true;
  group.add(base);

  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(JUMP_PAD_RADIUS * 0.82, JUMP_PAD_RADIUS * 0.82, 0.06, 24),
    new THREE.MeshStandardMaterial({ color: 0xff9a1f, emissive: 0xcc6600, emissiveIntensity: 1.1, roughness: 0.4 })
  );
  disc.position.y = 0.17;
  group.add(disc);

  const padLight = new THREE.PointLight(0xff9a1f, 1.5, 5);
  padLight.position.y = 0.6;
  group.add(padLight);

  scene.add(group);
  return { group, disc };
});

// ---------- Elevated platforms (jump-pad-only high ground) ----------
const platformTexture = makeProceduralTexture(drawCrate, 128, 1, 1);
const platformSideMat = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.7, metalness: 0.2 });
const platformTopMat = new THREE.MeshStandardMaterial({ map: platformTexture, roughness: 0.8 });
for (const p of PLATFORMS) {
  const width = p.halfX * 2;
  const depth = p.halfZ * 2;
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(width * 0.5, p.height, depth * 0.5), platformSideMat);
  pillar.position.set(p.x, p.height / 2, p.z);
  pillar.castShadow = true;
  pillar.receiveShadow = true;
  scene.add(pillar);

  const top = new THREE.Mesh(new THREE.BoxGeometry(width, 0.3, depth), platformTopMat);
  top.position.set(p.x, p.height + 0.15, p.z);
  top.castShadow = true;
  top.receiveShadow = true;
  scene.add(top);
}

// ---------- Ammo crates ----------
const ammoCrateIconCanvas = document.createElement('canvas');
ammoCrateIconCanvas.width = 128;
ammoCrateIconCanvas.height = 128;
{
  const ctx = ammoCrateIconCanvas.getContext('2d');
  ctx.fillStyle = '#ff9a1f';
  // A little bullet glyph: a rounded case with a pointed tip.
  ctx.beginPath();
  ctx.moveTo(64, 14);
  ctx.lineTo(84, 50);
  ctx.lineTo(84, 104);
  ctx.quadraticCurveTo(84, 114, 74, 114);
  ctx.lineTo(54, 114);
  ctx.quadraticCurveTo(44, 114, 44, 104);
  ctx.lineTo(44, 50);
  ctx.closePath();
  ctx.fill();
}
const ammoCrateIconTexture = new THREE.CanvasTexture(ammoCrateIconCanvas);
const ammoCrateMat = new THREE.MeshStandardMaterial({ color: 0x4a5324, roughness: 0.75, metalness: 0.1 });
const ammoCrateLidMat = new THREE.MeshStandardMaterial({ color: 0xff9a1f, emissive: 0xcc6600, emissiveIntensity: 0.9, roughness: 0.4 });

const ammoCrates = new Map();
for (const c of AMMO_CRATES) {
  const group = new THREE.Group();
  group.position.set(c.x, 0, c.z);

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.6), ammoCrateMat);
  body.position.y = 0.275;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const lidStripe = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.08, 0.62), ammoCrateLidMat);
  lidStripe.position.y = 0.56;
  group.add(lidStripe);

  const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: ammoCrateIconTexture, transparent: true, depthWrite: false }));
  icon.scale.set(0.35, 0.35, 1);
  icon.position.y = 1.05;
  group.add(icon);

  const light = new THREE.PointLight(0xff9a1f, 1, 4);
  light.position.y = 0.7;
  group.add(light);

  scene.add(group);
  ammoCrates.set(c.id, { group, icon, light, active: true });
}

function setCrateActive(id, active) {
  const crate = ammoCrates.get(id);
  if (!crate) return;
  crate.active = active;
  crate.group.visible = active;
}

// ---------- Remote player model: a proportioned human soldier ----------
// Roughly real-world head-to-body proportions (~7.5 heads tall) rather than the oversized
// "action figure" head common to blocky placeholder models — smooth capsule limbs with a
// neck joining a smaller head read as human at a glance, even built from plain primitives.
const SKIN_TONES = [0xd8a678, 0xc78e5f, 0xecc19c, 0x8d5a3c, 0xf0d0ae];
const vestMat = new THREE.MeshStandardMaterial({ color: 0xd94f4f, roughness: 0.65, metalness: 0.08 });
const pantsMat = new THREE.MeshStandardMaterial({ color: 0x33352f, roughness: 0.8, metalness: 0.05 });
const bootMat = new THREE.MeshStandardMaterial({ color: 0x161613, roughness: 0.55, metalness: 0.1 });
const helmetMat = new THREE.MeshStandardMaterial({ color: 0x2b2f26, roughness: 0.45, metalness: 0.3 });

function makeLimb(radius, length, mat) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 10), mat);
  mesh.castShadow = true;
  return mesh;
}

// A compact third-person rifle prop — same materials as the first-person view model, just
// fewer parts, since at third-person distance the extra detail wouldn't read anyway. Reuses
// gunMetalMat/gunPolymerMat/gunGripMat, which are module consts defined further down; that's
// fine because this only runs when makePlayerMesh() is later called, well after those exist.
function makeThirdPersonGun() {
  const group = new THREE.Group();
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.34), gunMetalMat);
  group.add(receiver);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.26, 8), gunMetalMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, -0.3);
  group.add(barrel);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.06, 0.16), gunPolymerMat);
  stock.position.set(0, -0.005, 0.22);
  group.add(stock);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.12, 0.05), gunGripMat);
  grip.position.set(0, -0.09, 0.1);
  grip.rotation.x = -0.28;
  group.add(grip);
  const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.15, 0.06), gunPolymerMat);
  magazine.position.set(0, -0.11, -0.04);
  magazine.rotation.x = 0.22;
  group.add(magazine);
  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, -0.43);
  group.add(muzzle);

  const flash = new THREE.PointLight(0xffcc66, 0, 2.5);
  muzzle.add(flash);

  return { group, muzzle, flash };
}

// A third-person knife prop, swapped in for the gun prop on the same arm pivot whenever the
// secondary slot is active. Built from the same realistic geometry as the first-person view
// model (see buildKnifeGroup, defined further down but hoisted — this only runs later, once
// makePlayerMesh() is actually called).
function makeThirdPersonKnife() {
  const group = buildKnifeGroup();
  group.visible = false;
  return group;
}

// Two-bone IK: given the hip's height above the ground (the foot's target is always
// straight down at y=0), solve the hip and knee angles that place the foot exactly there.
// At hipHeight === L1+L2 (fully extended) this returns {hipAngle:0, kneeBend:0} — a straight
// standing leg — so crouch and stand can share one code path with no special-casing.
const THIGH_BONE = 0.47;
const SHIN_BONE = 0.39;
const STAND_HIP_Y = THIGH_BONE + SHIN_BONE; // 0.86
function solveLegIK(hipHeight) {
  const d = THREE.MathUtils.clamp(hipHeight, 0.12, THIGH_BONE + SHIN_BONE - 0.01);
  const cosKnee = THREE.MathUtils.clamp(
    (THIGH_BONE * THIGH_BONE + SHIN_BONE * SHIN_BONE - d * d) / (2 * THIGH_BONE * SHIN_BONE), -1, 1
  );
  const kneeBend = Math.PI - Math.acos(cosKnee);
  const cosHip = THREE.MathUtils.clamp(
    (THIGH_BONE * THIGH_BONE + d * d - SHIN_BONE * SHIN_BONE) / (2 * THIGH_BONE * d), -1, 1
  );
  return { hipAngle: Math.acos(cosHip), kneeBend };
}

function makePlayerMesh() {
  const group = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({
    color: SKIN_TONES[Math.floor(Math.random() * SKIN_TONES.length)],
    roughness: 0.75,
    metalness: 0.02,
  });

  // Legs: hip pivot -> thigh + knee pivot -> shin + boot. The knee pivot lets the shin bend
  // independently of the thigh, which a single hip-only pivot can't do — needed for a real
  // bent-knee crouch/slide instead of just rigidly tilting a straight leg forward.
  const legPivots = [];
  const kneePivots = [];
  [-1, 1].forEach((side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.11, STAND_HIP_Y, 0);
    group.add(hip);
    legPivots.push(hip);

    const thigh = makeLimb(0.085, 0.3, pantsMat);
    thigh.position.set(0, -THIGH_BONE / 2, 0);
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.set(0, -THIGH_BONE, 0);
    hip.add(knee);
    kneePivots.push(knee);

    const shin = makeLimb(0.07, 0.28, pantsMat);
    shin.position.set(0, -SHIN_BONE / 2, 0);
    knee.add(shin);

    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.11, 0.24), bootMat);
    boot.position.set(0, -SHIN_BONE, 0.02);
    boot.castShadow = true;
    knee.add(boot);
  });

  // Upper body (pelvis up) rides as one group so crouch/slide can lower and lean it as a
  // unit, on top of the legs bending underneath via IK.
  const upperBody = new THREE.Group();
  group.add(upperBody);

  const pelvis = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.05, 4, 10), pantsMat);
  pelvis.rotation.z = Math.PI / 2;
  pelvis.position.y = 0.86;
  pelvis.castShadow = true;
  upperBody.add(pelvis);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.185, 0.12, 4, 10), vestMat.clone());
  torso.position.y = 1.14;
  torso.castShadow = true;
  upperBody.add(torso);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.09, 10), skinMat);
  neck.position.y = 1.43;
  neck.castShadow = true;
  upperBody.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 14), skinMat);
  head.scale.set(0.92, 1.08, 0.96); // slightly egg-shaped rather than a perfect sphere
  head.position.y = 1.58;
  head.castShadow = true;
  upperBody.add(head);

  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.56), helmetMat);
  helmet.position.y = 1.62;
  helmet.castShadow = true;
  upperBody.add(helmet);

  // Arms: a shoulder pivot per side holds the upper arm/forearm, same rigging idea as the legs.
  const shoulderY = 1.34;
  const armPivots = [];
  let gunProp = null;
  let knifeProp = null;
  [-1, 1].forEach((side) => {
    const isSupportHand = side === -1; // left hand grips the handguard — a two-handed hold
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.24, shoulderY, 0);
    // The support hand's shoulder rotates inward/forward to reach across the body to the
    // gun's foregrip, instead of hanging naturally at the side like the right (gun) arm.
    pivot.rotation.z = isSupportHand ? 0.34 : side * 0.14;
    upperBody.add(pivot);
    armPivots.push(pivot);

    const upperArm = makeLimb(0.06, 0.26, vestMat);
    upperArm.position.set(0, 1.3 - shoulderY, 0);
    pivot.add(upperArm);

    const forearm = makeLimb(0.052, 0.26, skinMat);
    forearm.position.set(side * 0.03, 1.03 - shoulderY, 0.04);
    forearm.rotation.x = isSupportHand ? -0.6 : -0.32;
    forearm.rotation.z = isSupportHand ? -0.3 : side * -0.04;
    pivot.add(forearm);

    // A simplified rifle prop on the right arm, so third-person (self or remote) shows a
    // held weapon rather than empty hands. Rides the shoulder pivot, so it swings with the
    // arm during the walk cycle same as everything else on this joint chain. The knife prop
    // sits at the same spot and is toggled with it based on which slot is active.
    if (side === 1) {
      gunProp = makeThirdPersonGun();
      gunProp.group.position.set(0.03, 1.03 - shoulderY - 0.05, 0.16);
      gunProp.group.rotation.set(-0.32, 0, 0);
      pivot.add(gunProp.group);

      knifeProp = makeThirdPersonKnife();
      knifeProp.position.set(0.03, 1.03 - shoulderY - 0.05, 0.16);
      knifeProp.rotation.set(-0.32, 0, 0);
      pivot.add(knifeProp);
    }
  });

  const nameSprite = makeNameSprite('');
  nameSprite.position.y = 2.0;
  upperBody.add(nameSprite);
  group.userData.nameSprite = nameSprite;
  group.userData.body = torso; // tinted per-frame to signal lobby (blue) vs in-arena (red)
  group.userData.legPivots = legPivots; // [left, right] — animated by the walk cycle
  group.userData.kneePivots = kneePivots;
  group.userData.armPivots = armPivots;
  group.userData.upperBody = upperBody; // lowered + leaned as a unit for crouch/slide
  group.userData.gunMuzzle = gunProp.muzzle;
  group.userData.gunFlash = gunProp.flash;
  group.userData.gunPropGroup = gunProp.group;
  group.userData.knifePropGroup = knifeProp;
  group.userData.recoil = 0;
  return group;
}

// Drives one character's full lower-body pose: crouch/slide depth (via solveLegIK), a
// forward lean for the upper body, and the walk-cycle swing layered on top of the IK's base
// hip angle. `state` is a small persisted {hipY, lean, walkPhase, walkAmp} object owned by
// the caller (per remote player, or the one shared by the local third-person model) so this
// stays a pure function shared by both — no duplicated pose logic between them.
const CROUCH_HIP_Y = 0.6;
const SLIDE_HIP_Y = 0.5;
const CROUCH_LEAN = 0.12;
const SLIDE_LEAN = 0.5;
const RUN_LEAN = 0.09;
function updateCharacterPose(mesh, state, dt, crouching, sliding, isMoving) {
  // "Running" is upright movement (not crouched, not sliding) — the default move speed reads
  // as a jog/sprint rather than a stroll, so it gets its own bigger, bouncier cycle instead of
  // reusing the crouch-walk's smaller one.
  const running = isMoving && !crouching && !sliding;

  const targetHipY = sliding ? SLIDE_HIP_Y : crouching ? CROUCH_HIP_Y : STAND_HIP_Y;
  const targetLean = sliding ? SLIDE_LEAN : crouching ? CROUCH_LEAN : running ? RUN_LEAN : 0;
  state.hipY += (targetHipY - state.hipY) * Math.min(1, dt * 8);
  state.lean += (targetLean - state.lean) * Math.min(1, dt * 8);

  const cycling = isMoving && !sliding; // crouch-walk and run both cycle; sliding holds a fixed pose
  state.walkAmp += ((cycling ? 1 : 0) - state.walkAmp) * Math.min(1, dt * 8);
  if (cycling) state.walkPhase += dt * (crouching ? 6 : 11.5);
  const swingAmplitude = crouching ? 0.4 : 0.72;
  const swing = state.walkAmp > 0.001 ? Math.sin(state.walkPhase) * swingAmplitude * state.walkAmp : 0;

  const { hipAngle, kneeBend } = solveLegIK(state.hipY);
  const [legL, legR] = mesh.userData.legPivots;
  const [kneeL, kneeR] = mesh.userData.kneePivots;
  legL.position.y = state.hipY;
  legR.position.y = state.hipY;
  legL.rotation.x = hipAngle + swing;
  legR.rotation.x = hipAngle - swing;
  // A running stride bends the trailing knee harder than a crouch-walk's shuffle.
  kneeL.rotation.x = -kneeBend - (running ? Math.max(0, -swing) * 0.9 : 0);
  kneeR.rotation.x = -kneeBend - (running ? Math.max(0, swing) * 0.9 : 0);

  const [armL, armR] = mesh.userData.armPivots;
  const armAmplitude = running ? 1.1 : 0.8;
  // The support hand (left) stays mostly anchored to the grip rather than swinging freely —
  // a real two-handed hold wouldn't pump back and forth the way a loose arm does.
  armL.rotation.x = -swing * armAmplitude * 0.3;
  armR.rotation.x = swing * armAmplitude - mesh.userData.recoil * 0.5;

  // A running bounce (double the stride frequency — one bob per footfall) layered on top of
  // the crouch/slide height offset, so a sprint reads as bouncier than a walk or crouch-shuffle.
  const bob = running && state.walkAmp > 0.001 ? Math.abs(Math.sin(state.walkPhase)) * 0.045 * state.walkAmp : 0;
  mesh.userData.upperBody.position.y = state.hipY - STAND_HIP_Y + bob;
  mesh.userData.upperBody.rotation.x = state.lean;

  // Wall kick: a brief, distinct "just pushed off" pose layered on top of everything above —
  // knees tuck up hard, thighs kick forward, arms throw up for balance, torso leans back away
  // from the wall. Decays out over ~0.4s (see triggerWallKickPose for how this gets set to 1).
  if (state.wallKickAnim > 0) {
    const kick = state.wallKickAnim;
    kneeL.rotation.x -= kick * 1.2;
    kneeR.rotation.x -= kick * 1.2;
    legL.rotation.x += kick * 0.4;
    legR.rotation.x += kick * 0.4;
    armL.rotation.x -= kick * 0.8;
    armR.rotation.x -= kick * 0.8;
    mesh.userData.upperBody.rotation.x -= kick * 0.35;
    state.wallKickAnim = Math.max(0, kick - dt * 2.5);
  }

  mesh.userData.recoil = Math.max(0, mesh.userData.recoil - dt * 8);
  // No muzzle flash while the knife is out — the flash light lives on the gun prop, which is
  // hidden in that state anyway, but the recoil-driven arm kick above still plays for the
  // knife swing itself.
  mesh.userData.gunFlash.intensity = mesh.userData.recoil > 0.7 && mesh.userData.gunPropGroup.visible ? 3 : 0;
}

// Called once when a character (self or remote) fires, so third-person shooting is visible:
// a muzzle flash at the gun's barrel tip and a recoil kick that jolts the right arm back,
// both of which decay automatically in updateCharacterPose's per-frame recoil falloff above.
function triggerThirdPersonShot(mesh) {
  mesh.userData.recoil = 1;
}

function makeNameSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const draw = (t) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 32px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(t, canvas.width / 2 + 1, 41);
    ctx.fillStyle = '#fff';
    ctx.fillText(t, canvas.width / 2, 40);
  };
  draw(text);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, 0.4, 1);
  sprite.userData.setText = (t) => { draw(t); texture.needsUpdate = true; };
  return sprite;
}

// Cover boxes rendered from server-provided list (received on init).
// Thin long shapes are structural walls (cream concrete, like the boundary); roughly
// cube-shaped ones are crates (cream body, teal accent stripe).
const crateTexture = makeProceduralTexture(drawCrate, 128, 1, 1);
const crateMat = new THREE.MeshStandardMaterial({ map: crateTexture, roughness: 0.85 });
const structureMat = new THREE.MeshStandardMaterial({ color: 0xdcd3bf, roughness: 0.85 });
function addCoverBoxes(boxes) {
  for (const b of boxes) {
    const isWall = b.sx === 1 || b.sz === 1;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.sx, b.sy, b.sz), isWall ? structureMat : crateMat);
    mesh.position.set(b.x, b.sy / 2, b.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

// ---------- Gun view model: a multi-part carbine, attached to the camera ----------
const gunMetalTexture = makeProceduralTexture(drawBrushedMetal, 128, 2, 2);
const gunPolymerTexture = makeProceduralTexture(drawPolymerGrain, 128, 1, 1);
const gunGripTexture = makeProceduralTexture(drawRubberGrip, 128, 1, 2);
const gunMetalMat = new THREE.MeshStandardMaterial({ map: gunMetalTexture, color: 0x9aa0a8, roughness: 0.35, metalness: 0.85 });
const gunPolymerMat = new THREE.MeshStandardMaterial({ map: gunPolymerTexture, color: 0x8a8a8a, roughness: 0.6, metalness: 0.2 });
const gunGripMat = new THREE.MeshStandardMaterial({ map: gunGripTexture, color: 0x9a9a9a, roughness: 0.75, metalness: 0.1 });

// ---------- Knife: a tactical fixed-blade combat knife, built from real proportions ----------
// (~7cm handle, ~12cm blade) rather than a flat slab — a full-tang taper, a distinct guard,
// a pommel with a lanyard hole, and a grip with actual finger-ridge geometry.
const knifeBladeMat = new THREE.MeshStandardMaterial({ map: gunMetalTexture, color: 0xc7ccd1, roughness: 0.28, metalness: 0.95 });
const knifeEdgeMat = new THREE.MeshStandardMaterial({ color: 0xd7dade, roughness: 0.15, metalness: 0.95 });
const knifeGuardMat = new THREE.MeshStandardMaterial({ map: gunMetalTexture, color: 0x8a8f94, roughness: 0.5, metalness: 0.75 });
const knifeGripMat = new THREE.MeshStandardMaterial({ map: gunGripTexture, color: 0x8f9384, roughness: 0.85, metalness: 0.05 });
const knifePommelMat = new THREE.MeshStandardMaterial({ map: gunMetalTexture, color: 0xa0a0a0, roughness: 0.4, metalness: 0.8 });

function buildKnifeGroup() {
  const group = new THREE.Group();
  // Local +Z is toward the pommel/hand, -Z is toward the tip — same convention as the blade
  // taper below, so the whole knife reads correctly once attached hilt-first to a hand/pivot.

  // Blade: a tapered body (wide at the guard, narrowing toward the tip) plus a pyramidal
  // point, with a thin brighter edge strip along the bottom to read as a sharpened bevel.
  const bladeLength = 0.16;
  const bladeBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.021, bladeLength, 4, 1, false, Math.PI / 4),
    knifeBladeMat
  );
  bladeBase.scale.set(1, 1, 0.22); // squash the 4-sided cylinder into a flat tapered blade
  bladeBase.rotation.x = -Math.PI / 2;
  bladeBase.position.set(0, 0, -0.08);
  group.add(bladeBase);

  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.045, 4), knifeBladeMat);
  tip.scale.set(1, 1, 0.22);
  tip.rotation.x = -Math.PI / 2;
  tip.rotation.y = Math.PI / 4;
  tip.position.set(0, 0, -0.16 - 0.018);
  group.add(tip);

  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, bladeLength + 0.03), knifeEdgeMat);
  edge.position.set(0, -0.009, -0.09);
  group.add(edge);

  // Guard: a small crossbar between blade and handle.
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.016, 0.016), knifeGuardMat);
  guard.position.set(0, 0, 0.005);
  group.add(guard);

  // Handle: a tapered rubberized grip with a few raised finger-ridge rings, not just a bare
  // cylinder — this is what mainly sells "real tool" over "gray blob".
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.021, 0.11, 10), knifeGripMat);
  handle.rotation.x = Math.PI / 2;
  handle.position.set(0, 0, 0.065);
  group.add(handle);
  for (let i = 0; i < 4; i++) {
    const ridge = new THREE.Mesh(new THREE.TorusGeometry(0.019, 0.0035, 6, 12), knifeGripMat);
    ridge.position.set(0, 0, 0.03 + i * 0.022);
    group.add(ridge);
  }

  // Pommel: a capped end with a lanyard hole, so the handle doesn't just stop abruptly.
  const pommel = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.019, 0.018, 10), knifePommelMat);
  pommel.rotation.x = Math.PI / 2;
  pommel.position.set(0, 0, 0.128);
  group.add(pommel);
  const lanyardHole = new THREE.Mesh(new THREE.TorusGeometry(0.007, 0.0025, 6, 10), knifePommelMat);
  lanyardHole.position.set(0, 0, 0.135);
  group.add(lanyardHole);

  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return group;
}

const gunGroup = new THREE.Group();
gunGroup.position.set(0.26, -0.24, -0.5);
gunGroup.rotation.y = -0.02;

const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.42), gunMetalMat);
receiver.position.set(0, 0, 0);
gunGroup.add(receiver);

const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.34, 10), gunMetalMat);
barrel.rotation.x = Math.PI / 2;
barrel.position.set(0, 0.015, -0.42);
gunGroup.add(barrel);

const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.065, 0.26), gunPolymerMat);
handguard.position.set(0, -0.005, -0.32);
gunGroup.add(handguard);

const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.22), gunPolymerMat);
stock.position.set(0, -0.01, 0.28);
gunGroup.add(stock);

const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.16, 0.06), gunGripMat);
grip.position.set(0, -0.13, 0.13);
grip.rotation.x = -0.28;
gunGroup.add(grip);

const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.08), gunPolymerMat);
magazine.position.set(0, -0.17, -0.06);
magazine.rotation.x = 0.22;
gunGroup.add(magazine);

const sightPost = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.02), gunMetalMat);
sightPost.position.set(0, 0.09, -0.14);
gunGroup.add(sightPost);
const sightPost2 = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.045, 0.02), gunMetalMat);
sightPost2.position.set(0, 0.085, -0.36);
gunGroup.add(sightPost2);

const muzzle = new THREE.Object3D();
muzzle.position.set(0, 0.015, -0.6);
gunGroup.add(muzzle);

gunGroup.traverse((o) => { if (o.isMesh) o.castShadow = false; });
camera.add(gunGroup);
scene.add(camera);

const gunRestPos = gunGroup.position.clone();
let recoil = 0;
let bobPhase = 0;
let padPulse = 0;

// First-person knife view model — shown instead of the gun while the secondary slot is
// active. Same camera-relative rig as the gun (rest position, recoil kick, sway), built from
// the shared realistic knife geometry (see buildKnifeGroup above).
const knifeGroup = buildKnifeGroup();
knifeGroup.position.set(0.22, -0.2, -0.38);
knifeGroup.rotation.set(-0.15, -0.35, 0.2);
knifeGroup.scale.setScalar(1.6); // a bit larger up close, like an FPS view-model convention
knifeGroup.visible = false;
knifeGroup.traverse((o) => { if (o.isMesh) o.castShadow = false; });
camera.add(knifeGroup);
const knifeRestPos = knifeGroup.position.clone();

// Muzzle flash
const flash = new THREE.PointLight(0xffcc66, 0, 4);
flash.position.set(0.26, -0.225, -1.1);
camera.add(flash);
let flashTimer = 0;

// ---------- Tracer pool ----------
const tracerMat = new THREE.LineBasicMaterial({ color: 0xfff2b0 });
const tracers = [];
function spawnTracer(from, to) {
  const geom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(from.x, from.y, from.z),
    new THREE.Vector3(to.x, to.y, to.z),
  ]);
  const line = new THREE.Line(geom, tracerMat.clone());
  line.material.transparent = true;
  scene.add(line);
  tracers.push({ line, life: 0.08 });
}

// ---------- Blood VFX ----------
const bloodGeo = new THREE.BoxGeometry(0.06, 0.06, 0.06);
const bloodMat = new THREE.MeshBasicMaterial({ color: 0x8a0e0e, transparent: true });
const bloodParticles = [];

function spawnBlood(origin) {
  const count = 10 + Math.floor(Math.random() * 6);
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(bloodGeo, bloodMat.clone());
    mesh.position.set(
      origin.x + (Math.random() - 0.5) * 0.2,
      origin.y + (Math.random() - 0.5) * 0.2,
      origin.z + (Math.random() - 0.5) * 0.2
    );
    const speed = 2 + Math.random() * 3;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI * 0.6 + 0.2;
    mesh.userData.velocity = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta) * speed,
      Math.cos(phi) * speed,
      Math.sin(phi) * Math.sin(theta) * speed
    );
    scene.add(mesh);
    bloodParticles.push({ mesh, life: 0.5, maxLife: 0.5 });
  }
}

// ---------- Input ----------
const keys = new Set();
let yaw = 0;
let pitch = 0;
const MAX_PITCH = Math.PI / 2 - 0.05;

const CROUCH_KEYS = ['ControlLeft', 'ControlRight', 'KeyC'];

window.addEventListener('keydown', (e) => {
  const wasHeld = keys.has(e.code);
  keys.add(e.code);
  if (wasHeld) return; // ignore OS key-repeat, only act on the edge

  if (e.code === 'KeyB' && started && !inArena) {
    if (shopOpen) {
      setShopOpen(false);
    } else if (nearShop) {
      setShopOpen(true);
    }
    return;
  }

  if (e.code === 'KeyE' && started && !shopOpen) {
    startDoorHold();
    return;
  }

  if (!alive || !started || shopOpen) return;
  if (e.code === 'Space') {
    tryJump();
  } else if (CROUCH_KEYS.includes(e.code)) {
    tryCrouchPress();
  } else if (e.code === 'KeyR') {
    tryReload();
  } else if (e.code === 'Digit1') {
    trySwitchSlot('primary');
  } else if (e.code === 'Digit2') {
    trySwitchSlot('secondary');
  }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'KeyE') stopDoorHold();
});

// Pointer Lock is a nice-to-have (captures + hides the cursor) but some embedding contexts
// (iframes, sandboxed previews) block it outright. Gameplay must not depend on it succeeding —
// `started` is the real gate, set as soon as the player clicks, regardless of lock outcome.
let started = false;

overlay.addEventListener('click', () => {
  started = true;
  overlay.classList.add('hidden');
  renderer.domElement.requestPointerLock?.().catch(() => {});
});

// Escape releases the cursor without pausing the game (see below) — tracked here rather than
// via actual pointer-lock state, because pointer lock is best-effort and some embedding
// contexts (iframes, sandboxed previews) block it outright. Looking around still has to work
// there via raw, unlocked mousemove deltas (as it always has), so this flag — not lock state —
// is what actually gates rotation/firing; it only ever becomes true from an explicit Escape.
let cursorReleased = false;

// Clicking back into the game while it's already running (mouse just isn't captured — e.g.
// after Escape) should silently re-lock the cursor, not reopen the deploy overlay.
window.addEventListener('mousedown', (e) => {
  if (started && cursorReleased && e.button === 0) {
    cursorReleased = false;
    renderer.domElement.requestPointerLock?.().catch(() => {});
  }
});

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || !started) return;
  if (shopOpen) {
    setShopOpen(false);
    return;
  }
  // Just release the cursor — gameplay keeps running, no "click to deploy" overlay.
  cursorReleased = true;
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
});

window.addEventListener('mousemove', (e) => {
  if (!started || shopOpen || cursorReleased) return;
  yaw -= e.movementX * 0.0022;
  pitch -= e.movementY * 0.0022;
  pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
});

window.addEventListener('mousedown', (e) => {
  if (!started || shopOpen) return;
  // If the cursor is released, this click is re-locking it (see the listener above), not
  // firing — otherwise clicking back into the game after Escape would also shoot.
  if (cursorReleased) return;
  if (e.button === 0) tryShoot();
  else if (e.button === 2) tryStab();
});
window.addEventListener('contextmenu', (e) => {
  if (started) e.preventDefault(); // right-click is the knife backstab, not a browser menu
});

// ---------- Networked state ----------
let selfId = null;
let alive = true;
let inArena = false;
let health = PLAYER_MAX_HEALTH;
let money = STARTING_MONEY;
let weaponId = DEFAULT_WEAPON_ID;
let hasArmor = false;
let activeSlot = DEFAULT_SLOT; // 'primary' or 'secondary' (knife) — server-authoritative
let ammo = 0;
let reserveAmmo = 0;
let reloading = false;
function currentWeapon() {
  if (activeSlot === 'secondary') return KNIFE_WEAPON;
  return SHOP_WEAPONS.find((w) => w.id === weaponId) || SHOP_WEAPONS[0];
}
function updateAmmoHud() {
  ammoEl.textContent = activeSlot === 'secondary' ? '∞' : reloading ? 'RELOADING…' : `${ammo} / ${reserveAmmo}`;
  updateSlotUI();
}
function updateSlotUI() {
  const primaryName = SHOP_WEAPONS.find((w) => w.id === weaponId)?.name || 'Rifle';
  slotPrimaryNameEl.textContent = primaryName;
  slotPrimaryEl.classList.toggle('active', activeSlot === 'primary');
  slotSecondaryEl.classList.toggle('active', activeSlot === 'secondary');
}
// Starts in the lobby, not the world origin (which sits in the middle of the arena) — this is
// the position used until the server's INIT message arrives and corrects it, and the only
// position ever used if there's no server at all (e.g. a static deployment with no backend).
const self = { x: 0, y: 1, z: LOBBY_CENTER.z };
const moveState = createMovementState();
let eyeHeight = STAND_EYE_HEIGHT;

// ---------- Third person (F4) ----------
const THIRD_PERSON_DISTANCE = 3.5;
let thirdPerson = false;
const selfMesh = makePlayerMesh();
selfMesh.visible = false;
selfMesh.userData.nameSprite.visible = false; // no floating nametag over your own head
scene.add(selfMesh);
const selfPoseState = { hipY: STAND_HIP_Y, lean: 0, walkPhase: 0, walkAmp: 0, wallKickAnim: 0 };

// Wall kick pose: legs kick back and tuck as if just pushing off a surface, torso leans away
// from it, arms throw up for balance — a distinct silhouette from a normal jump, decaying out
// over ~0.4s (see updateCharacterPose). Used for both the local player and remote players (via
// the MSG.WALLKICK broadcast), since a normal jump gives no such signal on its own.
function triggerWallKickPose(poseState) {
  poseState.wallKickAnim = 1;
}

function setThirdPerson(on) {
  thirdPerson = on;
  gunGroup.visible = !on;
  selfMesh.visible = on;
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'F4') {
    e.preventDefault();
    setThirdPerson(!thirdPerson);
  }
});
/** @type {Map<string, {target: THREE.Group, x:number,y:number,z:number,yaw:number,name:string,health:number}>} */
const remotePlayers = new Map();
const scores = new Map(); // id -> { name, kills, deaths }

let lastShotAt = 0;

function tryJump() {
  if (moveState.sliding) return;
  const result = attemptJump(moveState, self.x, self.z);
  if (result) {
    net.send({ type: MSG.JUMP });
    if (result === 'wallkick') triggerWallKickPose(selfPoseState);
  }
}

function tryCrouchPress() {
  if (!moveState.grounded || moveState.sliding) return;
  let forward = 0;
  let right = 0;
  if (keys.has('KeyW')) forward += 1;
  if (keys.has('KeyS')) forward -= 1;
  if (keys.has('KeyD')) right += 1;
  if (keys.has('KeyA')) right -= 1;
  if (Math.hypot(forward, right) <= SLIDE_MIN_INPUT) return;
  const dir = computeWorldDir(yaw, forward, right);
  applySlideStart(moveState, dir.x, dir.z);
  if (moveState.sliding) net.send({ type: MSG.SLIDE });
}

function tryShoot() {
  if (!alive || !inArena) return;
  const usingKnife = activeSlot === 'secondary';
  if (!usingKnife && (reloading || ammo <= 0)) return;
  const now = performance.now();
  if (now - lastShotAt < currentWeapon().fireCooldownMs) return;
  lastShotAt = now;
  net.send({ type: MSG.SHOOT });
  if (!usingKnife) {
    ammo -= 1;
    updateAmmoHud();
  }
  recoil = 1;
  triggerThirdPersonShot(selfMesh);

  // Knife swings get the recoil-driven arm animation above but no muzzle flash or bullet
  // tracer — those are gunfire-only VFX.
  if (usingKnife) return;

  // Local tracer prediction from gun muzzle toward aim direction (visual only; server decides real hits).
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const muzzleWorld = new THREE.Vector3();
  if (thirdPerson) {
    selfMesh.userData.gunMuzzle.getWorldPosition(muzzleWorld);
  } else {
    flashTimer = 0.05;
    flash.intensity = 4;
    muzzle.getWorldPosition(muzzleWorld);
  }
  const end = muzzleWorld.clone().addScaledVector(dir, currentWeapon().range);
  spawnTracer(muzzleWorld, end);
}

let lastStabAt = 0;
function tryStab() {
  if (!alive || !inArena || activeSlot !== 'secondary') return;
  const now = performance.now();
  if (now - lastStabAt < KNIFE_WEAPON.stabCooldownMs) return;
  lastStabAt = now;
  net.send({ type: MSG.STAB });
  recoil = 1;
  triggerThirdPersonShot(selfMesh);
}

function tryReload() {
  if (!alive || !inArena || reloading || activeSlot === 'secondary') return;
  if (ammo >= currentWeapon().magSize || reserveAmmo <= 0) return;
  net.send({ type: MSG.RELOAD });
}

function trySwitchSlot(slot) {
  if (!alive || activeSlot === slot) return;
  net.send({ type: MSG.SWITCH, slot });
}

const net = new Net({
  onOpen() {},
  onClose() {},
  onMessage(msg) {
    switch (msg.type) {
      case MSG.INIT: {
        selfId = msg.id;
        self.x = msg.self.x;
        self.y = msg.self.y;
        self.z = msg.self.z;
        health = msg.self.health;
        inArena = msg.self.inArena;
        money = msg.self.money;
        weaponId = msg.self.weaponId;
        hasArmor = msg.self.armor;
        ammo = msg.self.ammo;
        reserveAmmo = msg.self.reserveAmmo;
        activeSlot = msg.self.activeSlot;
        moneyEl.textContent = `$${money}`;
        weaponNameEl.textContent = currentWeapon().name;
        updateAmmoHud();
        lobbyHintEl.classList.toggle('hidden', inArena);
        buildShopUI(msg.shop);
        for (const c of msg.crates) setCrateActive(c.id, c.active);
        addCoverBoxes(msg.coverBoxes);
        for (const p of msg.players) {
          scores.set(p.id, { name: p.name, kills: p.kills, deaths: p.deaths });
          if (p.id === selfId) continue;
          addRemotePlayer(p);
        }
        updateScoreboard();
        break;
      }
      case MSG.JOIN: {
        if (msg.player.id === selfId) break;
        addRemotePlayer(msg.player);
        break;
      }
      case MSG.LEAVE: {
        removeRemotePlayer(msg.id);
        break;
      }
      case MSG.STATE: {
        for (const p of msg.players) {
          scores.set(p.id, { name: p.name, kills: p.kills, deaths: p.deaths });
          if (p.id === selfId) {
            // Movement is client-predicted for responsiveness, but nothing ever corrected it
            // against the server's authoritative position — on a wall-heavy map, collision
            // resolution can drift enough apart that you're rendered standing on a pickup
            // while the server (which is what actually gates it) still has you just outside
            // its radius. Snap back in line whenever the drift gets large enough to matter.
            const drift = Math.hypot(p.x - self.x, p.y - self.y, p.z - self.z);
            if (drift > 0.75) {
              self.x = p.x;
              self.y = p.y;
              self.z = p.z;
            }
            continue;
          }
          let rp = remotePlayers.get(p.id);
          if (!rp) {
            addRemotePlayer(p);
            rp = remotePlayers.get(p.id);
          }
          // Movement is detected from consecutive server positions (not client-side input we
          // don't have for other players), so the walk cycle reflects their real speed.
          const movedDist = Math.hypot(p.x - rp.targetX, p.z - rp.targetZ);
          rp.isMoving = movedDist > 0.01 && p.alive;
          rp.targetX = p.x;
          rp.targetY = p.y;
          rp.targetZ = p.z;
          rp.yaw = p.yaw;
          rp.health = p.health;
          rp.alive = p.alive;
          rp.crouching = p.crouching;
          rp.sliding = p.sliding;
          rp.inArena = p.inArena;
          rp.activeSlot = p.activeSlot;
        }
        updateScoreboard();
        break;
      }
      case MSG.SHOOT: {
        if (msg.id === selfId) break; // already drew local tracer
        const rp = remotePlayers.get(msg.id);
        if (!rp) break;
        if (rp.activeSlot !== 'secondary') {
          const from = new THREE.Vector3(msg.origin.x, msg.origin.y, msg.origin.z);
          const end = from.clone().addScaledVector(new THREE.Vector3(msg.dir.x, msg.dir.y, msg.dir.z), 120);
          spawnTracer(from, end);
        }
        triggerThirdPersonShot(rp.mesh);
        break;
      }
      case MSG.HIT: {
        if (msg.targetId === selfId) {
          health = msg.health;
          healthEl.textContent = `${health} HP`;
          const hitHeight = moveState.crouching ? 0.55 : 0.9;
          spawnBlood({ x: self.x, y: self.y + hitHeight, z: self.z });
          flashDamage();
        } else {
          const rp = remotePlayers.get(msg.targetId);
          if (rp) {
            rp.health = msg.health;
            const hitHeight = rp.crouching || rp.sliding ? 0.55 : 0.9;
            spawnBlood({ x: rp.x, y: rp.y + hitHeight, z: rp.z });
          }
        }
        break;
      }
      case MSG.KILL: {
        addKillFeedLine(msg.killerId, msg.victimId);
        if (msg.victimId === selfId) {
          alive = false;
          respawnEl.classList.add('show');
        }
        break;
      }
      case MSG.RESPAWN: {
        if (msg.id === selfId) {
          self.x = msg.x;
          self.y = msg.y;
          self.z = msg.z;
          health = msg.health;
          alive = true;
          moveState.vy = 0;
          moveState.grounded = true;
          moveState.sliding = false;
          respawnEl.classList.remove('show');
          healthEl.textContent = `${health} HP`;
        } else {
          const rp = remotePlayers.get(msg.id);
          if (rp) {
            rp.targetX = msg.x;
            rp.targetY = msg.y;
            rp.targetZ = msg.z;
            rp.x = msg.x;
            rp.y = msg.y;
            rp.z = msg.z;
            rp.health = msg.health;
            rp.alive = true;
          }
        }
        break;
      }
      case MSG.ENTER: {
        doorOpenTarget = 1;
        if (msg.id === selfId) {
          self.x = msg.x;
          self.y = msg.y;
          self.z = msg.z;
          health = msg.health;
          inArena = true;
          moveState.vy = 0;
          moveState.grounded = true;
          moveState.sliding = false;
          lobbyHintEl.classList.add('hidden');
          setShopOpen(false);
        } else {
          const rp = remotePlayers.get(msg.id);
          if (rp) {
            rp.targetX = msg.x;
            rp.targetY = msg.y;
            rp.targetZ = msg.z;
            rp.x = msg.x;
            rp.y = msg.y;
            rp.z = msg.z;
            rp.health = msg.health;
            rp.inArena = true;
          }
        }
        break;
      }
      case MSG.MONEY: {
        money = msg.money;
        moneyEl.textContent = `$${money}`;
        refreshShopUI();
        break;
      }
      case MSG.LOADOUT: {
        weaponId = msg.weaponId;
        hasArmor = msg.armor;
        ammo = msg.ammo;
        reserveAmmo = msg.reserveAmmo;
        weaponNameEl.textContent = currentWeapon().name;
        updateAmmoHud();
        refreshShopUI();
        break;
      }
      case MSG.AMMO: {
        ammo = msg.ammo;
        reserveAmmo = msg.reserveAmmo;
        reloading = msg.reloading;
        updateAmmoHud();
        break;
      }
      case MSG.CRATE: {
        setCrateActive(msg.id, msg.active);
        break;
      }
      case MSG.DOOR_PROGRESS: {
        doorProgressFillEl.style.width = `${msg.progress * 100}%`;
        break;
      }
      case MSG.SWITCH: {
        activeSlot = msg.slot;
        weaponNameEl.textContent = currentWeapon().name;
        updateAmmoHud();
        break;
      }
      case MSG.STAB: {
        if (msg.id === selfId) break; // already showed our own lunge locally
        const rp = remotePlayers.get(msg.id);
        if (rp) triggerThirdPersonShot(rp.mesh);
        break;
      }
      case MSG.BACKSTAB: {
        lastBackstabVictimId = msg.targetId;
        if (msg.targetId === selfId) flashDamage();
        break;
      }
      case MSG.WALLKICK: {
        const rp = remotePlayers.get(msg.id);
        if (rp) triggerWallKickPose(rp);
        break;
      }
    }
  },
});

function addRemotePlayer(p) {
  const mesh = makePlayerMesh();
  mesh.userData.nameSprite.userData.setText(p.name);
  scene.add(mesh);
  remotePlayers.set(p.id, {
    mesh,
    x: p.x, y: p.y, z: p.z,
    targetX: p.x, targetY: p.y, targetZ: p.z,
    yaw: p.yaw || 0,
    name: p.name,
    health: p.health,
    alive: p.alive !== false,
    crouching: p.crouching || false,
    sliding: p.sliding || false,
    inArena: p.inArena || false,
    activeSlot: p.activeSlot || 'primary',
    hipY: STAND_HIP_Y,
    lean: 0,
    walkPhase: 0,
    walkAmp: 0,
    wallKickAnim: 0,
    isMoving: false,
  });
  scores.set(p.id, { name: p.name, kills: p.kills || 0, deaths: p.deaths || 0 });
}

function removeRemotePlayer(id) {
  const rp = remotePlayers.get(id);
  if (rp) {
    scene.remove(rp.mesh);
    remotePlayers.delete(id);
  }
  scores.delete(id);
}

let lastBackstabVictimId = null;
function addKillFeedLine(killerId, victimId) {
  const killerName = killerId === selfId ? 'You' : (scores.get(killerId)?.name || '???');
  const victimName = victimId === selfId ? 'You' : (scores.get(victimId)?.name || '???');
  const verb = victimId === lastBackstabVictimId ? 'backstabbed' : '⚔';
  lastBackstabVictimId = null;
  const line = document.createElement('div');
  line.textContent = `${killerName} ${verb} ${victimName}`;
  killfeedEl.prepend(line);
  setTimeout(() => line.remove(), 4000);
}

function updateScoreboard() {
  const rows = [...scores.entries()]
    .sort((a, b) => b[1].kills - a[1].kills)
    .slice(0, 8)
    .map(([id, s]) => `${id === selfId ? 'You' : s.name}: ${s.kills}/${s.deaths}`);
  scoreboardEl.innerHTML = rows.join('<br>');
}

// ---------- Movement (client-predicted, cover collision matches server) ----------
// Cover boxes, walls, and crates block horizontal movement below their top — but once you're
// at or above that height (mantled onto one, or clearing it mid-jump), the same footprint no
// longer blocks you, so you can stand and walk around on top.
function collidesWithCover(x, z, y, radius) {
  for (const box of CLIENT_COVER) {
    const hx = box.sx / 2 + radius;
    const hz = box.sz / 2 + radius;
    if (Math.abs(x - box.x) < hx && Math.abs(z - box.z) < hz && y < box.sy - 0.05) return true;
  }
  const doorHalfX = DOOR_GAP_HALF_WIDTH + radius;
  const doorHalfZ = 0.5 + radius;
  if (Math.abs(x - DOOR_POSITION.x) < doorHalfX && Math.abs(z - DOOR_POSITION.z) < doorHalfZ) return true;
  return false;
}

let inputSendAccum = 0;

function updateMovement(dt) {
  let forward = 0;
  let right = 0;
  let crouch = false;
  if (alive && started && !shopOpen) {
    if (keys.has('KeyW')) forward += 1;
    if (keys.has('KeyS')) forward -= 1;
    if (keys.has('KeyD')) right += 1;
    if (keys.has('KeyA')) right -= 1;
    crouch = CROUCH_KEYS.some((k) => keys.has(k));
  }

  stepMovement(moveState, self, { forward, right, yaw, crouch }, dt * 1000, collidesWithCover, clampToWorld);

  if (inArena && moveState.grounded) {
    for (const pad of JUMP_PADS) {
      if (Math.hypot(self.x - pad.x, self.z - pad.z) < JUMP_PAD_RADIUS) {
        moveState.vy = JUMP_PAD_VELOCITY;
        moveState.grounded = false;
        moveState.sliding = false;
        break;
      }
    }
  }

  if (!inArena && shopData) {
    nearShop = Math.hypot(self.x - shopData.position.x, self.z - shopData.position.z) < shopData.radius;
    shopHintEl.classList.toggle('hidden', !nearShop || shopOpen);
  } else {
    nearShop = false;
    shopHintEl.classList.add('hidden');
  }

  if (!inArena) {
    nearDoor = Math.hypot(self.x - DOOR_POSITION.x, self.z - DOOR_POSITION.z) < DOOR_RADIUS;
    doorHintEl.classList.toggle('hidden', !nearDoor || shopOpen);
    if (!nearDoor && doorHolding) stopDoorHold();
  } else {
    nearDoor = false;
    doorHintEl.classList.add('hidden');
  }

  const crouchedPose = moveState.crouching || moveState.sliding;
  const targetEye = crouchedPose ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT;
  eyeHeight += (targetEye - eyeHeight) * Math.min(1, dt * 10);

  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  if (thirdPerson) {
    const pivot = new THREE.Vector3(self.x, self.y + eyeHeight - 0.15, self.z);
    const viewDir = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch)
    );
    camera.position.copy(pivot).addScaledVector(viewDir, -THIRD_PERSON_DISTANCE);
    camera.position.y += 0.3;
  } else {
    camera.position.set(self.x, self.y + eyeHeight, self.z);
  }
  window.__dbg = { x: self.x, z: self.z, yaw, inArena, ammo, reserveAmmo, alive, started, shopOpen, cursorReleased, keysHeld: [...keys], crates: [...ammoCrates.entries()].map(([id, c]) => ({ id, active: c.active, x: c.group.position.x, z: c.group.position.z })) };

  // Gun sway: idle bob while walking, kick-and-recover on recoil.
  const moving = (forward !== 0 || right !== 0) && moveState.grounded && !moveState.sliding;

  // Third-person self model: same walk-cycle rig and math as remote players (see the render
  // loop's per-remote-player block), driven directly by local input instead of server deltas.
  // On death the body stays visible lying flat on the ground for the respawn delay, rather
  // than just vanishing — shown whenever dead regardless of view mode, since third-person is
  // the only way to actually see it (first-person view is covered by the death overlay).
  selfMesh.visible = (thirdPerson || !alive) && started;
  selfMesh.position.set(self.x, self.y, self.z);
  selfMesh.rotation.y = yaw;
  selfMesh.rotation.x = alive ? 0 : -Math.PI / 2;
  const selfBodyMat = selfMesh.userData.body.material;
  selfBodyMat.color.setHex(inArena ? 0xd94f4f : 0x4f8fd9);
  updateCharacterPose(selfMesh, selfPoseState, dt, moveState.crouching, moveState.sliding, moving);

  bobPhase += (moving ? dt * 9 : dt * 4);
  const bobAmountX = moving ? Math.sin(bobPhase) * 0.012 : 0;
  const bobAmountY = moving ? Math.abs(Math.cos(bobPhase)) * 0.01 : 0;

  recoil = Math.max(0, recoil - dt * 9);
  const recoilKick = recoil * 0.06;

  const usingKnifeView = activeSlot === 'secondary';
  gunGroup.visible = !thirdPerson && !usingKnifeView;
  knifeGroup.visible = !thirdPerson && usingKnifeView;
  selfMesh.userData.gunPropGroup.visible = !usingKnifeView;
  selfMesh.userData.knifePropGroup.visible = usingKnifeView;

  const activeGroup = usingKnifeView ? knifeGroup : gunGroup;
  const activeRest = usingKnifeView ? knifeRestPos : gunRestPos;
  activeGroup.position.set(
    activeRest.x + bobAmountX,
    activeRest.y + bobAmountY,
    activeRest.z + recoilKick
  );
  activeGroup.rotation.x = (usingKnifeView ? -0.1 : 0) - recoil * 0.12;

  // Send input to server at a fixed rate (~20/s) regardless of frame rate.
  inputSendAccum += dt;
  if (inputSendAccum >= 1 / 20) {
    inputSendAccum = 0;
    net.send({ type: MSG.INPUT, forward, right, yaw, pitch, crouch });
  }
}

// ---------- Render loop ----------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  updateMovement(dt);

  // Interpolate remote players toward latest known server position.
  for (const rp of remotePlayers.values()) {
    rp.x += (rp.targetX - rp.x) * Math.min(1, dt * 12);
    rp.y += (rp.targetY - rp.y) * Math.min(1, dt * 12);
    rp.z += (rp.targetZ - rp.z) * Math.min(1, dt * 12);
    rp.mesh.position.set(rp.x, rp.y, rp.z);
    rp.mesh.rotation.y = rp.yaw;
    rp.mesh.rotation.x = rp.alive ? 0 : -Math.PI / 2;
    rp.mesh.visible = true; // dead bodies stay visible lying down for the respawn delay
    const bodyMat = rp.mesh.userData.body.material;
    bodyMat.color.setHex(rp.inArena ? 0xd94f4f : 0x4f8fd9);
    const rpUsingKnife = rp.activeSlot === 'secondary';
    rp.mesh.userData.gunPropGroup.visible = !rpUsingKnife;
    rp.mesh.userData.knifePropGroup.visible = rpUsingKnife;
    updateCharacterPose(rp.mesh, rp, dt, rp.crouching, rp.sliding, rp.isMoving);
  }

  // Door swings open toward doorOpenTarget (set to 1 briefly whenever anyone deploys, see the
  // ENTER handler) and eases back shut on its own.
  doorOpenTarget = Math.max(0, doorOpenTarget - dt * 0.6);
  doorOpenAmount += (Math.min(1, doorOpenTarget) - doorOpenAmount) * Math.min(1, dt * 6);
  doorPanels[0].rotation.y = doorOpenAmount * 1.4;
  doorPanels[1].rotation.y = -doorOpenAmount * 1.4;
  doorLight.intensity = 1.5 + doorOpenAmount * 2;

  padPulse += dt * 3;
  const padScale = 1 + Math.sin(padPulse) * 0.06;
  for (const pad of jumpPads) {
    pad.disc.scale.set(padScale, 1, padScale);
  }

  for (const crate of ammoCrates.values()) {
    if (!crate.active) continue;
    crate.icon.position.y = 1.05 + Math.sin(padPulse * 0.8) * 0.05;
    crate.light.intensity = 0.8 + Math.sin(padPulse) * 0.3;
  }

  if (flashTimer > 0) {
    flashTimer -= dt;
    if (flashTimer <= 0) flash.intensity = 0;
  }

  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    t.line.material.opacity = Math.max(0, t.life / 0.08);
    if (t.life <= 0) {
      scene.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
      tracers.splice(i, 1);
    }
  }

  for (let i = bloodParticles.length - 1; i >= 0; i--) {
    const b = bloodParticles[i];
    b.life -= dt;
    if (b.life <= 0) {
      scene.remove(b.mesh);
      b.mesh.material.dispose();
      bloodParticles.splice(i, 1);
      continue;
    }
    const v = b.mesh.userData.velocity;
    v.y -= 14 * dt; // gravity
    b.mesh.position.addScaledVector(v, dt);
    if (b.mesh.position.y < 0.02) {
      b.mesh.position.y = 0.02;
      v.set(0, 0, 0);
    }
    const t = b.life / b.maxLife;
    b.mesh.material.opacity = t;
    b.mesh.scale.setScalar(0.5 + t * 0.5);
  }

  renderer.render(scene, camera);
}

animate();
