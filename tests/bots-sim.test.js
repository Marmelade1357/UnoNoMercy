// Simuliert viele komplette Partien nur mit Bots direkt auf der Engine und prüft
// Invarianten: 168 Karten immer vorhanden, keine doppelten Karten, Züge enden,
// jede Runde hat einen Sieger.
const E = require('../src/engine');
const bots = require('../src/bots');
const { assert } = require('./helpers');

function total(g) {
  const all = [].concat(g.draw, g.discard, ...Object.values(g.hands));
  return all;
}

function playOne(n, rules) {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const g = E.createGame(ids, { rules });
  let steps = 0;
  const stats = { mercy: 0, pending10: 0 };
  while (g.phase === 'play') {
    if (++steps > 4000) throw new Error(`Partie mit ${n} Spielern endet nicht`);
    const id = g.turn;
    assert(!g.out.includes(id), 'ausgeschiedene Person am Zug');
    const a = bots.decide(g, id);
    let res;
    if (a.type === 'play') res = E.play(g, id, a.cardId, { color: a.color, targetId: a.targetId });
    else if (a.type === 'draw') res = E.drawUntilPlayable(g, id);
    else if (a.type === 'penalty') res = E.takePenalty(g, id);
    else res = E.pass(g, id);
    assert(res.ok, `Bot-Aktion abgelehnt: ${JSON.stringify(a)} -> ${res.error}`);
    res.events.forEach((e) => { if (e.t === 'mercy') stats.mercy++; });
    const all = total(g);
    assert(all.length === 168, `Kartenzahl ${all.length} statt 168 (Schritt ${steps}, Aktion ${a.type})`);
    assert(new Set(all.map((c) => c.id)).size === 168, 'doppelte Karten');
    if (g.phase === 'play') {
      assert(alive(g).includes(g.turn), 'Zug bei ausgeschiedener Person');
      Object.values(g.hands).forEach((h) => assert(h.length < 25, 'Hand >= 25 ohne Ausscheiden'));
    }
  }
  assert(g.winnerId && g.result, 'Runde ohne Sieger');
  return { steps, stats, g };
}
function alive(g) { return E.alive(g); }

let games = 0; let mercy = 0; let over = 0; let totalSteps = 0;
for (let n = 2; n <= 10; n++) {
  for (let k = 0; k < 8; k++) {
    const r = playOne(n, { sevenZero: k % 4 !== 0 });
    games++; mercy += r.stats.mercy; totalSteps += r.steps;
    if (r.g.result.reason === 'last') over++;
  }
}
console.log(`OK: bots-sim.test.js - ${games} Bot-Partien (2-10 Spieler), Ø ${Math.round(totalSteps / games)} Züge, ${mercy} Mercy-Ausscheidungen, ${over} Siege als Letzte:r`);
