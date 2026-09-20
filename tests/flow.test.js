// Kompletter Ablauf über echte Sockets: Raum erstellen, Bots hinzufügen, spielen,
// Rundenende, Punktemodus, Wiederverbindung.
const { startServer, stopServer, connectClient, emitAsync, waitForState, attachAutopilot, assert } = require('./helpers');

const PORT = 3951;
const ENV = { BOT_DELAY_MIN_MS: '10', BOT_DELAY_MAX_MS: '30', ROUND_RESULT_DELAY_MS: '150', UNO_WINDOW_MS: '300', SKIP_MIN_WAIT_MS: '300', HOST_HANDOVER_MS: '300' };

async function main() {
  const proc = await startServer(PORT, ENV);
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);
    const created = await emitAsync(host, 'createRoom', { name: 'Host' });
    assert(created.ok && created.code.length === 4, 'createRoom');
    let myCards = null;
    host.on('yourCards', (d) => { myCards = d; });
    attachAutopilot(host, () => created.playerId);

    const dup = await emitAsync(await connectClient(url), 'joinRoom', { code: created.code, name: 'host' });
    assert(!dup.ok, 'doppelter Name wird abgelehnt');
    const none = await emitAsync(await connectClient(url), 'joinRoom', { code: 'ZZZZ', name: 'X' });
    assert(!none.ok, 'unbekannter Raum');

    host.emit('addBot'); host.emit('addBot');
    host.emit('setSettings', { target: 250, sevenZero: true, unoRule: true });
    const lobby = await waitForState(host, (s) => s.players.length === 3 && s.settings.target === 250);
    assert(lobby.phase === 'lobby', 'Lobby');
    host.emit('startGame');
    const first = await waitForState(host, (s) => s.phase === 'playing');
    assert(first.players.every((p) => p.handCount === 7), 'alle haben 7 Karten');
    assert(first.topCard && first.topCard.kind === 'num', 'Startkarte');
    await new Promise((r) => setTimeout(r, 100));
    assert(myCards && myCards.hand.length > 0 && myCards.hand[0].id, 'eigene Hand kommt privat an');

    // Fremde Karten werden nie im öffentlichen Zustand mitgeschickt
    assert(!JSON.stringify(first).includes('"hand"'), 'öffentlicher Zustand enthält keine Hände');

    // Runde bis zum Ende, danach bis das Punkteziel erreicht ist
    const end = await waitForState(host, (s) => s.phase === 'gameover', 120000);
    assert(end.winnerId && end.placements.length === 3, 'Spielende mit Platzierung');
    assert(end.placements[0].score >= 250, 'Sieger hat das Punkteziel erreicht');
    assert(end.roundNo >= 1, 'Runden gezählt');

    // Zurück zur Lobby
    host.emit('resetGame');
    const back = await waitForState(host, (s) => s.phase === 'lobby');
    assert(back.players.length === 3, 'Spieler bleiben in der Lobby');
    console.log(`OK: flow.test.js - Partie über Sockets bis zum Punkteziel (${end.roundNo} Runden), Reset`);

    // Wiederverbindung
    const g = await connectClient(url);
    const j = await emitAsync(g, 'joinRoom', { code: created.code, name: 'Gast' });
    assert(j.ok, 'Gast tritt bei');
    g.disconnect();
    const g2 = await connectClient(url);
    const rj = await emitAsync(g2, 'joinRoom', { code: created.code, name: 'Gast', token: j.token });
    assert(rj.ok && rj.rejoined && rj.playerId === j.playerId, 'Wiederverbindung mit Token');
    console.log('OK: flow.test.js - Wiederverbindung');
  } finally { await stopServer(proc); }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FEHLER in flow.test.js:', e); process.exit(1); });
