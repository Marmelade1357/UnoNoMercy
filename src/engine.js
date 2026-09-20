// Uno No Mercy - reine Spiellogik (kein Netzwerk, kein Timer).
// Server und Tests nutzen dieselbe Datei; der Browser bekommt nur den
// serialisierten Zustand (server.js -> publicState).
//
// Kartenspiel: 168 Karten
//   je Farbe (rot, gelb, gruen, blau): 0-9 je 2x, Aussetzen 3x, Richtungswechsel 3x,
//   +2 3x, +4 3x, Alle ablegen 3x, Alle aussetzen 2x  (= 37 x 4 = 148)
//   Joker: Wilder Richtungswechsel +4 8x, Wild +6 4x, Wild +10 4x, Farbroulette 4x (= 20)

'use strict';

const COLORS = ['red', 'yellow', 'green', 'blue'];

// kind: num | skip | reverse | draw2 | draw4 | discard | skipall | wildrev4 | wild6 | wild10 | roulette
const DRAW_VALUE = { draw2: 2, draw4: 4, wildrev4: 4, wild6: 6, wild10: 10 };
const WILD_KINDS = ['wildrev4', 'wild6', 'wild10', 'roulette'];

const DEFAULT_RULES = { sevenZero: true, mercy: 25, stacking: true };

function isWild(card) { return WILD_KINDS.includes(card.kind); }
function isDraw(card) { return DRAW_VALUE[card.kind] !== undefined; }

function buildDeck() {
  const deck = [];
  let n = 0;
  const add = (color, kind, value, count) => {
    for (let i = 0; i < count; i++) deck.push({ id: `c${n++}`, color, kind, value: value === undefined ? null : value });
  };
  COLORS.forEach((color) => {
    for (let v = 0; v <= 9; v++) add(color, 'num', v, 2);
    add(color, 'skip', undefined, 3);
    add(color, 'reverse', undefined, 3);
    add(color, 'draw2', undefined, 3);
    add(color, 'draw4', undefined, 3);
    add(color, 'discard', undefined, 3);
    add(color, 'skipall', undefined, 2);
  });
  add(null, 'wildrev4', undefined, 8);
  add(null, 'wild6', undefined, 4);
  add(null, 'wild10', undefined, 4);
  add(null, 'roulette', undefined, 4);
  return deck; // 168 Karten
}

function shuffle(arr, rng) {
  const r = rng || Math.random;
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardPoints(card) {
  if (card.kind === 'num') return card.value;
  return isWild(card) ? 50 : 20;
}

function cardLabel(card) {
  const col = { red: 'Rot', yellow: 'Gelb', green: 'Grün', blue: 'Blau' };
  const names = {
    skip: 'Aussetzen', reverse: 'Richtungswechsel', draw2: '+2', draw4: '+4', discard: 'Alle ablegen',
    skipall: 'Alle aussetzen', wildrev4: 'Wilder Richtungswechsel +4', wild6: 'Wild +6', wild10: 'Wild +10', roulette: 'Farbroulette',
  };
  if (card.kind === 'num') return `${col[card.color]} ${card.value}`;
  return card.color ? `${col[card.color]} ${names[card.kind]}` : names[card.kind];
}

// ---------------------------------------------------------------------------
// Spielaufbau
// ---------------------------------------------------------------------------

function createGame(playerIds, opts) {
  const o = opts || {};
  const rng = o.rng || Math.random;
  const rules = Object.assign({}, DEFAULT_RULES, o.rules || {});
  const draw = shuffle(buildDeck(), rng);
  const hands = {};
  playerIds.forEach((id) => { hands[id] = []; });
  for (let k = 0; k < 7; k++) playerIds.forEach((id) => { hands[id].push(draw.pop()); });
  // Startkarte: immer eine Zahlenkarte (Aktions-/Jokerkarten wandern unter den Stapel).
  let start = draw.pop();
  while (start.kind !== 'num') { draw.unshift(start); start = draw.pop(); }
  const startIdx = Number.isInteger(o.startIdx) ? o.startIdx % playerIds.length : Math.floor(rng() * playerIds.length);
  return {
    rules,
    order: playerIds.slice(),
    hands,
    draw,
    discard: [start],
    color: start.color,
    dir: 1,
    turn: playerIds[startIdx],
    pending: 0,        // aufgestapelte Strafkarten
    pendingMin: 0,     // Wert der zuletzt gespielten Ziehkarte (nächste muss mindestens gleich sein)
    drawn: false,      // in diesem Zug wurde bereits bis zur spielbaren Karte gezogen
    out: [],           // per Mercy-Regel Ausgeschiedene (in Reihenfolge)
    phase: 'play',     // play | over
    winnerId: null,
    result: null,
    turnNo: 1,
    rng,
  };
}

function top(game) { return game.discard[game.discard.length - 1]; }
function alive(game) { return game.order.filter((id) => !game.out.includes(id)); }
function isOut(game, id) { return game.out.includes(id); }

// n Schritte in Spielrichtung über noch aktive Personen.
function stepFrom(game, id, n) {
  const seats = game.order;
  let idx = seats.indexOf(id);
  let left = n;
  let guard = 0;
  while (left > 0 && guard++ < seats.length * (n + 2)) {
    idx = (idx + game.dir + seats.length) % seats.length;
    if (!game.out.includes(seats[idx])) left--;
  }
  return seats[idx];
}

// ---------------------------------------------------------------------------
// Karten passen? Spielbar?
// ---------------------------------------------------------------------------

function canPlayCard(game, card) {
  if (game.pending > 0) {
    return game.rules.stacking && isDraw(card) && DRAW_VALUE[card.kind] >= game.pendingMin;
  }
  if (isWild(card)) return true;
  const t = top(game);
  if (card.color === game.color) return true;
  if (card.kind === t.kind && (card.kind !== 'num' || card.value === t.value)) return true;
  return false;
}

function legalPlays(game, id) {
  if (game.phase !== 'play' || game.turn !== id) return [];
  return (game.hands[id] || []).filter((c) => canPlayCard(game, c)).map((c) => c.id);
}

function canDraw(game, id) {
  return game.phase === 'play' && game.turn === id && game.pending === 0 && !game.drawn && legalPlays(game, id).length === 0;
}

// ---------------------------------------------------------------------------
// Ziehen, Mischen, Mercy
// ---------------------------------------------------------------------------

function refillDraw(game) {
  if (game.draw.length > 0) return;
  if (game.discard.length <= 1) return;
  const keep = game.discard.pop();
  const rest = game.discard.splice(0, game.discard.length);
  game.draw = shuffle(rest, game.rng);
  game.discard = [keep];
}

function drawOne(game, id) {
  refillDraw(game);
  if (!game.draw.length) return null;
  const c = game.draw.pop();
  game.hands[id].push(c);
  return c;
}

function drawCards(game, id, n) {
  let got = 0;
  for (let i = 0; i < n; i++) { if (drawOne(game, id)) got++; else break; }
  return got;
}

// Personen mit mindestens `mercy` Karten scheiden aus; ihre Karten gehen zurück in den Stapel.
function applyMercy(game, events) {
  const limit = game.rules.mercy;
  if (!limit) return;
  alive(game).forEach((id) => {
    if (game.hands[id].length >= limit) {
      const cards = game.hands[id];
      game.hands[id] = [];
      game.out.push(id);
      game.draw = shuffle(game.draw.concat(cards), game.rng);
      events.push({ t: 'mercy', id, n: cards.length });
    }
  });
}

// ---------------------------------------------------------------------------
// Rundenende
// ---------------------------------------------------------------------------

function finish(game, winnerId, reason, events) {
  game.phase = 'over';
  game.winnerId = winnerId;
  let points = 0;
  const handPoints = {};
  game.order.forEach((id) => {
    if (id === winnerId) return;
    if (game.out.includes(id)) { points += 250; handPoints[id] = 250; return; }
    const p = game.hands[id].reduce((a, c) => a + cardPoints(c), 0);
    handPoints[id] = p;
    points += p;
  });
  game.result = { winnerId, reason, points, handPoints };
  events.push({ t: 'over', id: winnerId, reason, points });
}

function checkEnd(game, events, justPlayed) {
  if (game.phase !== 'play') return true;
  if (justPlayed && game.hands[justPlayed].length === 0) { finish(game, justPlayed, 'empty', events); return true; }
  const a = alive(game);
  if (a.length <= 1) { finish(game, a[0] || justPlayed, 'last', events); return true; }
  return false;
}

function startTurn(game, id) {
  game.turn = id;
  game.drawn = false;
  game.turnNo++;
}

// ---------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------

// opts: { color, targetId }
function play(game, id, cardId, opts) {
  const o = opts || {};
  if (game.phase !== 'play') return { ok: false, error: 'Die Runde ist beendet.' };
  if (game.turn !== id) return { ok: false, error: 'Du bist nicht am Zug.' };
  const hand = game.hands[id];
  const idx = hand.findIndex((c) => c.id === cardId);
  if (idx < 0) return { ok: false, error: 'Diese Karte hast du nicht.' };
  const card = hand[idx];
  if (!canPlayCard(game, card)) {
    return { ok: false, error: game.pending > 0 ? 'Du musst mit einer gleich hohen oder höheren Ziehkarte kontern – oder die Karten ziehen.' : 'Diese Karte passt nicht.' };
  }
  if (isWild(card) && !COLORS.includes(o.color)) return { ok: false, error: 'Bitte wähle eine Farbe.', needColor: true };
  const isSeven = card.kind === 'num' && card.value === 7 && game.rules.sevenZero;
  const isZero = card.kind === 'num' && card.value === 0 && game.rules.sevenZero;
  const others = alive(game).filter((x) => x !== id);
  if (isSeven && others.length) {
    if (!others.includes(o.targetId)) return { ok: false, error: 'Bitte wähle, mit wem du tauschst.', needTarget: true };
  }

  const events = [];
  hand.splice(idx, 1);
  game.color = card.color || o.color;
  game.drawn = false;

  let steps = 1;
  const aliveCount = alive(game).length;

  if (card.kind === 'discard') {
    const extras = hand.filter((c) => c.color === card.color);
    game.hands[id] = hand.filter((c) => c.color !== card.color);
    game.discard.push(...extras, card);
    events.push({ t: 'play', id, card, color: game.color });
    events.push({ t: 'discardAll', id, n: extras.length });
  } else {
    game.discard.push(card);
    events.push({ t: 'play', id, card, color: game.color });
  }

  switch (card.kind) {
    case 'skip':
      steps = 2; events.push({ t: 'skip', id: stepFrom(game, id, 1) });
      break;
    case 'reverse':
      game.dir = -game.dir; events.push({ t: 'reverse', dir: game.dir });
      if (aliveCount === 2) steps = 2;
      break;
    case 'skipall':
      steps = aliveCount; events.push({ t: 'skipall' });
      break;
    case 'draw2': case 'draw4': case 'wild6': case 'wild10':
      game.pending += DRAW_VALUE[card.kind]; game.pendingMin = DRAW_VALUE[card.kind];
      events.push({ t: 'pending', n: game.pending });
      break;
    case 'wildrev4':
      game.dir = -game.dir; events.push({ t: 'reverse', dir: game.dir });
      game.pending += 4; game.pendingMin = 4;
      events.push({ t: 'pending', n: game.pending });
      break;
    case 'roulette': {
      const victim = stepFrom(game, id, 1);
      if (victim !== id) {
        let n = 0; let hit = false;
        while (!hit) {
          const c = drawOne(game, victim);
          if (!c) break;
          n++;
          if (c.color === game.color) hit = true;
          if (game.hands[victim].length >= game.rules.mercy && game.rules.mercy) break;
        }
        events.push({ t: 'roulette', id: victim, color: game.color, n });
        steps = 2;
      }
      break;
    }
    case 'num':
      if (isSeven && others.length) {
        const mine = game.hands[id];
        game.hands[id] = game.hands[o.targetId];
        game.hands[o.targetId] = mine;
        events.push({ t: 'swap', id, targetId: o.targetId });
      } else if (isZero && aliveCount > 1) {
        const seq = alive(game);
        const ordered = [];
        let cur = id;
        for (let i = 0; i < seq.length; i++) { ordered.push(cur); cur = stepFrom(game, cur, 1); }
        const old = {};
        ordered.forEach((p) => { old[p] = game.hands[p]; });
        ordered.forEach((p, i) => { game.hands[ordered[(i + 1) % ordered.length]] = old[p]; });
        events.push({ t: 'rotate', dir: game.dir });
      }
      break;
    default: break;
  }

  applyMercy(game, events);
  if (checkEnd(game, events, id)) return { ok: true, events };
  // Die spielende Person kann durch Tausch selbst ausgeschieden sein - dann geht es reihum weiter.
  startTurn(game, stepFrom(game, id, isOut(game, id) ? 1 : steps));
  return { ok: true, events };
}

// Strafkarten nehmen (statt zu kontern).
function takePenalty(game, id) {
  if (game.phase !== 'play' || game.turn !== id) return { ok: false, error: 'Du bist nicht am Zug.' };
  if (game.pending <= 0) return { ok: false, error: 'Es gibt keine Strafkarten.' };
  const events = [];
  const n = game.pending;
  const got = drawCards(game, id, n);
  game.pending = 0; game.pendingMin = 0;
  events.push({ t: 'penalty', id, n: got });
  applyMercy(game, events);
  if (checkEnd(game, events, null)) return { ok: true, events };
  startTurn(game, stepFrom(game, id, 1));
  return { ok: true, events };
}

// Keine passende Karte: ziehen, bis eine passt.
function drawUntilPlayable(game, id) {
  if (game.phase !== 'play' || game.turn !== id) return { ok: false, error: 'Du bist nicht am Zug.' };
  if (game.pending > 0) return { ok: false, error: 'Zuerst die Strafkarten nehmen oder kontern.' };
  if (game.drawn) return { ok: false, error: 'Du hast schon gezogen.' };
  if (legalPlays(game, id).length) return { ok: false, error: 'Du hast eine passende Karte.' };
  const events = [];
  let n = 0; let found = false;
  const limit = game.rules.mercy || 1e9;
  while (!found) {
    const c = drawOne(game, id);
    if (!c) break;
    n++;
    if (canPlayCard(game, c)) found = true;
    if (game.hands[id].length >= limit) break;
  }
  events.push({ t: 'draw', id, n });
  applyMercy(game, events);
  if (checkEnd(game, events, null)) return { ok: true, events };
  if (isOut(game, id) || !found) {
    startTurn(game, stepFrom(game, id, 1));
  } else {
    game.drawn = true;
  }
  return { ok: true, events, found };
}

// Nach dem Ziehen die Karte doch nicht spielen.
function pass(game, id) {
  if (game.phase !== 'play' || game.turn !== id) return { ok: false, error: 'Du bist nicht am Zug.' };
  if (!game.drawn) return { ok: false, error: 'Du musst zuerst ziehen.' };
  const events = [{ t: 'pass', id }];
  startTurn(game, stepFrom(game, id, 1));
  return { ok: true, events };
}

// Zusatzkarten außerhalb des eigenen Zugs (z. B. UNO vergessen). Wendet Mercy an und
// gibt den Zug weiter, falls die Person am Zug dadurch ausscheidet.
function extraDraw(game, id, n, events) {
  const got = drawCards(game, id, n);
  events.push({ t: 'draw', id, n: got });
  applyMercy(game, events);
  if (checkEnd(game, events, null)) return got;
  if (game.out.includes(game.turn)) startTurn(game, stepFrom(game, game.turn, 1));
  return got;
}

function handSizes(game) {
  const o = {};
  game.order.forEach((id) => { o[id] = game.hands[id].length; });
  return o;
}

module.exports = {
  COLORS, DRAW_VALUE, WILD_KINDS, DEFAULT_RULES,
  buildDeck, shuffle, createGame, canPlayCard, legalPlays, canDraw,
  play, takePenalty, drawUntilPlayable, pass, extraDraw,
  top, alive, isOut, stepFrom, isWild, isDraw, cardPoints, cardLabel, handSizes,
};
