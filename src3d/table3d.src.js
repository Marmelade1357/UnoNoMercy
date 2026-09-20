// 3D-Tisch für "Uno No Mercy" (Three.js). Reine Darstellung: Regeln und Zustand
// kommen unverändert vom Server; client.js übergibt bei jeder Änderung eine
// "view" (update) und reicht neue Ereignisse an events() weiter.
// Build: npm run build3d  ->  public/table3d.js (gebündelt, minifiziert)

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const COLOR_HEX = { red: '#e63946', yellow: '#f6b91a', green: '#2a9d55', blue: '#2f6fdd' };
const FONT = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const CW = 0.9, CH = 1.35, CT = 0.02;           // Kartenmaße (Breite, Höhe, Dicke)
const TABLE_RX = 7.6, TABLE_RZ = 5.6;           // Tischoval
const SEAT_RX = 6.3, SEAT_RZ = 4.4;             // Sitzoval
const PILE_X = 1.25;

let O = null;
let renderer, scene, camera, controls, canvas, container, ro;
let visible = false;
let clock = new THREE.Clock();
let raycaster = new THREE.Raycaster();
let pointer = new THREE.Vector2();
let tweens = [];
let seats = {};                 // id -> { group, fan, label, ring, key, x, z, rot }
let lastView = null;
let discardGroup, discardTop, ringMesh, drawStack, drawTop, dirGroup, arrows = [], pendingSprite, deco;
let discardKey = '', wantTop = null, holdUntil = 0;
let dirCur = 0, camTween = null, firstUpdate = true, topDown = false;
let pulse = 0, fitDist = 16, hoverDraw = false, particles = [], popSprites = [];
let lights = null;
let maxAniso = 4;

// ---------------------------------------------------------------------------
// Texturen
// ---------------------------------------------------------------------------
const texCache = new Map();
function canvasTex(cv) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function faceOf(card) {
  switch (card.kind) {
    case 'num': return { sym: String(card.value), corner: String(card.value), size: 1 };
    case 'skip': return { sym: '⊘', corner: '⊘', size: 1 };
    case 'reverse': return { sym: '⇄', corner: '⇄', size: 0.9 };
    case 'draw2': return { sym: '+2', corner: '+2', size: 0.9 };
    case 'draw4': return { sym: '+4', corner: '+4', size: 0.9 };
    case 'discard': return { sym: '✖', corner: '✖', size: 0.9, lab: 'ALLE ABLEGEN' };
    case 'skipall': return { sym: '⊘⊘', corner: '⊘⊘', size: 0.62, lab: 'ALLE AUSSETZEN' };
    case 'wildrev4': return { sym: '⇄+4', corner: '+4', size: 0.62 };
    case 'wild6': return { sym: '+6', corner: '+6', size: 0.9 };
    case 'wild10': return { sym: '+10', corner: '+10', size: 0.78 };
    case 'roulette': return { sym: '?', corner: '?', size: 1, lab: 'ROULETTE' };
    default: return { sym: '?', corner: '?', size: 1 };
  }
}
function faceTexture(card) {
  const key = `${card.kind}|${card.color || 'w'}|${card.value}`;
  let t = texCache.get(key);
  if (t) return t;
  const W = 320, H = 480;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const wild = !card.color;
  const bg = wild ? '#17171b' : COLOR_HEX[card.color];
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
  c.fillStyle = bg; rr(c, 14, 14, W - 28, H - 28, 26); c.fill();
  const f = faceOf(card);
  // Oval
  c.save();
  c.translate(W / 2, H / 2); c.rotate(0.49);
  c.beginPath(); c.ellipse(0, 0, 112, 172, 0, 0, Math.PI * 2);
  if (wild) {
    c.save(); c.clip();
    const cols = [COLOR_HEX.red, COLOR_HEX.blue, COLOR_HEX.green, COLOR_HEX.yellow];
    cols.forEach((col, i) => { c.fillStyle = col; c.fillRect(i % 2 ? 0 : -130, i < 2 ? -180 : 0, 130, 180); });
    c.restore();
    c.lineWidth = 8; c.strokeStyle = '#fff'; c.beginPath(); c.ellipse(0, 0, 112, 172, 0, 0, Math.PI * 2); c.stroke();
  } else { c.fillStyle = '#fff'; c.fill(); }
  c.restore();
  // Symbol
  c.save(); c.translate(W / 2, H / 2 + (f.lab ? -10 : 0));
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `900 ${Math.round(190 * f.size)}px ${FONT}`;
  if (wild) { c.lineWidth = 14; c.strokeStyle = '#000'; c.strokeText(f.sym, 0, 4); c.fillStyle = '#fff'; } else { c.fillStyle = bg; }
  c.fillText(f.sym, 0, 4);
  c.restore();
  // Ecken
  c.fillStyle = '#fff'; c.textAlign = 'left'; c.textBaseline = 'top';
  c.font = `900 46px ${FONT}`;
  c.save(); c.shadowColor = 'rgba(0,0,0,0.4)'; c.shadowBlur = 4; c.fillText(f.corner, 36, 30); c.restore();
  c.save(); c.translate(W - 36, H - 30); c.rotate(Math.PI); c.font = `900 46px ${FONT}`; c.shadowColor = 'rgba(0,0,0,0.4)'; c.shadowBlur = 4; c.fillText(f.corner, 0, 0); c.restore();
  if (f.lab) { c.font = `800 22px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.fillStyle = wild ? '#fff' : '#fff'; c.fillText(f.lab, W / 2, H - 46); }
  t = canvasTex(cv);
  texCache.set(key, t);
  return t;
}
let backTex = null;
function backTexture() {
  if (backTex) return backTex;
  const W = 320, H = 480;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
  const g = c.createRadialGradient(W / 2, H * 0.4, 20, W / 2, H / 2, H * 0.7);
  g.addColorStop(0, '#4a1119'); g.addColorStop(1, '#14060a');
  c.fillStyle = g; rr(c, 14, 14, W - 28, H - 28, 26); c.fill();
  c.save(); c.translate(W / 2, H / 2); c.rotate(-0.42);
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `900 78px ${FONT}`; c.lineWidth = 8; c.strokeStyle = '#000';
  c.strokeText('NO', 0, -44); c.strokeText('MERCY', 0, 44);
  c.fillStyle = '#e63946'; c.fillText('NO', 0, -44); c.fillText('MERCY', 0, 44);
  c.restore();
  backTex = canvasTex(cv);
  return backTex;
}
const sideMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.8 });
const backMat = () => new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.55 });
const cardGeo = new THREE.BoxGeometry(CW, CT, CH);
function makeCard(card, scale) {
  const top = card ? new THREE.MeshStandardMaterial({ map: faceTexture(card), roughness: 0.5 }) : backMat();
  const m = new THREE.Mesh(cardGeo, [sideMat, sideMat, top, backMat(), sideMat, sideMat]);
  m.castShadow = true; m.receiveShadow = true;
  if (scale) m.scale.setScalar(scale);
  return m;
}

function woodTexture() {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
  const c = cv.getContext('2d');
  c.fillStyle = '#5a3a22'; c.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 90; i++) {
    const y = Math.random() * 512;
    c.strokeStyle = `rgba(${30 + Math.random() * 40},${15 + Math.random() * 20},${5 + Math.random() * 10},${0.15 + Math.random() * 0.25})`;
    c.lineWidth = 1 + Math.random() * 3;
    c.beginPath(); c.moveTo(0, y); c.bezierCurveTo(170, y + (Math.random() - 0.5) * 24, 340, y + (Math.random() - 0.5) * 24, 512, y); c.stroke();
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); t.anisotropy = maxAniso;
  return t;
}
function feltTexture() {
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 768;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(512, 384, 40, 512, 384, 560);
  g.addColorStop(0, '#6a2636'); g.addColorStop(0.7, '#43172a'); g.addColorStop(1, '#2a0d18');
  c.fillStyle = g; c.fillRect(0, 0, 1024, 768);
  for (let i = 0; i < 9000; i++) { c.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`; c.fillRect(Math.random() * 1024, Math.random() * 768, 2, 2); }
  c.strokeStyle = 'rgba(244,201,93,0.35)'; c.lineWidth = 4;
  c.beginPath(); c.ellipse(512, 384, 470, 340, 0, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.ellipse(512, 384, 190, 190, 0, 0, Math.PI * 2); c.stroke();
  c.fillStyle = 'rgba(244,201,93,0.16)'; c.font = `900 84px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('NO MERCY', 512, 384 + 300);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
  return t;
}

function textSprite(lines, opts) {
  const o = opts || {};
  const cv = document.createElement('canvas'); cv.width = 384; cv.height = 128;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTex(cv), transparent: true, depthTest: false, depthWrite: false }));
  sp.renderOrder = 10;
  sp.userData.cv = cv;
  sp.scale.set(o.w || 3.0, (o.w || 3.0) / 3, 1);
  return sp;
}
function paintLabel(sp, s) {
  const cv = sp.userData.cv; const c = cv.getContext('2d');
  c.clearRect(0, 0, 384, 128);
  const W = 384, H = 128;
  c.fillStyle = s.turn ? 'rgba(90,60,10,0.92)' : 'rgba(30,14,20,0.88)';
  rr(c, 8, 22, W - 16, 84, 40); c.fill();
  c.lineWidth = s.turn ? 7 : 3; c.strokeStyle = s.turn ? '#f4c95d' : (s.me ? '#ff5a5f' : '#5a2a33'); c.stroke();
  c.textBaseline = 'middle'; c.textAlign = 'left';
  c.fillStyle = s.out ? '#999' : '#fff'; c.font = `700 38px ${FONT}`;
  let name = s.name; while (c.measureText(name).width > 190 && name.length > 3) name = name.slice(0, -2);
  if (name !== s.name) name += '…';
  c.fillText((s.bot ? '🤖 ' : '') + name, 34, 64);
  c.textAlign = 'right'; c.fillStyle = s.count >= 20 ? '#ff5a5f' : '#ffdd88'; c.font = `900 54px ${FONT}`;
  c.fillText(String(s.count), W - 34, 66);
  if (s.uno) { c.fillStyle = '#e63946'; rr(c, W - 172, 2, 96, 34, 14); c.fill(); c.fillStyle = '#fff'; c.font = `900 26px ${FONT}`; c.textAlign = 'center'; c.fillText('UNO!', W - 124, 20); }
  if (s.out) { c.fillStyle = '#666'; rr(c, 20, 2, 100, 30, 12); c.fill(); c.fillStyle = '#ddd'; c.font = `800 22px ${FONT}`; c.textAlign = 'center'; c.fillText('raus', 70, 17); }
  if (s.win) { c.font = `40px ${FONT}`; c.textAlign = 'center'; c.fillText('🏆', W / 2, 16); }
  if (s.score !== null) { c.fillStyle = '#c39aa1'; c.font = `600 22px ${FONT}`; c.textAlign = 'left'; c.fillText(`${s.score} Pkt.`, 34, 102); }
  sp.material.map.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Aufbau der Szene
// ---------------------------------------------------------------------------
function buildTable() {
  const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.6 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: 0x1a0d10, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1.2; floor.receiveShadow = true; scene.add(floor);
  // Tischplatte (Oval durch Skalierung)
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.5, 64), wood);
  slab.scale.set(TABLE_RX + 0.7, 1, TABLE_RZ + 0.7); slab.position.y = -0.27; slab.castShadow = true; slab.receiveShadow = true; scene.add(slab);
  const felt = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 1 }));
  felt.rotation.x = -Math.PI / 2; felt.scale.set(TABLE_RX, TABLE_RZ, 1); felt.position.y = 0.001; felt.receiveShadow = true; scene.add(felt);
  const legMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.6 });
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.3, 1.1, 24), legMat); leg.position.y = -0.85; scene.add(leg);
}

function buildCenter() {
  // Ziehstapel (links), Ablagestapel (rechts)
  drawStack = new THREE.Group(); drawStack.position.set(-PILE_X, 0, 0); scene.add(drawStack);
  const body = new THREE.Mesh(new THREE.BoxGeometry(CW, 1, CH), sideMat); body.castShadow = true; body.receiveShadow = true;
  body.userData.draw = true; drawStack.userData.body = body; drawStack.add(body);
  drawTop = new THREE.Mesh(new THREE.PlaneGeometry(CW, CH), new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.55, emissive: 0xffdd88, emissiveIntensity: 0 }));
  drawTop.rotation.x = -Math.PI / 2; drawTop.userData.draw = true; drawStack.add(drawTop);

  discardGroup = new THREE.Group(); discardGroup.position.set(PILE_X, 0, 0); scene.add(discardGroup);
  ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.98, 1.16, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  ringMesh.rotation.x = -Math.PI / 2; ringMesh.position.set(PILE_X, 0.01, 0); ringMesh.scale.set(0.82, 1.2, 1); scene.add(ringMesh);

  // Richtungspfeile
  dirGroup = new THREE.Group(); dirGroup.position.y = 0.03; scene.add(dirGroup);
  const R = 3.3;
  for (let i = 0; i < 4; i++) {
    const phi = (i / 4) * Math.PI * 2;
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.7, 3), new THREE.MeshBasicMaterial({ color: 0xf4c95d, transparent: true, opacity: 0.55 }));
    arrow.position.set(Math.cos(phi) * R * 1.35, 0.04, Math.sin(phi) * R * 0.95);
    arrow.userData.phi = phi;
    dirGroup.add(arrow); arrows.push(arrow);
  }
  const ringLine = new THREE.Mesh(new THREE.RingGeometry(0.985, 1.0, 96), new THREE.MeshBasicMaterial({ color: 0xf4c95d, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
  ringLine.rotation.x = -Math.PI / 2; ringLine.scale.set(R * 1.35, R * 0.95, 1); dirGroup.add(ringLine);
  orientArrows(1);

  pendingSprite = textSprite([], { w: 2.4 });
  pendingSprite.position.set(0, 1.6, -1.8); pendingSprite.visible = false; scene.add(pendingSprite);
}

function orientArrows(dir) {
  arrows.forEach((a) => {
    const phi = a.userData.phi; const R = 1;
    // Tangente an der Ellipse (im Uhrzeigersinn von oben: dir = 1)
    const tx = -Math.sin(phi) * 1.35 * dir; const tz = Math.cos(phi) * 0.95 * dir;
    const v = new THREE.Vector3(tx, 0, tz).normalize();
    a.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
  });
}

// ---------------------------------------------------------------------------
// Sitze
// ---------------------------------------------------------------------------
function seatPos(i, n) {
  const a = (Math.PI / 2) + (i * Math.PI * 2) / n;
  const x = Math.cos(a) * SEAT_RX, z = Math.sin(a) * SEAT_RZ;
  return { x, z, rot: Math.atan2(x, z) };
}

function layoutSeats(view) {
  const players = view.players; const n = players.length;
  const meIdx = Math.max(0, players.findIndex((p) => p.id === view.meId));
  Object.keys(seats).forEach((id) => { if (!players.find((p) => p.id === id)) { scene.remove(seats[id].group); delete seats[id]; } });
  for (let i = 0; i < n; i++) {
    const p = players[(meIdx + i) % n];
    const pos = seatPos(i, n);
    let s = seats[p.id];
    if (!s) {
      const group = new THREE.Group();
      const fan = new THREE.Group(); group.add(fan);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.5, 40), new THREE.MeshBasicMaterial({ color: 0xf4c95d, transparent: true, opacity: 0, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; ring.scale.set(1.3, 0.8, 1); group.add(ring);
      const label = textSprite([], { w: 3.1 });
      group.add(label);
      scene.add(group);
      s = seats[p.id] = { group, fan, ring, label, key: '', fanCount: -1 };
    }
    s.x = pos.x; s.z = pos.z; s.rot = pos.rot;
    s.group.position.set(pos.x, 0, pos.z);
    s.group.rotation.y = pos.rot;
    // Label liegt außerhalb (lokal +z zeigt vom Zentrum weg)
    s.label.position.set(0, 0.7, 1.55);
  }
}

function updateFan(s, count, out) {
  if (s.fanCount === count) return;
  s.fanCount = count;
  while (s.fan.children.length) s.fan.remove(s.fan.children[0]);
  const shown = Math.min(count, 14);
  const step = shown > 1 ? Math.min(0.42, 4.6 / (shown - 1)) : 0;
  const ang = shown > 1 ? Math.min(0.16, 1.1 / shown) : 0;
  for (let i = 0; i < shown; i++) {
    const t = i - (shown - 1) / 2;
    const m = makeCard(null, 0.78);
    m.position.set(t * step, 0.03 + i * 0.012, Math.abs(t) * 0.05);
    m.rotation.y = -t * ang;
    m.rotation.z = 0;
    s.fan.add(m);
  }
  s.fan.visible = !out;
}

function updateLabel(s, p, view) {
  const key = [p.name, p.handCount, p.eliminated, view.currentTurnId === p.id, view.unoId === p.id || (p.handCount === 1 && !p.eliminated), view.winnerId === p.id, p.isBot, view.target ? p.score : null].join('|');
  if (s.key === key) return;
  s.key = key;
  paintLabel(s.label, {
    name: p.name, count: p.handCount, out: p.eliminated, turn: view.currentTurnId === p.id, me: p.id === view.meId,
    uno: p.handCount === 1 && !p.eliminated, win: view.winnerId === p.id, bot: p.isBot, score: view.target ? p.score : null,
  });
  s.label.material.opacity = p.eliminated ? 0.55 : 1;
}

// ---------------------------------------------------------------------------
// Tweens & Flüge
// ---------------------------------------------------------------------------
function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function addTween(dur, delay, fn, done) { tweens.push({ t0: performance.now() + delay, dur, fn, done }); }

function fly(from, to, card, opts) {
  const o = opts || {};
  const m = makeCard(card, o.scale || 1);
  m.position.copy(from); m.visible = false;
  scene.add(m);
  const rotFrom = o.rotFrom || 0, rotTo = o.rotTo || 0;
  const arc = o.arc === undefined ? 1.6 : o.arc;
  addTween(o.dur || 520, o.delay || 0, (p, started) => {
    if (started) m.visible = true;
    const e = ease(p);
    m.position.set(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e + Math.sin(p * Math.PI) * arc, from.z + (to.z - from.z) * e);
    m.rotation.y = rotFrom + (rotTo - rotFrom) * e;
    m.rotation.x = Math.sin(p * Math.PI) * 0.25;
  }, () => { scene.remove(m); if (o.onDone) o.onDone(); });
}

function seatVec(id, dy) {
  const s = seats[id];
  return s ? new THREE.Vector3(s.x * 0.86, dy || 0.2, s.z * 0.86) : new THREE.Vector3(0, dy || 0.2, 0);
}
const DRAW_V = () => new THREE.Vector3(-PILE_X, 0.5, 0);
const DISCARD_V = () => new THREE.Vector3(PILE_X, 0.15, 0);

function pop(text, pos, color) {
  const cv = document.createElement('canvas'); cv.width = 384; cv.height = 128;
  const c = cv.getContext('2d'); c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `900 84px ${FONT}`;
  c.lineWidth = 12; c.strokeStyle = 'rgba(0,0,0,0.85)'; c.strokeText(text, 192, 66); c.fillStyle = color || '#ffdd88'; c.fillText(text, 192, 66);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTex(cv), transparent: true, depthTest: false, depthWrite: false }));
  sp.renderOrder = 20; sp.scale.set(2.6, 0.87, 1); sp.position.copy(pos); scene.add(sp);
  addTween(1500, 0, (p) => { sp.position.y = pos.y + p * 1.4; sp.material.opacity = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3; }, () => { scene.remove(sp); sp.material.map.dispose(); sp.material.dispose(); });
}

function confetti(pos) {
  const cols = [0xe63946, 0xf6b91a, 0x2a9d55, 0x2f6fdd, 0xffffff];
  for (let i = 0; i < 70; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.1), new THREE.MeshBasicMaterial({ color: cols[i % cols.length], side: THREE.DoubleSide }));
    m.position.copy(pos); m.position.y = 0.6;
    scene.add(m);
    particles.push({ m, vx: (Math.random() - 0.5) * 5, vy: 4 + Math.random() * 5, vz: (Math.random() - 0.5) * 5, life: 2.4 + Math.random() * 0.8, spin: Math.random() * 8 });
  }
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------
export function init(opts) {
  O = opts;
  container = opts.container;
  canvas = document.createElement('canvas');
  canvas.className = 'board3d-canvas';
  container.insertBefore(canvas, container.firstChild);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  const lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || Math.min(window.innerWidth, window.innerHeight) < 500;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowEnd ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  scene = new THREE.Scene();
  try {
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.3;
    pm.dispose();
  } catch (e) { /* ohne Umgebungslicht */ }
  camera = new THREE.PerspectiveCamera(38, 1, 0.5, 200);
  const hemi = new THREE.HemisphereLight(0xfff0e0, 0x5a2a30, 0.6); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe0c0, 2.2);
  sun.position.set(-6, 14, 8); sun.castShadow = true;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  const sc = sun.shadow.camera; sc.left = -10; sc.right = 10; sc.top = 8; sc.bottom = -8; sc.near = 1; sc.far = 40;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(sun);
  const lamp = new THREE.PointLight(0xffb070, 18, 26, 1.6); lamp.position.set(0, 6.5, 0); scene.add(lamp);
  lights = { hemi, sun, lamp };

  buildTable();
  buildCenter();

  controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.05; controls.maxPolarAngle = 1.32;
  controls.minDistance = 8; controls.maxDistance = 30;
  controls.rotateSpeed = 0.7;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  let down = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 6) return;
    if (pickDraw(e)) O.onDraw && O.onDraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const h = pickDraw(e);
    hoverDraw = h; canvas.style.cursor = h && lastView && lastView.canDraw ? 'pointer' : 'grab';
  });
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());

  ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  resetView(true);
  renderer.setAnimationLoop(tick);
}

function pickDraw(e) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects([drawStack.userData.body, drawTop], false).length > 0;
}

function resize() {
  if (!container || !renderer) return;
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const a = w / h;
  const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
  fitDist = Math.max(14.5, (a < 1 ? 12 : 10.4) / (tanHalf * a), (8.8 / tanHalf) * 0.72);
  if (!camTween && !controls.userDragged) { const p = homePos(); camera.position.copy(p); controls.target.set(0, 0, 0.4); }
}

function homePos() {
  const elev = topDown ? 1.5 : 1.02;
  return new THREE.Vector3(0, Math.sin(elev) * fitDist, Math.cos(elev) * fitDist + (topDown ? 0.001 : 0));
}

export function resetView(instant) {
  const p = homePos();
  if (instant || !camera) { camera.position.copy(p); controls.target.set(0, 0, 0.4); controls.update(); return; }
  camTween = { from: camera.position.clone(), to: p, t0: performance.now(), dur: 700 };
}
export function isTopDown() { return topDown; }
export function setTopDown(on) { topDown = !!on; resetView(false); }

export function setVisible(v) {
  const was = visible;
  visible = v;
  if (!canvas) return;
  if (v && !was) { canvas.style.display = 'block'; canvas.style.opacity = '0'; requestAnimationFrame(() => requestAnimationFrame(() => { canvas.style.opacity = '1'; })); clock.getDelta(); resize(); }
  else if (!v && was) { canvas.style.opacity = '0'; setTimeout(() => { if (!visible) canvas.style.display = 'none'; }, 350); }
}

function setTopCard(card, color) {
  const key = card ? card.id : '';
  if (key === discardKey) { setRing(color); return; }
  discardKey = key;
  if (discardTop) { discardGroup.remove(discardTop); }
  if (card) {
    discardTop = makeCard(card);
    discardTop.rotation.y = ((card.id.charCodeAt(1) || 0) % 7 - 3) * 0.04;
    discardTop.position.y = 0.06 + Math.min(0.5, (lastView ? lastView.discardCount || 0 : 0) * 0.004);
    discardGroup.add(discardTop);
  }
  setRing(color);
}
function setRing(color) { if (ringMesh) ringMesh.material.color.set(COLOR_HEX[color] || '#ffffff'); }

export function update(view) {
  if (!renderer) return;
  const prev = lastView;
  lastView = view;
  layoutSeats(view);
  view.players.forEach((p) => {
    const s = seats[p.id]; if (!s) return;
    updateFan(s, p.handCount, p.eliminated);
    updateLabel(s, p, view);
    s.ring.userData.turn = view.currentTurnId === p.id;
  });
  // Ziehstapel
  const h = Math.max(0.05, Math.min(1.2, view.drawCount * 0.0075));
  drawStack.userData.body.scale.y = h; drawStack.userData.body.position.y = h / 2;
  drawTop.position.y = h + 0.005;
  // Ablage (nach Kartenflug)
  wantTop = { card: view.top, color: view.color };
  if (firstUpdate || performance.now() >= holdUntil) { setTopCard(view.top, view.color); wantTop = null; }
  else setRing(view.color);
  if (view.dir !== dirCur) { dirCur = view.dir; orientArrows(view.dir); }
  if (view.pending > 0) {
    if (!pendingSprite.userData.n || pendingSprite.userData.n !== view.pending) {
      pendingSprite.userData.n = view.pending;
      const cv = pendingSprite.userData.cv; const c = cv.getContext('2d'); c.clearRect(0, 0, 384, 128);
      c.fillStyle = '#e5383b'; rr(c, 60, 14, 264, 100, 50); c.fill(); c.lineWidth = 6; c.strokeStyle = '#fff'; c.stroke();
      c.fillStyle = '#fff'; c.font = `900 72px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(`+${view.pending}`, 192, 68);
      pendingSprite.material.map.needsUpdate = true;
      if (prev && prev.pending !== view.pending) pop('+' + view.pending, new THREE.Vector3(0, 1.5, -1.4), '#ff8a8e');
    }
    pendingSprite.visible = true;
  } else { pendingSprite.visible = false; pendingSprite.userData.n = 0; }
  if (view.winnerId && (!prev || prev.winnerId !== view.winnerId) && seats[view.winnerId]) confetti(new THREE.Vector3(seats[view.winnerId].x, 0, seats[view.winnerId].z));
  firstUpdate = false;
}

export function events(list) {
  if (!lastView || !renderer) return;
  const players = lastView.players; const n = players.length;
  list.forEach((ev, idx) => {
    const base = idx * 120;
    switch (ev.t) {
      case 'play': {
        const s = seats[ev.id];
        if (!s) break;
        holdUntil = performance.now() + base + 560;
        fly(seatVec(ev.id, 0.35), DISCARD_V(), ev.card, { dur: 520, delay: base, rotFrom: s.rot, rotTo: 0, onDone: () => { if (wantTop) { setTopCard(wantTop.card, wantTop.color); wantTop = null; } else if (lastView) setTopCard(lastView.top, lastView.color); } });
        break;
      }
      case 'draw': case 'penalty': case 'roulette': {
        const cnt = Math.min(ev.n || 0, 10);
        for (let i = 0; i < cnt; i++) fly(DRAW_V(), seatVec(ev.id, 0.3), null, { dur: 480, delay: base + i * 90, rotFrom: 0, rotTo: seats[ev.id] ? seats[ev.id].rot : 0, scale: 0.9 });
        if (ev.n) pop('+' + ev.n, seatVec(ev.id, 1.2).multiplyScalar(0.92), '#ff8a8e');
        break;
      }
      case 'swap': {
        for (let i = 0; i < 3; i++) {
          fly(seatVec(ev.id, 0.3), seatVec(ev.targetId, 0.3), null, { dur: 650, delay: base + i * 110, scale: 0.9 });
          fly(seatVec(ev.targetId, 0.3), seatVec(ev.id, 0.3), null, { dur: 650, delay: base + i * 110, scale: 0.9 });
        }
        pop('⇄', new THREE.Vector3(0, 1.2, 0), '#ffdd88');
        break;
      }
      case 'rotate': {
        const order = players.filter((p) => !p.eliminated);
        const m = order.length;
        order.forEach((p, i) => {
          const nx = order[(i + (ev.dir === 1 ? 1 : m - 1)) % m];
          for (let k = 0; k < 2; k++) fly(seatVec(p.id, 0.3), seatVec(nx.id, 0.3), null, { dur: 650, delay: base + k * 120, scale: 0.9 });
        });
        pop('0', new THREE.Vector3(0, 1.2, 0), '#ffdd88');
        break;
      }
      case 'mercy': {
        const cnt = Math.min(ev.n || 0, 12);
        for (let i = 0; i < cnt; i++) fly(seatVec(ev.id, 0.3), DRAW_V(), null, { dur: 600, delay: base + i * 60, scale: 0.9 });
        pop('MERCY!', seatVec(ev.id, 1.4), '#ff5a5f');
        break;
      }
      case 'uno': pop('UNO!', seatVec(ev.id, 1.4), '#ffdd57'); break;
      case 'unoCaught': pop('erwischt!', seatVec(ev.id, 1.4), '#ff5a5f'); break;
      case 'skip': pop('⊘', seatVec(ev.id, 1.2), '#ffdd88'); break;
      case 'skipall': pop('Alle aussetzen', new THREE.Vector3(0, 1.4, 1.0), '#ffdd88'); break;
      default: break;
    }
  });
}

function tick() {
  if (!visible) return;
  const dt = Math.min(0.05, clock.getDelta());
  const now = performance.now();
  pulse += dt;
  // Tweens
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (now < tw.t0) continue;
    const p = Math.min(1, (now - tw.t0) / tw.dur);
    tw.fn(p, !tw.started); tw.started = true;
    if (p >= 1) { tweens.splice(i, 1); tw.done && tw.done(); }
  }
  if (wantTop && now >= holdUntil) { setTopCard(wantTop.card, wantTop.color); wantTop = null; }
  // Kamera-Tween
  if (camTween) {
    const p = Math.min(1, (now - camTween.t0) / camTween.dur); const e = ease(p);
    camera.position.lerpVectors(camTween.from, camTween.to, e);
    if (p >= 1) camTween = null;
  }
  controls.update();
  // Richtungspfeile drehen
  if (dirGroup) dirGroup.rotation.y -= (lastView ? lastView.dir : 1) * dt * 0.45;
  // Sitze: Ring pulsiert bei aktivem Zug
  Object.values(seats).forEach((s) => {
    const on = s.ring.userData.turn;
    s.ring.material.opacity = on ? 0.55 + Math.sin(pulse * 5) * 0.3 : 0;
  });
  // Ziehstapel leuchtet, wenn man ziehen darf
  if (drawTop) drawTop.material.emissiveIntensity = lastView && lastView.canDraw ? 0.25 + Math.sin(pulse * 6) * 0.2 : (hoverDraw ? 0.08 : 0);
  // Konfetti
  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    pt.life -= dt; pt.vy -= 9 * dt;
    pt.m.position.x += pt.vx * dt; pt.m.position.y = Math.max(0.02, pt.m.position.y + pt.vy * dt); pt.m.position.z += pt.vz * dt;
    pt.m.rotation.x += pt.spin * dt; pt.m.rotation.z += pt.spin * dt;
    if (pt.life <= 0) { scene.remove(pt.m); pt.m.geometry.dispose(); pt.m.material.dispose(); particles.splice(i, 1); }
  }
  renderer.render(scene, camera);
}

export function dispose() {
  if (renderer) { renderer.setAnimationLoop(null); renderer.dispose(); }
  if (ro) ro.disconnect();
  if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
}
