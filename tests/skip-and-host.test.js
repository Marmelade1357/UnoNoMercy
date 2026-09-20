// Überspringen durch den Host und Host-Übergabe. Eine verbundene, untätige Person
// wird NIE automatisch bewegt - erst nach der Wartezeit darf der Host überspringen.
const { startServer, stopServer, connectClient, emitAsync, waitForState, assert } = require('./helpers');

const PORT = 3961;
const SKIP_MS = 500;
const ENV = { SKIP_MIN_WAIT_MS: String(SKIP_MS), HOST_HANDOVER_MS: '400', BOT_DELAY_MIN_MS: '20', BOT_DELAY_MAX_MS: '40', ROUND_RESULT_DELAY_MS: '50' };

async function until(sock, pred, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (sock._last && pred(sock._last)) return sock._last;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Timeout beim Warten auf einen bestimmten Spielzustand');
}

async function setup(url) {
  const host = await connectClient(url);
  host.on('gameState', (s) => { host._last = s; });
  const created = await emitAsync(host, 'createRoom', { name: 'Host' });
  const guest = await connectClient(url);
  guest.on('gameState', (s) => { guest._last = s; });
  const joined = await emitAsync(guest, 'joinRoom', { code: created.code, name: 'Gast' });
  assert(created.ok && joined.ok, 'Setup');
  host.emit('addBot');
  await waitForState(host, (s) => s.players.length >= 3);
  host.emit('startGame');
  return { host, guest, hostId: created.playerId, guestId: joined.playerId };
}

async function testSkip() {
  const proc = await startServer(PORT, ENV);
  try {
    const { host, guest, hostId } = await setup(`http://localhost:${PORT}`);
    await until(host, (s) => s.waiting && s.waiting.ids.length === 1, 30000);
    const st = host._last;
    const waitedId = st.waiting.ids[0];
    const skipper = waitedId === hostId ? guest : host;
    skipper.emit('skipTurn'); // zu früh
    await new Promise((r) => setTimeout(r, 200));
    const still = await until(host, (s) => !!s.waiting, 2000);
    assert(still.waiting.ids[0] === waitedId && still.turnNo === st.turnNo, 'Zu frühes Überspringen darf nichts bewirken');
    await new Promise((r) => setTimeout(r, SKIP_MS));
    // Nur der Host darf überspringen (oder jemand, wenn der Host selbst wartet)
    if (waitedId !== hostId) {
      host.emit('skipTurn');
      const after = await until(host, (s) => s.turnNo !== st.turnNo, 8000);
      assert(after.turnNo !== st.turnNo, 'Überspringen nach der Wartezeit hätte den Zug weitergeben müssen');
    } else {
      guest.emit('skipTurn');
      const after = await until(host, (s) => s.turnNo !== st.turnNo, 8000);
      assert(after.turnNo !== st.turnNo, 'Gast darf überspringen, wenn der Host trödelt');
    }
    console.log('OK: skip-and-host.test.js - Überspringen');
  } finally { await stopServer(proc); }
}

async function testHandover() {
  const proc = await startServer(PORT + 1, ENV);
  try {
    const { host, guest, hostId, guestId } = await setup(`http://localhost:${PORT + 1}`);
    await until(guest, (s) => s.phase === 'playing', 5000);
    host.disconnect();
    const st = await until(guest, (s) => s.hostId === guestId, 5000);
    assert(st.hostId === guestId && st.hostId !== hostId, 'Host-Rolle sollte an den Gast übergehen');
    console.log('OK: skip-and-host.test.js - Host-Übergabe');
  } finally { await stopServer(proc); }
}

(async () => { await testSkip(); await testHandover(); process.exit(0); })().catch((e) => { console.error('FEHLER in skip-and-host.test.js:', e); process.exit(1); });
