// Bot-KI für Uno No Mercy. Rein heuristisch, arbeitet auf dem echten Spielzustand
// (Bots "sehen" nur ihre eigene Hand und die Handgrößen der anderen).

'use strict';

const E = require('./engine');

function bestColor(hand, exceptId) {
  const cnt = { red: 0, yellow: 0, green: 0, blue: 0 };
  hand.forEach((c) => { if (c.color && c.id !== exceptId) cnt[c.color]++; });
  let best = E.COLORS[0]; let bestN = -1;
  E.COLORS.forEach((col) => { if (cnt[col] > bestN || (cnt[col] === bestN && Math.random() < 0.5)) { best = col; bestN = cnt[col]; } });
  return best;
}

function scoreCard(game, id, card, hand) {
  const others = E.alive(game).filter((x) => x !== id);
  const next = E.stepFrom(game, id, 1);
  const nextSize = game.hands[next].length;
  const mine = hand.length;
  let s = Math.random() * 1.5;
  const sameColor = hand.filter((c) => c.color === card.color && c.id !== card.id).length;

  if (E.isWild(card)) {
    s -= 4;                        // Joker möglichst aufheben
    if (mine <= 3) s += 4;
    if (nextSize <= 2) s += 5;
  } else {
    s += 1 + sameColor * 0.4;
  }
  if (E.isDraw(card)) {
    s += nextSize <= 3 ? 6 : 1.5;
    if (game.pending > 0) s -= E.DRAW_VALUE[card.kind] * 0.1; // beim Kontern die kleinste passende nehmen
  }
  if (card.kind === 'skip' || card.kind === 'skipall') s += nextSize <= 2 ? 5 : 1;
  if (card.kind === 'reverse') s += nextSize <= 2 ? 4 : 0.5;
  if (card.kind === 'discard') s += 2 + sameColor * 2.2;
  if (card.kind === 'roulette') s += 2;
  if (card.kind === 'num' && game.rules.sevenZero) {
    const minOther = Math.min(...others.map((x) => game.hands[x].length));
    if (card.value === 7) s += mine - minOther >= 3 ? 6 : -3;
    if (card.value === 0) s += mine > minOther + 2 ? 1 : (mine <= 3 ? -4 : 0);
  }
  if (card.kind === 'num') s += card.value * 0.05; // hohe Zahlen zuerst loswerden
  return s;
}

// Liefert { type: 'play', cardId, color, targetId } | { type: 'draw' } | { type: 'penalty' } | { type: 'pass' }
function decide(game, id) {
  const hand = game.hands[id];
  const plays = hand.filter((c) => E.canPlayCard(game, c));

  if (game.pending > 0) {
    if (!plays.length) return { type: 'penalty' };
    // Bei kleinen Stapeln und viel Platz bis zur Mercy-Grenze lieber nicht kontern, wenn es nur ein Joker wäre.
    const limit = game.rules.mercy || 25;
    if (game.pending <= 4 && hand.length + game.pending < limit - 8 && plays.every(E.isWild) && Math.random() < 0.5) {
      return { type: 'penalty' };
    }
  } else if (!plays.length) {
    return game.drawn ? { type: 'pass' } : { type: 'draw' };
  }

  let best = null; let bestScore = -1e9;
  plays.forEach((c) => {
    const sc = scoreCard(game, id, c, hand);
    if (sc > bestScore) { best = c; bestScore = sc; }
  });
  const out = { type: 'play', cardId: best.id };
  const rest = hand.filter((c) => c.id !== best.id);
  if (E.isWild(best)) out.color = bestColor(rest);
  if (best.kind === 'num' && best.value === 7 && game.rules.sevenZero) {
    const cands = E.alive(game).filter((x) => x !== id);
    if (cands.length) {
      cands.sort((a, b) => game.hands[a].length - game.hands[b].length);
      out.targetId = cands[0];
    }
  }
  return out;
}

module.exports = { decide, bestColor };
