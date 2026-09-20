(function () {
  // Pfad-Präfix ermitteln (z. B. "" bei direktem Zugriff, "/uno" hinter dem Spielehub).
  const MOUNT_PREFIX = window.location.pathname.replace(/\/[^/]*$/, '');
  const socket = io({ path: MOUNT_PREFIX + '/socket.io/' });

  if (MOUNT_PREFIX) {
    const backHub = document.getElementById('btn-back-hub-home');
    if (backHub) { backHub.href = '/'; backHub.classList.remove('hidden'); }
  }

  const SESSION_KEY = 'uno_session';
  const SOUND_KEY = 'uno_sound';
  const VIEW_KEY = 'uno_view';
  const SORT_KEY = 'uno_sort';
  const COLOR_HEX = { red: '#e63946', yellow: '#f6b91a', green: '#2a9d55', blue: '#2f6fdd' };
  const COLOR_NAME = { red: 'Rot', yellow: 'Gelb', green: 'Grün', blue: 'Blau' };
  const COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, none: 4 };
  const KIND_ORDER = { num: 0, skip: 1, reverse: 2, draw2: 3, draw4: 4, discard: 5, skipall: 6, wildrev4: 7, wild6: 8, wild10: 9, roulette: 10 };
  const WILD = ['wildrev4', 'wild6', 'wild10', 'roulette'];

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* egal */ } }

  let session = null;
  let latestState = null;
  let mine = { hand: [], playable: [], canDraw: false, canPass: false, canPenalty: false };
  let unoArmed = false;
  let lastSeq = null;
  let prevHandIds = new Set();
  let soundOn = safeGet(SOUND_KEY) !== 'off';
  let sortOn = safeGet(SORT_KEY) !== 'off';
  let bubbles = {};          // playerId -> { text, until }
  let dismissedResult = null;
  let notifiedTurnKey = null;

  // ---------------------------------------------------------------------
  // Sound (synthetisierte Töne, keine Dateien)
  // ---------------------------------------------------------------------
  let audioCtx = null;
  function playTone(freq, duration, delay, volume, type) {
    if (!soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime + (delay || 0);
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.type = type || 'sine';
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(volume || 0.15, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch (e) { /* kein Audio - egal */ }
  }
  const sfx = {
    play() { playTone(480, 0.07, 0, 0.12, 'triangle'); },
    draw() { playTone(340, 0.06, 0, 0.1); playTone(300, 0.06, 0.07, 0.1); },
    turn() { playTone(660, 0.1, 0, 0.14); playTone(880, 0.12, 0.1, 0.14); },
    bad() { playTone(220, 0.25, 0, 0.16, 'sawtooth'); },
    uno() { [784, 988, 1175].forEach((f, i) => playTone(f, 0.12, i * 0.07, 0.15, 'square')); },
    win() { [523, 659, 784, 1046].forEach((f, i) => playTone(f, 0.2, i * 0.11, 0.16)); },
  };
  function vibrate(p) { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) { /* egal */ } } }

  // ---------------------------------------------------------------------
  // Helfer
  // ---------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function show(e) { e.classList.remove('hidden'); }
  function hide(e) { e.classList.add('hidden'); }
  function myId() { return session ? session.playerId : null; }
  function el(tag, opts, children) {
    const e = document.createElement(tag);
    if (opts) {
      Object.entries(opts).forEach(([k, v]) => {
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      });
    }
    (children || []).forEach((c) => e.appendChild(c));
    return e;
  }
  function pname(state, id) { const p = state.players.find((x) => x.id === id); return p ? p.name : '?'; }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => hide(s));
    show($(id));
    if (id === 'screen-home') releaseWakeLock(); else requestWakeLock();
    if (id !== 'screen-game') { hide($('hand-bar')); if (b3) b3.setVisible(false); }
  }

  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (e) { /* egal */ }
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
  document.addEventListener('visibilitychange', () => {
    const home = $('screen-home');
    if (document.visibilityState === 'visible' && home && home.classList.contains('hidden')) requestWakeLock();
  });

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(t), 3200);
  }

  function saveSession() { safeSet(SESSION_KEY, JSON.stringify(session)); }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* egal */ } session = null; }
  function loadSession() { try { const r = safeGet(SESSION_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; } }

  // ---------------------------------------------------------------------
  // Karten (DOM)
  // ---------------------------------------------------------------------
  function faceOf(card) {
    switch (card.kind) {
      case 'num': return { sym: String(card.value), corner: String(card.value) };
      case 'skip': return { sym: '⊘', corner: '⊘' };
      case 'reverse': return { sym: '⇄', corner: '⇄' };
      case 'draw2': return { sym: '+2', corner: '+2' };
      case 'draw4': return { sym: '+4', corner: '+4' };
      case 'discard': return { sym: '✖', corner: '✖', lab: 'ALLE ABLEGEN' };
      case 'skipall': return { sym: '⊘⊘', corner: '⊘⊘', lab: 'ALLE AUSSETZEN', small: true };
      case 'wildrev4': return { sym: '⇄+4', corner: '+4', small: true };
      case 'wild6': return { sym: '+6', corner: '+6' };
      case 'wild10': return { sym: '+10', corner: '+10' };
      case 'roulette': return { sym: '🎰', corner: '?', lab: 'ROULETTE' };
      default: return { sym: '?', corner: '?' };
    }
  }
  function labelOf(card) {
    const names = { skip: 'Aussetzen', reverse: 'Richtungswechsel', draw2: '+2', draw4: '+4', discard: 'Alle ablegen', skipall: 'Alle aussetzen', wildrev4: 'Wilder Richtungswechsel +4', wild6: 'Wild +6', wild10: 'Wild +10', roulette: 'Farbroulette' };
    if (card.kind === 'num') return `${COLOR_NAME[card.color]} ${card.value}`;
    return card.color ? `${COLOR_NAME[card.color]} ${names[card.kind]}` : names[card.kind];
  }
  function shortLabel(card) {
    const names = { skip: 'Aussetzen', reverse: '⇄ Richtung', draw2: '+2', draw4: '+4', discard: 'Alle ablegen', skipall: 'Alle aussetzen', wildrev4: '⇄ +4', wild6: '+6', wild10: '+10', roulette: 'Roulette' };
    return card.kind === 'num' ? String(card.value) : names[card.kind];
  }
  function cardEl(card, extra) {
    if (!card) return el('div', { class: 'ucard back' }, [el('span', { class: 'back-logo', html: 'NO<br>MERCY' })]);
    const f = faceOf(card);
    const isWild = WILD.includes(card.kind);
    const symCls = 'sym' + (f.small ? ' sm' : '');
    const kids = [
      el('span', { class: 'corner tl', text: f.corner }),
      el('span', { class: 'oval' }, [el('span', { class: symCls, text: f.sym })]),
      el('span', { class: 'corner br', text: f.corner }),
    ];
    if (f.lab) kids.push(el('span', { class: 'lab', text: f.lab }));
    return el('div', { class: `ucard ${isWild ? 'wild' : card.color}${extra ? ' ' + extra : ''}`, title: labelOf(card), 'data-id': card.id }, kids);
  }

  // ---------------------------------------------------------------------
  // Start / Lobby-Aktionen
  // ---------------------------------------------------------------------
  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('tab-create').classList.toggle('hidden', b.dataset.tab !== 'create');
    $('tab-join').classList.toggle('hidden', b.dataset.tab !== 'join');
  }));

  const savedName = safeGet('uno_name') || '';
  $('create-name').value = savedName; $('join-name').value = savedName;
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode) {
    $('join-code').value = urlCode.toUpperCase();
    document.querySelector('.tab-btn[data-tab="join"]').click();
  }

  function enterRoom(res, name) {
    session = { code: res.code, playerId: res.playerId, token: res.token, name };
    saveSession(); safeSet('uno_name', name);
    lastSeq = null;
  }

  $('btn-create').addEventListener('click', () => {
    const name = $('create-name').value.trim();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    socket.emit('createRoom', { name }, (res) => {
      if (!res.ok) return toast(res.error);
      enterRoom(res, name);
    });
  });
  $('btn-join').addEventListener('click', () => {
    const name = $('join-name').value.trim();
    const code = $('join-code').value.trim().toUpperCase();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    if (code.length !== 4) return toast('Der Raum-Code hat 4 Zeichen.');
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res.ok) return toast(res.error);
      enterRoom(res, name);
    });
  });

  function leave() {
    socket.emit('leaveRoom');
    clearSession(); latestState = null;
    showScreen('screen-home');
  }
  $('btn-leave-lobby').addEventListener('click', leave);
  $('btn-leave-game').addEventListener('click', () => { if (confirm('Wirklich verlassen?')) leave(); });
  socket.on('kicked', () => { clearSession(); latestState = null; showScreen('screen-home'); toast('Du wurdest aus dem Raum entfernt.'); });

  $('btn-share-link').addEventListener('click', async () => {
    if (!latestState) return;
    const url = `${location.origin}${location.pathname}?code=${latestState.code}`;
    try { await navigator.clipboard.writeText(url); toast('Einladungslink kopiert!'); } catch (e) { toast(url); }
  });
  $('btn-add-bot').addEventListener('click', () => socket.emit('addBot'));
  $('btn-fill-bots').addEventListener('click', () => socket.emit('fillBots'));
  $('btn-start').addEventListener('click', () => socket.emit('startGame'));
  function sendSettings() {
    socket.emit('setSettings', { sevenZero: $('set-sevenzero').checked, unoRule: $('set-uno').checked, target: Number($('set-target').value) });
  }
  ['set-sevenzero', 'set-uno', 'set-target'].forEach((id) => $(id).addEventListener('change', sendSettings));

  ['btn-show-rules', 'btn-show-rules-lobby'].forEach((id) => $(id).addEventListener('click', () => show($('rules-modal'))));
  $('btn-close-rules-modal').addEventListener('click', () => hide($('rules-modal')));
  $('btn-show-log').addEventListener('click', () => { renderLog(); show($('log-modal')); });
  $('btn-close-log-modal').addEventListener('click', () => hide($('log-modal')));
  function renderLog() {
    const list = $('log-list'); list.innerHTML = '';
    if (!latestState) return;
    latestState.logs.slice().reverse().forEach((l) => list.appendChild(el('li', { text: l.text })));
  }
  const soundBtn = $('btn-toggle-sound');
  soundBtn.textContent = soundOn ? '🔊' : '🔇';
  soundBtn.addEventListener('click', () => { soundOn = !soundOn; safeSet(SOUND_KEY, soundOn ? 'on' : 'off'); soundBtn.textContent = soundOn ? '🔊' : '🔇'; });
  $('toggle-sort').checked = sortOn;
  $('toggle-sort').addEventListener('change', (e) => { sortOn = e.target.checked; safeSet(SORT_KEY, sortOn ? 'on' : 'off'); renderHand(); });

  // ---------------------------------------------------------------------
  // Verbindung / Zustand
  // ---------------------------------------------------------------------
  socket.on('connect', () => {
    const saved = loadSession();
    if (saved && saved.code && saved.token) {
      session = saved;
      socket.emit('joinRoom', { code: saved.code, name: saved.name, token: saved.token }, (res) => {
        if (!res.ok) { clearSession(); showScreen('screen-home'); }
        else { session.playerId = res.playerId; session.token = res.token; saveSession(); }
      });
    }
  });

  socket.on('yourCards', (data) => {
    mine = data || mine;
    if (latestState) renderGameParts(latestState);
  });
  socket.on('actionError', (d) => toast(d.error));

  socket.on('gameState', (state) => {
    latestState = state;
    handleEvents(state);
    render(state);
  });

  // Neue Ereignisse: Töne, Sprechblasen, 3D-Animationen
  function bubbleText(ev) {
    switch (ev.t) {
      case 'play': return shortLabel(ev.card);
      case 'penalty': case 'draw': case 'roulette': return `+${ev.n}`;
      case 'swap': return 'Tausch!';
      case 'rotate': return '0: Weitergeben';
      case 'uno': return 'UNO!';
      case 'unoCaught': return 'UNO vergessen!';
      case 'mercy': return 'Mercy!';
      case 'pass': return 'Passt';
      default: return null;
    }
  }
  function handleEvents(state) {
    if (lastSeq === null) { lastSeq = state.eventSeq; return; }
    const fresh = (state.events || []).filter((e) => e.seq > lastSeq);
    lastSeq = state.eventSeq;
    fresh.forEach((ev) => {
      const t = bubbleText(ev);
      if (t) {
        const who = ev.t === 'roulette' || ev.t === 'penalty' || ev.t === 'draw' || ev.t === 'mercy' ? ev.id : ev.id;
        if (who) { bubbles[who] = { text: t, until: Date.now() + 2200 }; setTimeout(() => { if (latestState) renderSeats(latestState); }, 2300); }
      }
      if (ev.t === 'play') sfx.play();
      else if (ev.t === 'draw' || ev.t === 'penalty' || ev.t === 'roulette') sfx.draw();
      else if (ev.t === 'uno') sfx.uno();
      else if (ev.t === 'mercy' || ev.t === 'unoCaught') sfx.bad();
      else if (ev.t === 'over') sfx.win();
    });
    if (b3 && fresh.length) b3.events(fresh);
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  function render(state) {
    if (state.phase === 'lobby') {
      hide($('result-modal')); dismissedResult = null;
      showScreen('screen-lobby'); renderLobby(state); return;
    }
    if ($('screen-game').classList.contains('hidden')) { showScreen('screen-game'); }
    renderGameParts(state);
    renderResult(state);
    if (b3) sync3d();
  }

  function renderGameParts(state) {
    if (state.phase === 'lobby') return;
    $('game-code').textContent = state.code;
    const tgt = state.settings.target;
    $('round-badge').textContent = `Runde ${state.roundNo}${tgt ? ` · bis ${tgt} Punkte` : ''}`;
    renderTable(state);
    renderSeats(state);
    renderScores(state);
    renderHand();
    renderActions(state);
    notifyTurn(state);
    if (b3) sync3d();
  }

  function notifyTurn(state) {
    if (state.phase !== 'playing' || state.currentTurnId !== myId()) return;
    const key = `${state.roundNo}:${state.turnNo}`;
    if (key === notifiedTurnKey) return;
    notifiedTurnKey = key;
    sfx.turn(); vibrate(120);
  }

  function renderLobby(state) {
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = state.players.length;
    const isHost = state.hostId === myId();
    const list = $('lobby-players'); list.innerHTML = '';
    state.players.forEach((p) => {
      const tags = [];
      if (p.isHost) tags.push(el('span', { class: 'tag host', text: 'Host' }));
      if (p.isBot) tags.push(el('span', { class: 'tag', text: '🤖 Bot' }));
      if (!p.connected && !p.isBot) tags.push(el('span', { class: 'tag', text: 'getrennt' }));
      const li = el('li', { class: !p.connected && !p.isBot ? 'disconnected' : '' }, [
        el('span', { class: 'player-name' }, [el('span', { text: p.name }), ...tags]),
      ]);
      if (isHost && p.id !== state.hostId) li.appendChild(removeButton(p));
      list.appendChild(li);
    });
    if (isHost) {
      show($('lobby-bot-controls'));
      $('btn-fill-bots').classList.toggle('hidden', state.players.length >= state.minPlayers);
    } else hide($('lobby-bot-controls'));

    const st = state.settings;
    if (isHost) {
      show($('lobby-settings')); hide($('lobby-settings-display'));
      $('set-sevenzero').checked = st.sevenZero;
      $('set-uno').checked = st.unoRule;
      if (document.activeElement !== $('set-target')) $('set-target').value = String(st.target);
    } else {
      hide($('lobby-settings')); show($('lobby-settings-display'));
      $('lobby-settings-display').textContent = `7-0-Regel: ${st.sevenZero ? 'an' : 'aus'} · UNO-Pflicht: ${st.unoRule ? 'an' : 'aus'} · ${st.target ? `bis ${st.target} Punkte` : 'eine Runde'}`;
    }
    const startBtn = $('btn-start'); const status = $('lobby-status');
    if (isHost) {
      const ok = state.players.length >= state.minPlayers && state.players.length <= state.maxPlayers;
      startBtn.classList.toggle('hidden', !ok);
      status.textContent = ok ? '' : `Mindestens ${state.minPlayers} Spieler nötig (max. ${state.maxPlayers}).`;
    } else { hide(startBtn); status.textContent = 'Warte, bis der Host das Spiel startet …'; }
  }

  function removeButton(p) {
    const btn = el('button', { class: 'remove-bot-btn', title: p.isBot ? 'Bot entfernen' : 'Spieler entfernen', text: '✕' });
    let armed = false; let timer = null;
    btn.addEventListener('click', () => {
      if (!armed) {
        armed = true; btn.classList.add('confirm'); btn.textContent = 'Entfernen?';
        timer = setTimeout(() => { armed = false; btn.classList.remove('confirm'); btn.textContent = '✕'; }, 2500);
        return;
      }
      clearTimeout(timer);
      if (p.isBot) socket.emit('removeBot', { botId: p.id }); else socket.emit('kickPlayer', { playerId: p.id });
    });
    return btn;
  }

  // ----- 2D-Tisch -----
  function renderTable(state) {
    const top = state.topCard;
    const dp = $('discard-pile');
    const topId = top ? top.id : null;
    if (dp.dataset.topId !== String(topId)) {
      dp.innerHTML = '';
      if (top) dp.appendChild(cardEl(top, dp.dataset.topId ? 'flip-in' : ''));
      dp.dataset.topId = String(topId);
    }
    const hex = COLOR_HEX[state.color] || '#888';
    dp.style.setProperty('--ring', hex);
    $('color-dot').style.setProperty('--dot', hex);
    $('color-dot').title = COLOR_NAME[state.color] || '';
    $('dir-arrow').textContent = state.direction === 1 ? '↻' : '↺';
    $('draw-count').textContent = state.drawCount;
    const canDraw = mine.canDraw && state.currentTurnId === myId();
    $('draw-pile').classList.toggle('can-draw', canDraw);
    const pb = $('pending-badge');
    if (state.pending > 0 && state.phase === 'playing') { pb.textContent = `+${state.pending}`; show(pb); } else hide(pb);

    let note = '';
    if (state.phase === 'playing') {
      const cur = pname(state, state.currentTurnId);
      note = state.currentTurnId === myId() ? 'Du bist dran!' : `${cur} ist dran …`;
    }
    $('table-note').textContent = note;
  }
  $('draw-pile').addEventListener('click', () => {
    if (mine.canDraw) socket.emit('drawCard', null, cbErr);
    else if (latestState && latestState.currentTurnId === myId() && latestState.pending > 0) toast('Erst die Strafkarten nehmen oder kontern.');
  });
  function cbErr(res) { if (res && !res.ok && res.error) toast(res.error); }

  function renderSeats(state) {
    const wrap = $('seats'); wrap.innerHTML = '';
    const players = state.players; const n = players.length;
    if (!n) return;
    const meIdx = Math.max(0, players.findIndex((p) => p.id === myId()));
    const order = [];
    for (let i = 0; i < n; i++) order.push(players[(meIdx + i) % n]);
    const RX = window.innerWidth < 720 ? 37 : 46; const RY = window.innerWidth < 720 ? 40 : 42;
    const now = Date.now();
    const roundWinner = state.roundResult ? state.roundResult.winnerId : null;
    order.forEach((p, i) => {
      const angle = (90 + (i * 360) / n) * (Math.PI / 180);
      const left = 50 + RX * Math.cos(angle);
      const top = 50 + RY * Math.sin(angle);
      const tags = [];
      if (p.isHost) tags.push(el('span', { class: 'tag host', text: 'H' }));
      if (p.isBot) tags.push(el('span', { class: 'tag', text: '🤖' }));
      if (p.handCount === 1 && !p.eliminated && state.phase === 'playing') tags.push(el('span', { class: 'tag uno', text: 'UNO' }));
      if (p.eliminated) tags.push(el('span', { class: 'tag out', text: 'raus' }));
      if (roundWinner === p.id) tags.push(el('span', { class: 'tag winner', text: '🏆' }));
      const fan = el('div', { class: 'seat-fan' });
      const shown = Math.min(p.handCount, 8);
      for (let k = 0; k < shown; k++) fan.appendChild(el('div', { class: 'mini' }));
      if (p.handCount > shown) fan.appendChild(el('span', { class: 'more', text: `+${p.handCount - shown}` }));
      const cls = ['seat'];
      if (p.id === myId()) cls.push('me');
      if (!p.connected && !p.isBot) cls.push('disconnected');
      if (p.eliminated) cls.push('eliminated');
      if (state.currentTurnId === p.id) cls.push('active-turn');
      if (roundWinner === p.id) cls.push('winner');
      const seat = el('div', { class: cls.join(' '), style: `left:${left}%;top:${top}%` }, [
        fan,
        el('div', { class: 'seat-name-row' }, [el('span', { class: 'seat-name-text', text: p.name }), el('span', { class: 'seat-count', text: String(p.handCount) }), ...tags]),
      ]);
      if (state.settings.target) seat.appendChild(el('div', { class: 'seat-score', text: `${p.score} Pkt.` }));
      const b = bubbles[p.id];
      if (b && b.until > now) seat.appendChild(el('div', { class: 'seat-action', text: b.text }));
      wrap.appendChild(seat);
    });
  }

  // ----- Punkte-Rangliste (rechts, nur wenn bis zu einem Punktziel gespielt wird) -----
  function renderScores(state) {
    const panel = $('score-panel');
    const target = state.settings.target;
    if (!target) { hide(panel); return; }
    show(panel);
    const list = $('score-list'); list.innerHTML = '';
    const rows = state.players.slice().sort((a, b) => b.score - a.score);
    const best = rows.length ? rows[0].score : 0;
    rows.forEach((p, i) => {
      const cls = ['score-row'];
      if (i === 0 && best > 0) cls.push('first');
      if (p.id === myId()) cls.push('me');
      if (state.currentTurnId === p.id) cls.push('turn');
      if (p.eliminated) cls.push('out');
      const pct = Math.min(100, Math.round((p.score / target) * 100));
      list.appendChild(el('li', { class: cls.join(' ') }, [
        el('span', { class: 'rank', text: String(i + 1) }),
        el('span', { class: 'nm', text: p.name, title: p.name }),
        el('span', { class: 'pts', text: String(p.score) }),
        el('span', { class: 'bar' }, [el('i', { style: `width:${pct}%` })]),
      ]));
    });
    $('score-goal').textContent = `Ziel: ${target} Punkte · Runde ${state.roundNo}`;
  }

  // ----- Hand (unten) -----
  function sortedHand(hand) {
    if (!sortOn) return hand.slice();
    return hand.slice().sort((a, b) => {
      const ca = COLOR_ORDER[a.color || 'none']; const cb = COLOR_ORDER[b.color || 'none'];
      if (ca !== cb) return ca - cb;
      if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      return (a.value || 0) - (b.value || 0);
    });
  }
  function renderHand() {
    const state = latestState;
    const bar = $('hand-bar');
    if (!state || state.phase === 'lobby') { hide(bar); return; }
    show(bar);
    const myTurn = state.phase === 'playing' && state.currentTurnId === myId();
    bar.classList.toggle('my-turn', myTurn);
    const me = state.players.find((p) => p.id === myId());
    const list = $('hand-list'); list.innerHTML = '';
    const ids = new Set(mine.hand.map((c) => c.id));
    if (me && me.eliminated) {
      list.appendChild(el('li', { class: 'empty-hand', text: 'Ausgeschieden (Mercy) – du schaust zu.' }));
    } else if (!mine.hand.length) {
      list.appendChild(el('li', { class: 'empty-hand', text: 'Keine Karten' }));
    }
    const playable = new Set(mine.playable);
    sortedHand(mine.hand).forEach((c) => {
      const cls = [];
      if (myTurn) cls.push(playable.has(c.id) ? 'playable' : 'dim');
      if (!prevHandIds.has(c.id) && prevHandIds.size) cls.push('deal-in');
      const ce = cardEl(c, cls.join(' '));
      ce.addEventListener('click', () => onCardClick(c));
      list.appendChild(el('li', { style: 'display:contents' }, [ce]));
    });
    prevHandIds = ids;
    let label = `Deine Karten (${mine.hand.length})`;
    if (state.phase === 'playing') label = myTurn ? `Du bist dran – deine Karten (${mine.hand.length})` : `Deine Karten (${mine.hand.length}) · ${pname(state, state.currentTurnId)} ist dran`;
    $('turn-label').textContent = label;
  }

  function onCardClick(card) {
    const state = latestState;
    if (!state || state.phase !== 'playing') return;
    if (state.currentTurnId !== myId()) return toast('Du bist nicht dran.');
    if (!mine.playable.includes(card.id)) {
      return toast(state.pending > 0 ? `Kontern geht nur mit einer +${state.pendingMin} oder höheren Ziehkarte – sonst Strafkarten nehmen.` : 'Diese Karte passt nicht.');
    }
    const isWild = WILD.includes(card.kind);
    const seven = card.kind === 'num' && card.value === 7 && state.settings.sevenZero;
    if (isWild) return chooseColor((color) => sendPlay(card, { color }));
    if (seven) {
      const others = state.players.filter((p) => p.id !== myId() && !p.eliminated);
      if (others.length) return chooseTarget(others, (targetId) => sendPlay(card, { targetId }));
    }
    sendPlay(card, {});
  }
  function sendPlay(card, extra) {
    const wasArmed = unoArmed;
    socket.emit('play', Object.assign({ cardId: card.id, uno: wasArmed }, extra), (res) => {
      if (res && !res.ok) toast(res.error || 'Das geht gerade nicht.');
      else unoArmed = false;
    });
  }

  function chooseColor(cb) {
    show($('color-modal'));
    const done = (color) => { hide($('color-modal')); cleanup(); if (color) cb(color); };
    const btns = document.querySelectorAll('#color-modal .color-choice');
    const handlers = [];
    btns.forEach((b) => { const h = () => done(b.dataset.color); handlers.push([b, h]); b.addEventListener('click', h); });
    const cancel = () => done(null);
    $('btn-cancel-choice').addEventListener('click', cancel);
    function cleanup() { handlers.forEach(([b, h]) => b.removeEventListener('click', h)); $('btn-cancel-choice').removeEventListener('click', cancel); }
  }
  function chooseTarget(others, cb) {
    const box = $('target-list'); box.innerHTML = '';
    const close = () => { hide($('target-modal')); $('btn-cancel-target').removeEventListener('click', close); };
    others.forEach((p) => box.appendChild(el('button', {
      class: 'btn', onclick: () => { close(); cb(p.id); },
    }, [el('span', { text: p.name }), el('span', { text: `${p.handCount} Karten` })])));
    $('btn-cancel-target').addEventListener('click', close);
    show($('target-modal'));
  }

  // ----- Aktionsleiste -----
  function renderActions(state) {
    const box = $('action-buttons'); box.innerHTML = '';
    if (state.phase !== 'playing') return;
    const me = state.players.find((p) => p.id === myId());
    if (!me || me.eliminated) return;
    const myTurn = state.currentTurnId === myId();
    const uw = state.unoWindow;

    if (myTurn) {
      if (mine.canPenalty) box.appendChild(el('button', { class: 'btn penalty', text: `Strafe nehmen (+${state.pending})`, onclick: () => socket.emit('takePenalty', null, cbErr) }));
      if (mine.canDraw) box.appendChild(el('button', { class: 'btn secondary', text: 'Karte ziehen', onclick: () => socket.emit('drawCard', null, cbErr) }));
      if (mine.canPass) box.appendChild(el('button', { class: 'btn', text: 'Passen', onclick: () => socket.emit('pass', null, cbErr) }));
    }
    if (state.settings.unoRule && myTurn && mine.hand.length === 2 && !mine.canPenalty) {
      box.appendChild(el('button', { class: 'btn uno' + (unoArmed ? ' armed' : ''), text: unoArmed ? 'UNO! ✓' : 'UNO!', onclick: () => { unoArmed = !unoArmed; renderActions(latestState); } }));
    }
    if (uw && uw.id === myId()) {
      box.appendChild(el('button', { class: 'btn uno armed', text: 'UNO! rufen', onclick: () => socket.emit('callUno') }));
    } else if (uw) {
      box.appendChild(el('button', { class: 'btn catch', text: `🚨 ${pname(state, uw.id)} hat UNO vergessen!`, onclick: () => socket.emit('catchUno') }));
    }
    // Host darf nach Wartezeit überspringen
    const w = state.waiting;
    if (w && state.hostId === myId() && !w.ids.includes(myId())) {
      const b = el('button', { class: 'btn ghost small hidden', id: 'btn-skip', text: '⏭ Überspringen', onclick: () => socket.emit('skipTurn') });
      box.appendChild(b);
      skipWaitBase = { at: Date.now(), ms: w.elapsedMs };
      updateSkipBtn();
    }
    if (uw) scheduleUnoRefresh(uw.ms);
  }
  let skipWaitBase = null;
  function updateSkipBtn() {
    const b = $('btn-skip');
    if (!b || !skipWaitBase) return;
    const elapsed = skipWaitBase.ms + (Date.now() - skipWaitBase.at);
    b.classList.toggle('hidden', elapsed < 20000);
  }
  setInterval(updateSkipBtn, 1000);
  let unoRefreshTimer = null;
  function scheduleUnoRefresh(ms) {
    clearTimeout(unoRefreshTimer);
    unoRefreshTimer = setTimeout(() => { if (latestState && latestState.unoWindow) { latestState.unoWindow = null; renderActions(latestState); } }, Math.max(100, ms));
  }

  // ----- Rundenende / Spielende -----
  function renderResult(state) {
    const modal = $('result-modal'); const body = $('result-body');
    if ((state.phase !== 'roundend' && state.phase !== 'gameover') || !state.roundResult) { hide(modal); return; }
    const key = `${state.roundNo}:${state.phase}`;
    if (dismissedResult === key) { hide(modal); return; }
    const r = state.roundResult;
    const isHost = state.hostId === myId();
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'result-crown', text: state.phase === 'gameover' ? '🏆' : '🎉' }));
    const winName = pname(state, r.winnerId);
    body.appendChild(el('h2', { class: 'result-title', text: state.phase === 'gameover' ? `${winName} gewinnt die Partie!` : `${winName} gewinnt Runde ${state.roundNo}` }));
    body.appendChild(el('p', { class: 'result-note', text: `${r.reason === 'last' ? 'Als Letzte:r übrig geblieben' : 'Alle Karten losgeworden'} · +${r.points} Punkte` }));

    const table = el('table', { class: 'result-table' }, [
      el('tr', null, [el('th', { text: 'Spieler' }), el('th', { text: 'Restkarten' }), el('th', { class: 'num', text: 'Runde' }), el('th', { class: 'num', text: 'Gesamt' })]),
    ]);
    const rows = state.players.slice().sort((a, b) => (r.scores[b.id] || 0) - (r.scores[a.id] || 0));
    rows.forEach((p) => {
      const hand = el('div', { class: 'result-hand' });
      if (r.eliminated.includes(p.id)) hand.appendChild(el('span', { text: 'Mercy – ausgeschieden' }));
      else (r.hands[p.id] || []).forEach((c) => hand.appendChild(cardEl(c)));
      const gain = p.id === r.winnerId ? `+${r.points}` : '';
      table.appendChild(el('tr', { class: p.id === r.winnerId ? 'win' : '' }, [
        el('td', { text: p.name }), el('td', null, [hand]), el('td', { class: 'num', text: gain }), el('td', { class: 'num', text: String(r.scores[p.id] || 0) }),
      ]));
    });
    body.appendChild(table);

    const actions = el('div', { class: 'result-actions' });
    if (state.phase === 'roundend') {
      body.appendChild(el('p', { class: 'result-note', text: 'Die nächste Runde startet gleich automatisch.' }));
      if (isHost) actions.appendChild(el('button', { class: 'btn primary', text: 'Nächste Runde jetzt', onclick: () => socket.emit('nextRound') }));
      actions.appendChild(el('button', { class: 'btn ghost', text: 'Tisch ansehen', onclick: () => { dismissedResult = key; hide(modal); } }));
    } else {
      if (isHost) actions.appendChild(el('button', { class: 'btn primary', text: 'Neue Partie (zur Lobby)', onclick: () => socket.emit('resetGame') }));
      else body.appendChild(el('p', { class: 'result-note', text: 'Warte, bis der Host eine neue Partie startet …' }));
      actions.appendChild(el('button', { class: 'btn ghost', text: 'Verlassen', onclick: leave }));
    }
    body.appendChild(actions);
    show(modal);
  }

  // ---------------------------------------------------------------------
  // 3D-Tisch (optional, Three.js) - analog zu Monopoly
  // ---------------------------------------------------------------------
  let b3 = null; let b3Loading = false; let b3Failed = false; let mode3d = false;
  function webglOk() {
    try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); } catch (e) { return false; }
  }
  function want3d() {
    const saved = safeGet(VIEW_KEY);
    if (saved === '2d') return false;
    if (saved === '3d') return true;
    return Math.min(window.innerWidth, window.innerHeight) >= 600;
  }
  function applyMode() {
    $('table-wrap').classList.toggle('mode3d', mode3d);
    $('canvas-host').classList.toggle('hidden', !mode3d);
    $('view3d-tools').classList.toggle('hidden', !mode3d);
    $('screen-game').classList.toggle('mode3d-ui', mode3d);
    $('btn-view3d').innerHTML = mode3d ? '🗺️<span class="lbl"> 2D</span>' : '🧊<span class="lbl"> 3D</span>';
  }
  async function ensure3d() {
    if (b3 || b3Loading || b3Failed) return;
    if (!webglOk()) { b3Failed = true; mode3d = false; applyMode(); return; }
    b3Loading = true;
    try {
      const m = await import('./table3d.js?v=1');
      m.init({
        container: $('canvas-host'),
        onDraw: () => { if (mine.canDraw) socket.emit('drawCard', null, cbErr); else if (latestState && latestState.currentTurnId === myId() && latestState.pending > 0) toast('Erst die Strafkarten nehmen oder kontern.'); },
        myId,
      });
      b3 = m;
      m.setVisible(mode3d);
      sync3d(true);
    } catch (e) {
      console.error('3D nicht verfügbar', e);
      b3Failed = true; mode3d = false; applyMode();
    }
    b3Loading = false;
  }
  function sync3d(initial) {
    const s = latestState;
    if (!b3 || !s || s.phase === 'lobby') return;
    b3.setVisible(mode3d);
    if (!mode3d) return;
    b3.update({
      meId: myId(),
      players: s.players.map((p) => ({ id: p.id, name: p.name, handCount: p.handCount, eliminated: p.eliminated, connected: p.connected, isBot: p.isBot, score: p.score })),
      currentTurnId: s.currentTurnId,
      top: s.topCard, color: s.color, dir: s.direction, pending: s.pending,
      drawCount: s.drawCount, canDraw: !!(mine.canDraw && s.currentTurnId === myId()),
      unoId: s.unoWindow ? s.unoWindow.id : null,
      winnerId: s.phase === 'playing' ? null : (s.roundResult ? s.roundResult.winnerId : null),
      target: s.settings.target, initial: !!initial,
    });
  }
  function setMode3d(on) {
    mode3d = on; safeSet(VIEW_KEY, on ? '3d' : '2d');
    applyMode();
    if (on) { if (b3) sync3d(true); else ensure3d(); } else if (b3) b3.setVisible(false);
  }
  mode3d = want3d() && webglOk();
  applyMode();
  if (mode3d) ensure3d();
  $('btn-view3d').addEventListener('click', () => setMode3d(!mode3d));
  $('btn-reset3d').addEventListener('click', () => { if (b3) b3.resetView(); });
  $('btn-top3d').addEventListener('click', () => {
    if (!b3) return;
    const top = !b3.isTopDown(); b3.setTopDown(top);
    $('btn-top3d').textContent = top ? '🧭 Schräg' : '⬆️ Von oben';
  });
})();
