// Kleine Hilfsfunktionen für die Tests unter tests/.
// Die Integrationstests starten den echten server.js als Kindprozess auf einem
// Test-Port und steuern das Spiel über einen echten socket.io-client.

const { spawn } = require('child_process');
const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion fehlgeschlagen: ${message}`);
}

function startServer(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(port) }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    const onData = (data) => {
      if (!started && data.toString().includes('läuft auf Port')) {
        started = true;
        proc.stdout.off('data', onData);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!started) reject(new Error(`Server (Port ${port}) beendete sich vorzeitig mit Code ${code}`));
    });
    setTimeout(() => { if (!started) reject(new Error('Timeout beim Serverstart')); }, 8000);
  });
}

function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) return resolve();
    proc.once('exit', () => resolve());
    proc.kill();
    setTimeout(resolve, 2000);
  });
}

function connectClient(url) {
  const { io } = require('socket.io-client');
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error('Timeout beim Verbinden mit dem Server')), 5000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function emitAsync(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout bei Event "${event}"`)), 5000);
    socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}

function waitForState(socket, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('gameState', handler);
      reject(new Error('Timeout beim Warten auf einen bestimmten Spielzustand'));
    }, timeoutMs);
    function handler(state) {
      if (predicate(state)) {
        clearTimeout(timer);
        socket.off('gameState', handler);
        resolve(state);
      }
    }
    socket.on('gameState', handler);
  });
}

// Simpler "Autopilot" für einen Test-Client: spielt die erste passende Karte,
// zieht sonst. Die Bots im Raum handeln serverseitig selbstständig.
function attachAutopilot(socket, getMyId) {
  let mine = null;
  let lastState = null;
  let busyKey = null;

  function maybeAct() {
    const state = lastState;
    const myId = getMyId();
    if (!state || !myId || !mine) return;
    if (state.phase !== 'playing' || state.currentTurnId !== myId) return;
    const key = `${state.roundNo}:${state.turnNo}:${mine.hand.length}:${mine.playable.join()}:${mine.canDraw}:${mine.canPass}:${mine.canPenalty}`;
    if (busyKey === key) return;
    busyKey = key;
    const colors = ['red', 'yellow', 'green', 'blue'];
    const other = state.players.find((p) => p.id !== myId && !p.eliminated);
    const target = other ? other.id : undefined;
    if (mine.canPenalty && !mine.playable.length) return void socket.emit('takePenalty');
    if (mine.playable.length) return void socket.emit('play', { cardId: mine.playable[0], color: colors[Math.floor(Math.random() * 4)], targetId: target, uno: true });
    if (mine.canDraw) return void socket.emit('drawCard');
    if (mine.canPass) return void socket.emit('pass');
  }

  socket.on('yourCards', (data) => { mine = data; maybeAct(); });
  socket.on('gameState', (state) => { lastState = state; maybeAct(); });
}

module.exports = { assert, startServer, stopServer, connectClient, emitAsync, waitForState, attachAutopilot };
