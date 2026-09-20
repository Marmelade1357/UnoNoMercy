// Uno No Mercy - Online-Server
// Einfacher, selbst-gehosteter Mehrspieler-Server auf Basis von Express + Socket.IO
// (gleiche Bauweise wie Poker, Wizard, Monopoly ...: Räume mit 4-stelligem Code,
// Host, Bots, Wiederverbindung, alles im Speicher).

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const E = require('./src/engine');
const bots = require('./src/bots');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;
const MAX_ROOMS = 500;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CLEANUP_MS = 3 * 60 * 60 * 1000;

const BOT_NAME_POOL = [
  'Bot Rot', 'Bot Gelb', 'Bot Grün', 'Bot Blau', 'Bot Plus-Zehn',
  'Bot Mercy', 'Bot Roulette', 'Bot Stapel', 'Bot Skip', 'Bot Reverse',
];

// Verzögerungen - per Umgebungsvariable änderbar, damit Tests nicht in Echtzeit laufen müssen.
const BOT_DELAY_MIN = Number(process.env.BOT_DELAY_MIN_MS) || 1000;
const BOT_DELAY_MAX = Number(process.env.BOT_DELAY_MAX_MS) || 2200;
const ROUND_RESULT_DELAY_MS = Number(process.env.ROUND_RESULT_DELAY_MS) || 12000;
const UNO_WINDOW_MS = Number(process.env.UNO_WINDOW_MS) || 4500;
const SKIP_MIN_WAIT_MS = Number(process.env.SKIP_MIN_WAIT_MS) || 20000;
const HOST_HANDOVER_MS = Number(process.env.HOST_HANDOVER_MS) || 20000;

const DEFAULT_SETTINGS = { sevenZero: true, target: 0, unoRule: true };
const TARGETS = [0, 250, 500, 1000];

function randomDelay(min = BOT_DELAY_MIN, max = BOT_DELAY_MAX) { return min + Math.random() * (max - min); }
function makeId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

// ---------------------------------------------------------------------------
// Rate-Limiting
// ---------------------------------------------------------------------------

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

const rateLimitHits = new Map();
function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateLimitHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) { rateLimitHits.set(key, hits); return true; }
  hits.push(now);
  rateLimitHits.set(key, hits);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitHits) {
    const fresh = hits.filter((t) => now - t < 10 * 60 * 1000);
    if (fresh.length) rateLimitHits.set(key, fresh); else rateLimitHits.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Räume
// ---------------------------------------------------------------------------

const rooms = new Map();

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: null,
    players: [], // { id, token, name, socketId, connected, isBot }
    phase: 'lobby', // lobby | playing | roundend | gameover
    settings: Object.assign({}, DEFAULT_SETTINGS),
    game: null,
    scores: {},
    roundNo: 0,
    roundResult: null,
    winnerId: null,
    placements: null,
    events: [],
    eventSeq: 0,
    unoWindow: null, // { id, until }
    logs: [],
    roundTimer: null,
    hostTimer: null,
    cleanupTimer: null,
    botTimer: null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  touchRoom(room);
  return room;
}

function destroyRoom(room) {
  ['roundTimer', 'hostTimer', 'cleanupTimer', 'botTimer'].forEach((k) => { if (room[k]) clearTimeout(room[k]); room[k] = null; });
  rooms.delete(room.code);
}

function touchRoom(room) {
  room.lastActivity = Date.now();
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => destroyRoom(room), ROOM_CLEANUP_MS);
}

function log(room, text) {
  room.logs.push({ text, at: Date.now() });
  if (room.logs.length > 200) room.logs.shift();
}

function findPlayer(room, id) { return room.players.find((p) => p.id === id); }
function nameOf(room, id) { const p = findPlayer(room, id); return p ? p.name : '?'; }

// ---------------------------------------------------------------------------
// Ereignisse -> Log-Text und Animations-Events für die Clients
// ---------------------------------------------------------------------------

const COLOR_NAME = { red: 'Rot', yellow: 'Gelb', green: 'Grün', blue: 'Blau' };

function eventText(room, ev) {
  const n = (id) => nameOf(room, id);
  switch (ev.t) {
    case 'play': return `${n(ev.id)} spielt ${E.cardLabel(ev.card)}${ev.card.color ? '' : ` → ${COLOR_NAME[ev.color]}`}.`;
    case 'discardAll': return `${n(ev.id)} legt ${ev.n} weitere Karten ab.`;
    case 'skip': return `${n(ev.id)} setzt aus.`;
    case 'skipall': return 'Alle anderen setzen aus.';
    case 'reverse': return 'Die Richtung wechselt.';
    case 'pending': return `Strafstapel: ${ev.n} Karten.`;
    case 'penalty': return `${n(ev.id)} zieht ${ev.n} Karten.`;
    case 'draw': return `${n(ev.id)} zieht ${ev.n} Karte${ev.n === 1 ? '' : 'n'}.`;
    case 'pass': return `${n(ev.id)} passt.`;
    case 'roulette': return `${n(ev.id)} zieht ${ev.n} Karten bis ${COLOR_NAME[ev.color]}.`;
    case 'swap': return `${n(ev.id)} tauscht die Hand mit ${n(ev.targetId)}.`;
    case 'rotate': return 'Alle reichen ihre Hand weiter.';
    case 'mercy': return `${n(ev.id)} hat ${ev.n} Karten – Mercy! Ausgeschieden.`;
    case 'uno': return `${n(ev.id)} ruft UNO!`;
    case 'unoCaught': return `${n(ev.id)} hat UNO vergessen – ${n(ev.by)} erwischt ihn/sie: +2.`;
    case 'over': return ev.reason === 'last' ? `${n(ev.id)} ist als Letzte:r übrig.` : `${n(ev.id)} wird alle Karten los!`;
    default: return null;
  }
}

function pushEvents(room, events) {
  events.forEach((ev) => {
    const text = eventText(room, ev);
    if (text) log(room, text);
    room.events.push(Object.assign({ seq: ++room.eventSeq, text }, ev));
  });
  if (room.events.length > 40) room.events.splice(0, room.events.length - 40);
}

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

function publicPlayer(room, p) {
  const g = room.game;
  return {
    id: p.id,
    name: p.name,
    connected: p.connected,
    isHost: p.id === room.hostId,
    isBot: p.isBot === true,
    handCount: g ? (g.hands[p.id] || []).length : 0,
    eliminated: g ? g.out.includes(p.id) : false,
    score: room.scores[p.id] || 0,
  };
}

function waitingFor(room) {
  if (room.phase !== 'playing' || !room.game) return null;
  const p = findPlayer(room, room.game.turn);
  if (!p || p.isBot || !p.connected) return null;
  return { ids: [p.id], key: `${room.roundNo}|${room.game.turnNo}` };
}

function waitInfo(room) {
  const w = waitingFor(room);
  if (!w) { room._wait = null; return null; }
  if (!room._wait || room._wait.key !== w.key) room._wait = { key: w.key, since: Date.now() };
  return { ids: w.ids, elapsedMs: Date.now() - room._wait.since };
}

function publicState(room) {
  const g = room.game;
  const now = Date.now();
  let unoWindow = null;
  if (room.unoWindow && room.unoWindow.until > now) unoWindow = { id: room.unoWindow.id, ms: room.unoWindow.until - now };
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    settings: room.settings,
    players: room.players.map((p) => publicPlayer(room, p)),
    roundNo: room.roundNo,
    turnNo: g ? g.turnNo : 0,
    currentTurnId: g && room.phase === 'playing' ? g.turn : null,
    direction: g ? g.dir : 1,
    topCard: g ? E.top(g) : null,
    color: g ? g.color : null,
    pending: g ? g.pending : 0,
    pendingMin: g ? g.pendingMin : 0,
    drawCount: g ? g.draw.length : 0,
    discardCount: g ? g.discard.length : 0,
    drawnThisTurn: g ? g.drawn : false,
    events: room.events.slice(-12),
    eventSeq: room.eventSeq,
    unoWindow,
    roundResult: room.roundResult,
    winnerId: room.winnerId,
    placements: room.placements,
    logs: room.logs.slice(-40),
    waiting: waitInfo(room),
    serverNow: now,
  };
}

function sendCardsTo(room, player) {
  if (!player.socketId) return;
  const g = room.game;
  if (!g) { io.to(player.socketId).emit('yourCards', { hand: [], playable: [], canDraw: false, canPass: false, canPenalty: false }); return; }
  const isTurn = room.phase === 'playing' && g.turn === player.id;
  io.to(player.socketId).emit('yourCards', {
    hand: g.hands[player.id] || [],
    playable: isTurn ? E.legalPlays(g, player.id) : [],
    canDraw: isTurn && E.canDraw(g, player.id),
    canPass: isTurn && g.drawn && g.pending === 0,
    canPenalty: isTurn && g.pending > 0,
  });
}

function broadcastState(room) {
  io.to(room.code).emit('gameState', publicState(room));
  room.players.forEach((p) => sendCardsTo(room, p));
  scheduleBotTurnIfNeeded(room);
}

// ---------------------------------------------------------------------------
// Rundenverlauf
// ---------------------------------------------------------------------------

function humansConnected(room) { return room.players.some((p) => !p.isBot && p.connected); }

function startRound(room) {
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
  room.roundNo++;
  room.roundResult = null;
  room.unoWindow = null;
  room.events = [];
  const ids = room.players.map((p) => p.id);
  room.game = E.createGame(ids, {
    startIdx: (room.roundNo - 1) % ids.length,
    rules: { sevenZero: room.settings.sevenZero },
  });
  room.phase = 'playing';
  room._wait = null;
  log(room, `Runde ${room.roundNo} beginnt. ${nameOf(room, room.game.turn)} fängt an.`);
}

function startGame(room) {
  room.scores = {};
  room.players.forEach((p) => { room.scores[p.id] = 0; });
  room.roundNo = 0;
  room.winnerId = null;
  room.placements = null;
  room.logs = [];
  startRound(room);
}

function onRoundOver(room) {
  const g = room.game;
  const r = g.result;
  room.scores[r.winnerId] = (room.scores[r.winnerId] || 0) + r.points;
  const hands = {};
  g.order.forEach((id) => { hands[id] = g.hands[id]; });
  room.roundResult = {
    winnerId: r.winnerId, reason: r.reason, points: r.points, handPoints: r.handPoints, hands,
    eliminated: g.out.slice(), scores: Object.assign({}, room.scores),
  };
  room.unoWindow = null;
  const target = room.settings.target;
  const reached = target > 0 && room.scores[r.winnerId] >= target;
  if (target === 0 || reached) {
    room.phase = 'gameover';
    room.winnerId = r.winnerId;
    room.placements = room.players
      .map((p) => ({ id: p.id, name: p.name, score: room.scores[p.id] || 0 }))
      .sort((a, b) => b.score - a.score || (a.id === r.winnerId ? -1 : 0) - (b.id === r.winnerId ? -1 : 0));
    log(room, `${nameOf(room, r.winnerId)} gewinnt die Partie!`);
  } else {
    room.phase = 'roundend';
    log(room, `${nameOf(room, r.winnerId)} gewinnt Runde ${room.roundNo} (+${r.points} Punkte).`);
    if (humansConnected(room)) {
      room.roundTimer = setTimeout(() => {
        room.roundTimer = null;
        if (!rooms.has(room.code) || room.phase !== 'roundend') return;
        startRound(room); touchRoom(room); broadcastState(room);
      }, ROUND_RESULT_DELAY_MS);
    }
  }
}

// Wertet das Ergebnis einer Engine-Aktion aus (Events, Rundenende, UNO-Fenster).
function afterAction(room, res, actorId, unoFlag) {
  pushEvents(room, res.events || []);
  const g = room.game;
  if (g.phase === 'over') { onRoundOver(room); return; }
  // UNO: nach dem Ausspielen bleibt genau eine Karte übrig
  if (actorId && res.events.some((e) => e.t === 'play') && g.hands[actorId].length === 1 && !g.out.includes(actorId)) {
    if (unoFlag || !room.settings.unoRule) {
      if (room.settings.unoRule) pushEvents(room, [{ t: 'uno', id: actorId }]);
      room.unoWindow = null;
    } else {
      room.unoWindow = { id: actorId, until: Date.now() + UNO_WINDOW_MS };
      scheduleBotCatch(room, actorId);
      setTimeout(() => { if (rooms.has(room.code) && room.unoWindow && room.unoWindow.id === actorId && room.unoWindow.until <= Date.now()) { room.unoWindow = null; broadcastState(room); } }, UNO_WINDOW_MS + 60);
    }
  } else if (room.unoWindow && g.hands[room.unoWindow.id] && g.hands[room.unoWindow.id].length !== 1) {
    room.unoWindow = null;
  }
}

function catchUno(room, byId) {
  const w = room.unoWindow;
  if (!w || w.until <= Date.now() || w.id === byId) return false;
  const g = room.game;
  if (!g || g.phase !== 'play' || g.hands[w.id].length !== 1 || g.out.includes(w.id)) return false;
  room.unoWindow = null;
  const events = [{ t: 'unoCaught', id: w.id, by: byId }];
  E.extraDraw(g, w.id, 2, events);
  pushEvents(room, events);
  if (g.phase === 'over') onRoundOver(room);
  return true;
}

function scheduleBotCatch(room, targetId) {
  room.players.forEach((p) => {
    if (!p.isBot || p.id === targetId) return;
    if (Math.random() > 0.35) return;
    setTimeout(() => {
      if (!rooms.has(room.code) || !room.unoWindow || room.unoWindow.id !== targetId) return;
      if (catchUno(room, p.id)) { touchRoom(room); broadcastState(room); }
    }, 1400 + Math.random() * 1800);
  });
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

function addBot(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const used = new Set(room.players.map((p) => p.name));
  const name = BOT_NAME_POOL.find((n) => !used.has(n)) || `Bot ${room.players.length + 1}`;
  const bot = { id: makeId(), token: makeId(), name, socketId: null, connected: true, isBot: true };
  room.players.push(bot);
  return bot;
}

function performAction(room, playerId, action, unoDefault) {
  const g = room.game;
  let res;
  if (action.type === 'play') {
    res = E.play(g, playerId, action.cardId, { color: action.color, targetId: action.targetId });
    if (res.ok) afterAction(room, res, playerId, action.uno !== undefined ? !!action.uno : unoDefault);
  } else if (action.type === 'draw') {
    res = E.drawUntilPlayable(g, playerId);
    if (res.ok) afterAction(room, res, null);
  } else if (action.type === 'penalty') {
    res = E.takePenalty(g, playerId);
    if (res.ok) afterAction(room, res, null);
  } else if (action.type === 'pass') {
    res = E.pass(g, playerId);
    if (res.ok) afterAction(room, res, null);
  } else {
    return { ok: false, error: 'Unbekannte Aktion.' };
  }
  if (res.ok) { touchRoom(room); broadcastState(room); }
  return res;
}

function botMove(room, player) {
  const g = room.game;
  if (!g || g.phase !== 'play' || g.turn !== player.id) return;
  let action = bots.decide(g, player.id);
  // Bots rufen UNO fast immer - aber nicht immer, sonst lohnt sich Aufpassen nie.
  const uno = Math.random() < 0.9;
  let res = performAction(room, player.id, action, uno);
  if (!res.ok) {
    // Fallback: Notlösung, damit die Partie nie hängen bleibt.
    const fb = g.pending > 0 ? { type: 'penalty' } : (E.canDraw(g, player.id) ? { type: 'draw' } : (g.drawn ? { type: 'pass' } : null));
    if (fb) performAction(room, player.id, fb, uno);
  }
}

function scheduleBotTurnIfNeeded(room) {
  if (room.phase !== 'playing' || !room.game) return;
  const g = room.game;
  const turnPlayer = findPlayer(room, g.turn);
  if (!turnPlayer) return;
  // Verbundene Menschen werden nie automatisch bewegt - der Host kann sie überspringen.
  if (!turnPlayer.isBot && turnPlayer.connected) return;
  if (room.botTimer) return;
  const turnAtSchedule = g.turnNo;
  const roundAtSchedule = room.roundNo;
  const delay = randomDelay();
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!rooms.has(room.code) || room.phase !== 'playing' || !room.game) return;
    if (room.game.turnNo !== turnAtSchedule || room.roundNo !== roundAtSchedule) { scheduleBotTurnIfNeeded(room); return; }
    botMove(room, turnPlayer);
  }, delay);
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

function ensureHost(room) {
  const host = findPlayer(room, room.hostId);
  if (host && !host.isBot && host.connected) return false;
  const next = room.players.find((p) => !p.isBot && p.connected);
  if (!next) return false;
  room.hostId = next.id;
  log(room, `${next.name} ist jetzt Host.`);
  return true;
}

function scheduleHostHandover(room) {
  if (room.hostTimer) clearTimeout(room.hostTimer);
  room.hostTimer = setTimeout(() => {
    room.hostTimer = null;
    if (rooms.has(room.code) && ensureHost(room)) { touchRoom(room); broadcastState(room); }
  }, HOST_HANDOVER_MS);
}

function resetToLobby(room) {
  ['roundTimer', 'botTimer'].forEach((k) => { if (room[k]) clearTimeout(room[k]); room[k] = null; });
  room.phase = 'lobby';
  room.game = null;
  room.scores = {};
  room.roundNo = 0;
  room.roundResult = null;
  room.winnerId = null;
  room.placements = null;
  room.events = [];
  room.unoWindow = null;
  room.logs = [];
  // Wer das Spiel verlassen hat, fliegt beim Zurücksetzen aus der Lobby.
  room.players = room.players.filter((p) => p.isBot || p.connected);
  log(room, 'Zurück zur Lobby. Bereit für eine neue Partie.');
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

function cleanName(name) { return (name || '').toString().trim().slice(0, 20) || 'Spieler'; }

io.on('connection', (socket) => {
  const ctx = () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return {};
    return { room, player: findPlayer(room, socket.data.playerId) };
  };

  socket.on('createRoom', ({ name } = {}, cb) => {
    if (typeof cb !== 'function') return;
    try {
      if (isRateLimited(`createRoom:${getClientIp(socket)}`, 8, 60 * 1000)) {
        return cb({ ok: false, error: 'Zu viele neue Räume in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
      }
      if (rooms.size >= MAX_ROOMS) {
        return cb({ ok: false, error: 'Gerade sind zu viele Räume aktiv. Bitte versuche es in ein paar Minuten erneut.' });
      }
      name = cleanName(name);
      const room = createRoom();
      const player = { id: makeId(), token: makeId(), name, socketId: socket.id, connected: true };
      room.hostId = player.id;
      room.players.push(player);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      log(room, `${name} hat den Raum erstellt.`);
      touchRoom(room);
      cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcastState(room);
    } catch (err) {
      cb({ ok: false, error: 'Raum konnte nicht erstellt werden.' });
    }
  });

  socket.on('joinRoom', ({ code, name, token } = {}, cb) => {
    if (typeof cb !== 'function') return;
    if (isRateLimited(`joinRoom:${getClientIp(socket)}`, 30, 60 * 1000)) {
      return cb({ ok: false, error: 'Zu viele Versuche in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
    }
    code = (code || '').toString().trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Diesen Raum gibt es nicht.' });

    if (token) {
      const existing = room.players.find((p) => p.token === token && !p.isBot);
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        if (room.hostId === existing.id && room.hostTimer) { clearTimeout(room.hostTimer); room.hostTimer = null; }
        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.playerId = existing.id;
        touchRoom(room);
        log(room, `${existing.name} ist wieder verbunden.`);
        cb({ ok: true, code: room.code, playerId: existing.id, token: existing.token, rejoined: true });
        broadcastState(room);
        return;
      }
    }

    if (room.phase !== 'lobby') return cb({ ok: false, error: 'Das Spiel läuft bereits. Bitte warte auf die nächste Partie.' });
    if (room.players.length >= MAX_PLAYERS) return cb({ ok: false, error: `Der Raum ist bereits voll (max. ${MAX_PLAYERS} Spieler).` });
    name = cleanName(name);
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return cb({ ok: false, error: 'Dieser Name ist im Raum bereits vergeben.' });
    }
    const player = { id: makeId(), token: makeId(), name, socketId: socket.id, connected: true };
    room.players.push(player);
    if (!room.hostId) room.hostId = player.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    touchRoom(room);
    log(room, `${name} ist dem Raum beigetreten.`);
    cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
    broadcastState(room);
  });

  socket.on('leaveRoom', () => {
    const { room, player } = ctx();
    if (!room || !player) return;
    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p.id !== player.id);
      if (room.hostId === player.id) {
        room.hostId = null;
        const next = room.players.find((p) => !p.isBot);
        if (next) room.hostId = next.id;
      }
      log(room, `${player.name} hat den Raum verlassen.`);
    } else {
      player.connected = false;
      player.socketId = null; // kein privater Kartenkanal mehr aus dem verlassenen Spiel
      log(room, `${player.name} hat das Spiel verlassen.`);
      ensureHost(room);
    }
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    touchRoom(room);
    if (!room.players.some((p) => !p.isBot)) destroyRoom(room);
    else broadcastState(room);
  });

  socket.on('kickPlayer', ({ playerId } = {}) => {
    const { room, player } = ctx();
    if (!room || !player || room.phase !== 'lobby') return;
    if (player.id !== room.hostId || playerId === room.hostId) return;
    const target = findPlayer(room, playerId);
    if (!target) return;
    room.players = room.players.filter((p) => p.id !== playerId);
    if (target.socketId) io.to(target.socketId).emit('kicked');
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('addBot', () => {
    const { room, player } = ctx();
    if (!room || !player || room.phase !== 'lobby' || player.id !== room.hostId) return;
    addBot(room); touchRoom(room); broadcastState(room);
  });

  socket.on('removeBot', ({ botId } = {}) => {
    const { room, player } = ctx();
    if (!room || !player || room.phase !== 'lobby' || player.id !== room.hostId) return;
    const bot = findPlayer(room, botId);
    if (!bot || !bot.isBot) return;
    room.players = room.players.filter((p) => p.id !== botId);
    touchRoom(room); broadcastState(room);
  });

  socket.on('fillBots', () => {
    const { room, player } = ctx();
    if (!room || !player || room.phase !== 'lobby' || player.id !== room.hostId) return;
    while (room.players.length < MIN_PLAYERS) addBot(room);
    touchRoom(room); broadcastState(room);
  });

  socket.on('setSettings', (s) => {
    const { room, player } = ctx();
    if (!room || !player || room.phase !== 'lobby' || player.id !== room.hostId) return;
    s = s || {};
    if (typeof s.sevenZero === 'boolean') room.settings.sevenZero = s.sevenZero;
    if (typeof s.unoRule === 'boolean') room.settings.unoRule = s.unoRule;
    if (TARGETS.includes(Number(s.target))) room.settings.target = Number(s.target);
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const { room, player } = ctx();
    if (!room || !player || room.phase !== 'lobby' || player.id !== room.hostId) return;
    if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) return;
    startGame(room);
    touchRoom(room);
    broadcastState(room);
  });

  // --- Spielzüge ---------------------------------------------------------

  function act(action, reply) {
    const { room, player } = ctx();
    if (!room || !player || room.phase !== 'playing' || !room.game) return reply && reply({ ok: false, error: 'Gerade läuft keine Runde.' });
    const res = performAction(room, player.id, action, false);
    if (reply) reply(res.ok ? { ok: true } : { ok: false, error: res.error, needColor: res.needColor, needTarget: res.needTarget });
    else if (!res.ok) socket.emit('actionError', { error: res.error });
  }

  socket.on('play', (d, cb) => {
    d = d || {};
    act({ type: 'play', cardId: String(d.cardId || ''), color: d.color, targetId: d.targetId, uno: !!d.uno }, typeof cb === 'function' ? cb : null);
  });
  socket.on('drawCard', (_d, cb) => act({ type: 'draw' }, typeof cb === 'function' ? cb : null));
  socket.on('takePenalty', (_d, cb) => act({ type: 'penalty' }, typeof cb === 'function' ? cb : null));
  socket.on('pass', (_d, cb) => act({ type: 'pass' }, typeof cb === 'function' ? cb : null));

  // UNO nachträglich rufen (innerhalb des Fensters) bzw. andere erwischen.
  socket.on('callUno', () => {
    const { room, player } = ctx();
    if (!room || !player || !room.unoWindow || room.unoWindow.id !== player.id) return;
    if (room.unoWindow.until <= Date.now()) return;
    room.unoWindow = null;
    pushEvents(room, [{ t: 'uno', id: player.id }]);
    broadcastState(room);
  });

  socket.on('catchUno', () => {
    const { room, player } = ctx();
    if (!room || !player || room.phase !== 'playing') return;
    if (catchUno(room, player.id)) { touchRoom(room); broadcastState(room); }
  });

  socket.on('nextRound', () => {
    const { room, player } = ctx();
    if (!room || !player || room.phase !== 'roundend' || player.id !== room.hostId) return;
    startRound(room); touchRoom(room); broadcastState(room);
  });

  socket.on('resetGame', () => {
    const { room, player } = ctx();
    if (!room || !player || player.id !== room.hostId) return;
    if (room.phase !== 'gameover' && room.phase !== 'roundend' && room.phase !== 'playing') return;
    resetToLobby(room);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('skipTurn', () => {
    const { room, player } = ctx();
    if (!room || !player) return;
    const info = waitInfo(room);
    if (!info || info.elapsedMs < SKIP_MIN_WAIT_MS) return;
    const isHost = player.id === room.hostId;
    if (!isHost && !info.ids.includes(room.hostId)) return;
    if (info.ids.includes(player.id)) return;
    info.ids.forEach((id) => {
      const p = findPlayer(room, id);
      if (p) { log(room, `${p.name} wurde übersprungen.`); botMove(room, p); }
    });
  });

  socket.on('disconnect', () => {
    const { room, player } = ctx();
    if (!room || !player) return;
    if (player.socketId !== socket.id) return; // verspätetes Event eines alten Sockets nach Reconnect
    player.connected = false;
    log(room, `${player.name} hat die Verbindung verloren.`);
    if (room.hostId === player.id) scheduleHostHandover(room);
    touchRoom(room);
    broadcastState(room);
  });
});

server.listen(PORT, () => {
  console.log(`Uno No Mercy läuft auf Port ${PORT}`);
  console.log(`Lokal öffnen unter: http://localhost:${PORT}`);
});

module.exports = { E };
