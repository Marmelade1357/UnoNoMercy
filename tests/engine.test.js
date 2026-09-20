// Regeltests für src/engine.js (reine Logik, kein Netzwerk).
const E = require('../src/engine');
const { assert } = require('./helpers');

const C = (id, color, kind, value) => ({ id, color, kind, value: value === undefined ? null : value });

// Baut ein Spiel mit vorgegebenen Händen/Ablagekarte für gezielte Regeltests.
function mk(hands, topCard, extra) {
  const ids = Object.keys(hands);
  const g = E.createGame(ids, { startIdx: 0, rules: (extra && extra.rules) || {} });
  ids.forEach((id) => { g.hands[id] = hands[id]; });
  g.discard = [topCard];
  g.color = topCard.color;
  g.turn = ids[0];
  g.draw = (extra && extra.draw) || E.buildDeck().map((c, i) => Object.assign({}, c, { id: `d${i}` }));
  return g;
}
function total(g) { return g.draw.length + g.discard.length + Object.values(g.hands).reduce((a, h) => a + h.length, 0); }

function testDeck() {
  const d = E.buildDeck();
  assert(d.length === 168, `Deck hat ${d.length} statt 168 Karten`);
  assert(new Set(d.map((c) => c.id)).size === 168, 'Karten-IDs nicht eindeutig');
  const count = (f) => d.filter(f).length;
  assert(count((c) => c.kind === 'num' && c.color === 'red' && c.value === 0) === 2, '0 rot 2x');
  assert(count((c) => c.kind === 'wildrev4') === 8, 'wildrev4 8x');
  assert(count((c) => c.kind === 'wild10') === 4 && count((c) => c.kind === 'wild6') === 4 && count((c) => c.kind === 'roulette') === 4, 'Joker-Anzahlen');
  assert(count((c) => c.kind === 'skipall') === 8 && count((c) => c.kind === 'discard') === 12, 'Aktionskarten-Anzahlen');
  const g = E.createGame(['a', 'b', 'c']);
  assert(g.hands.a.length === 7 && g.hands.b.length === 7 && g.hands.c.length === 7, '7 Startkarten');
  assert(E.top(g).kind === 'num', 'Startkarte ist eine Zahl');
  assert(total(g) === 168, 'Kartensumme nach Start');
}

function testMatching() {
  const g = mk({ a: [C('1', 'red', 'num', 5), C('2', 'blue', 'num', 5), C('3', 'blue', 'num', 6), C('4', null, 'wild6')], b: [C('9', 'red', 'num', 1)] }, C('t', 'red', 'num', 5));
  const p = E.legalPlays(g, 'a');
  assert(p.includes('1') && p.includes('2') && !p.includes('3') && p.includes('4'), 'Farbe/Zahl/Joker passen');
  assert(E.legalPlays(g, 'b').length === 0, 'nicht am Zug -> nichts spielbar');
  const r = E.play(g, 'a', '3');
  assert(!r.ok, 'unpassende Karte abgelehnt');
  const w = E.play(g, 'a', '4');
  assert(!w.ok && w.needColor, 'Joker braucht Farbe');
}

function testDrawStacking() {
  const g = mk({ a: [C('1', 'red', 'draw2'), C('x', 'red', 'num', 1)], b: [C('2', 'blue', 'draw2'), C('3', 'green', 'draw4'), C('4', 'blue', 'num', 3)], c: [C('5', 'blue', 'num', 1), C('6', null, 'wild10')] }, C('t', 'red', 'num', 5));
  let r = E.play(g, 'a', '1');
  assert(r.ok && g.pending === 2 && g.turn === 'b', '+2 startet Stapel');
  assert(E.legalPlays(g, 'b').join() === '2,3', 'b darf +2 und +4 stapeln (gleich/höher), keine Zahl');
  r = E.play(g, 'b', '3');
  assert(r.ok && g.pending === 6 && g.pendingMin === 4 && g.turn === 'c', 'Werte addieren sich');
  assert(E.legalPlays(g, 'c').join() === '6', 'c darf nur Wild +10 (>= 4)');
  const before = g.hands.c.length;
  r = E.takePenalty(g, 'c');
  assert(r.ok && g.hands.c.length === before + 6 && g.pending === 0 && g.turn === 'a', 'Strafe wird gezogen, Zug endet');
  const g2 = mk({ a: [C('1', 'red', 'draw4'), C('z', 'red', 'num', 9)], b: [C('2', 'red', 'draw2'), C('y', 'red', 'num', 1)] }, C('t', 'red', 'num', 5));
  E.play(g2, 'a', '1');
  assert(E.legalPlays(g2, 'b').length === 0, '+2 darf nicht auf +4');
  const bad = E.drawUntilPlayable(g2, 'b');
  assert(!bad.ok, 'unter Strafe nicht regulär ziehen');
}

function testActions() {
  // Aussetzen
  let g = mk({ a: [C('1', 'red', 'skip'), C('x', 'red', 'num', 1)], b: [C('b1', 'red', 'num', 1)], c: [C('c1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5));
  E.play(g, 'a', '1'); assert(g.turn === 'c', 'Aussetzen überspringt b');
  // Richtungswechsel 3 Spieler
  g = mk({ a: [C('1', 'red', 'reverse'), C('x', 'red', 'num', 1)], b: [C('b1', 'red', 'num', 1)], c: [C('c1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5));
  E.play(g, 'a', '1'); assert(g.dir === -1 && g.turn === 'c', 'Richtungswechsel dreht um');
  // Richtungswechsel 2 Spieler = Aussetzen
  g = mk({ a: [C('1', 'red', 'reverse'), C('x', 'red', 'num', 1)], b: [C('b1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5));
  E.play(g, 'a', '1'); assert(g.turn === 'a', 'Reverse zu zweit: nochmal dran');
  // Alle aussetzen
  g = mk({ a: [C('1', 'red', 'skipall'), C('x', 'red', 'num', 1)], b: [C('b1', 'red', 'num', 1)], c: [C('c1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5));
  E.play(g, 'a', '1'); assert(g.turn === 'a', 'Alle aussetzen: dieselbe Person nochmal');
  // Alle ablegen
  g = mk({ a: [C('1', 'red', 'discard'), C('r2', 'red', 'num', 2), C('r3', 'red', 'num', 3), C('bl', 'blue', 'num', 3)], b: [C('b1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5));
  const n0 = total(g);
  E.play(g, 'a', '1');
  assert(g.hands.a.length === 1 && g.hands.a[0].id === 'bl', 'Alle ablegen entfernt alle roten Karten');
  assert(E.top(g).id === '1' && g.discard.length === 4, 'Ablagekarte ist die Discard-All-Karte');
  assert(total(g) === n0, 'Kartenzahl bleibt gleich');
  // Wild Reverse +4
  g = mk({ a: [C('1', null, 'wildrev4'), C('x', 'red', 'num', 1)], b: [C('b1', 'red', 'num', 1)], c: [C('c1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5));
  E.play(g, 'a', '1', { color: 'green' });
  assert(g.dir === -1 && g.color === 'green' && g.pending === 4 && g.turn === 'c', 'Wilder Richtungswechsel +4');
  // Wild +6 / +10 ändern Farbe
  g = mk({ a: [C('1', null, 'wild10'), C('x', 'red', 'num', 1)], b: [C('b1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5));
  E.play(g, 'a', '1', { color: 'blue' });
  assert(g.pending === 10 && g.color === 'blue', 'Wild +10');
}

function testRoulette() {
  const draw = [C('d0', 'red', 'num', 1), C('d1', 'green', 'num', 1), C('d2', 'blue', 'num', 1), C('d3', 'blue', 'num', 2)]; // pop() -> d3 zuerst
  const g = mk({ a: [C('1', null, 'roulette'), C('x', 'red', 'num', 1)], b: [C('b1', 'red', 'num', 1)], c: [C('c1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5), { draw });
  E.play(g, 'a', '1', { color: 'green' });
  assert(g.hands.b.length === 1 + 3, `b zieht bis Grün (hat ${g.hands.b.length})`);
  assert(g.hands.b[g.hands.b.length - 1].color === 'green', 'letzte gezogene Karte ist grün');
  assert(g.turn === 'c', 'Roulette-Opfer wird übersprungen');
}

function testSevenZero() {
  let g = mk({ a: [C('7', 'red', 'num', 7), C('x', 'blue', 'num', 1), C('y', 'blue', 'num', 2)], b: [C('b1', 'red', 'num', 1)], c: [C('c1', 'red', 'num', 1), C('c2', 'red', 'num', 2)] }, C('t', 'red', 'num', 5));
  let r = E.play(g, 'a', '7');
  assert(!r.ok && r.needTarget, '7 braucht Tauschpartner');
  r = E.play(g, 'a', '7', { targetId: 'c' });
  assert(r.ok && g.hands.a.map((c) => c.id).join() === 'c1,c2' && g.hands.c.map((c) => c.id).join() === 'x,y', '7 tauscht Hände');
  g = mk({ a: [C('0', 'red', 'num', 0), C('a1', 'blue', 'num', 1)], b: [C('b1', 'red', 'num', 1), C('b2', 'red', 'num', 2)], c: [C('c1', 'red', 'num', 1), C('c2', 'red', 'num', 2), C('c3', 'red', 'num', 3)] }, C('t', 'red', 'num', 5));
  E.play(g, 'a', '0');
  // a hat nach dem Ablegen [a1] -> geht an b; b -> c; c -> a
  assert(g.hands.b.map((c) => c.id).join() === 'a1' && g.hands.c.length === 2 && g.hands.a.length === 3, '0 reicht Hände in Spielrichtung weiter');
  g = mk({ a: [C('7', 'red', 'num', 7), C('x', 'blue', 'num', 1)], b: [C('b1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5), { rules: { sevenZero: false } });
  r = E.play(g, 'a', '7');
  assert(r.ok && g.hands.b.length === 1, 'ohne 7-0-Regel kein Tausch');
}

function testDrawAndMercy() {
  // Keine passende Karte: ziehen bis passt
  const draw = [C('d0', 'blue', 'num', 1), C('d1', 'red', 'num', 8), C('d2', 'green', 'num', 3), C('d3', 'yellow', 'num', 3)];
  let g = mk({ a: [C('x', 'blue', 'num', 9)], b: [C('b1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5), { draw });
  assert(E.canDraw(g, 'a'), 'ziehen erlaubt ohne passende Karte');
  let r = E.drawUntilPlayable(g, 'a');
  assert(r.ok && g.hands.a.length === 4 && g.drawn && g.turn === 'a', 'zieht bis zur roten Karte, bleibt am Zug');
  r = E.pass(g, 'a');
  assert(r.ok && g.turn === 'b' && !g.drawn, 'Passen gibt Zug weiter');
  // Mercy
  const big = []; for (let i = 0; i < 20; i++) big.push(C(`m${i}`, 'blue', 'num', 1));
  g = mk({ a: [C('1', null, 'wild10'), C('a2', 'red', 'num', 1)], b: big.slice(), c: [C('c1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5));
  E.play(g, 'a', '1', { color: 'red' });
  const n0 = total(g);
  r = E.takePenalty(g, 'b');
  assert(g.out.includes('b') && g.hands.b.length === 0, 'ab 25 Karten Mercy-Ausscheiden');
  assert(total(g) === n0, 'Karten wandern zurück in den Stapel');
  assert(g.turn === 'c', 'Zug geht an die nächste aktive Person');
  // Letzte Person übrig gewinnt
  g = mk({ a: [C('1', null, 'wild10'), C('a2', 'red', 'num', 1)], b: big.slice() }, C('t', 'red', 'num', 5));
  E.play(g, 'a', '1', { color: 'red' });
  E.takePenalty(g, 'b');
  assert(g.phase === 'over' && g.winnerId === 'a' && g.result.reason === 'last' && g.result.points === 250, 'Letzte Person gewinnt, 250 Punkte je Ausgeschiedenem');
}

function testWinAndScore() {
  const g = mk({ a: [C('1', 'red', 'num', 5)], b: [C('b1', 'red', 'num', 9), C('b2', null, 'wild6'), C('b3', 'red', 'skip')], c: [C('c1', 'blue', 'num', 2)] }, C('t', 'red', 'num', 5));
  const r = E.play(g, 'a', '1');
  assert(r.ok && g.phase === 'over' && g.winnerId === 'a' && g.result.reason === 'empty', 'letzte Karte gewinnt');
  assert(g.result.points === 9 + 50 + 20 + 2, `Punkte ${g.result.points}`);
  assert(!E.play(g, 'b', 'b1').ok, 'nach Rundenende keine Züge');
}

function testReshuffle() {
  const g = mk({ a: [C('x', 'blue', 'num', 9)], b: [C('b1', 'red', 'num', 1)] }, C('t', 'red', 'num', 5), { draw: [] });
  g.discard = [C('o1', 'blue', 'num', 1), C('o2', 'blue', 'num', 2), C('o3', 'red', 'num', 2), C('t', 'red', 'num', 5)];
  const r = E.drawUntilPlayable(g, 'a');
  assert(r.ok && g.hands.a.length > 1, 'Ablagestapel wird neu gemischt');
  assert(E.top(g).id === 't', 'oberste Karte bleibt liegen');
}

testDeck(); testMatching(); testDrawStacking(); testActions(); testRoulette(); testSevenZero(); testDrawAndMercy(); testWinAndScore(); testReshuffle();
console.log('OK: engine.test.js - Kartenzusammensetzung, Stapeln, Aktionskarten, 7-0, Mercy, Wertung');
