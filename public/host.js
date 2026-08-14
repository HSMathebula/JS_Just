const HOST_KEY = 'juost_host';
const socket = io({ reconnection: true });

const playersEl = document.getElementById('players');
const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const newMatchBtn = document.getElementById('newMatchBtn');
const tempoModeSelect = document.getElementById('tempoMode');
const targetScoreInput = document.getElementById('targetScore');
const countdownDisplay = document.getElementById('countdownDisplay');
const winnerDisplay = document.getElementById('winnerDisplay');
const winnerName = document.getElementById('winnerName');
const matchDisplay = document.getElementById('matchDisplay');
const matchName = document.getElementById('matchName');
const musicPanel = document.getElementById('musicPanel');
const musicBarLabel = document.getElementById('musicBarLabel');
const tempoFill = document.getElementById('tempoFill');
const tempoLabel = document.getElementById('tempoLabel');
const visualizer = document.getElementById('visualizer');
const vizCanvas = document.getElementById('vizCanvas');
const statusBanner = document.getElementById('statusBanner');
const roundBadge = document.getElementById('roundBadge');
const scoreBadge = document.getElementById('scoreBadge');

let audioCtx = null;
let musicOsc = null;
let musicGain = null;
let lfo = null;
let analyser = null;
let animFrame = null;
let currentTempo = 1.0;
let lastState = null;
let musicEnabled = true;

function loadHostSession() {
  try { return JSON.parse(sessionStorage.getItem(HOST_KEY) || 'null'); }
  catch (e) { return null; }
}

function saveHostSession(data) {
  sessionStorage.setItem(HOST_KEY, JSON.stringify(data));
}

function clearHostSession() {
  sessionStorage.removeItem(HOST_KEY);
}

socket.on('connect', () => {
  statusBanner.style.display = 'none';
  const session = loadHostSession();
  if (session && session.hostToken && session.code) {
    socket.emit('reclaimHost', { hostToken: session.hostToken, code: session.code });
  } else {
    socket.emit('createRoom', { targetScore: parseInt(targetScoreInput.value, 10) || 3 });
  }
});

socket.on('reclaimFailed', () => {
  clearHostSession();
  socket.emit('createRoom', { targetScore: parseInt(targetScoreInput.value, 10) || 3 });
});

socket.on('roomCreated', (data) => {
  document.getElementById('roomCode').textContent = data.code;
  const playerPage = new URL('player.html', location.href).href;
  document.getElementById('joinUrl').innerHTML =
    'Players join at <strong>' + playerPage + '</strong> with code <strong>' + data.code + '</strong><br>' +
    '<span style="opacity:0.8">Same Wi‑Fi · iOS motion needs HTTPS (or use Tap to move)</span>';
  saveHostSession({ code: data.code, hostToken: data.hostToken });
  if (data.targetScore) {
    targetScoreInput.value = data.targetScore;
    scoreBadge.textContent = 'First to ' + data.targetScore;
  }
  statusBanner.style.display = 'none';
});

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  analyser.connect(audioCtx.destination);
}

function startMusic(tempoMode) {
  if (tempoMode === 'steady') {
    stopMusic();
    return;
  }
  initAudio();
  stopMusic();
  musicEnabled = true;

  musicGain = audioCtx.createGain();
  musicGain.gain.value = 0.15;
  musicGain.connect(analyser);

  musicOsc = audioCtx.createOscillator();
  musicOsc.type = 'triangle';
  musicOsc.frequency.value = 220;
  musicOsc.connect(musicGain);
  musicOsc.start();

  lfo = audioCtx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = currentTempo * 2;
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 0.12;
  lfo.connect(lfoGain);
  lfoGain.connect(musicGain.gain);
  lfo.start();

  visualizer.style.display = 'block';
  drawVisualizer();
}

function updateMusicTempo(tempo) {
  currentTempo = tempo;
  if (lfo) lfo.frequency.value = tempo * 2.5;
  if (musicOsc) musicOsc.frequency.value = 180 + tempo * 80;
}

function stopMusic() {
  if (musicOsc) { try { musicOsc.stop(); } catch (e) {} musicOsc = null; }
  if (lfo) { try { lfo.stop(); } catch (e) {} lfo = null; }
  musicGain = null;
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  visualizer.style.display = 'none';
}

function drawVisualizer() {
  if (!analyser) return;
  const ctx = vizCanvas.getContext('2d');
  const width = vizCanvas.width = vizCanvas.clientWidth * 2;
  const height = vizCanvas.height = vizCanvas.clientHeight * 2;
  const bufLen = analyser.frequencyBinCount;
  const data = new Uint8Array(bufLen);

  function draw() {
    animFrame = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(data);
    ctx.fillStyle = '#0b0b12';
    ctx.fillRect(0, 0, width, height);
    const barW = width / bufLen;
    for (let i = 0; i < bufLen; i++) {
      const h = (data[i] / 255) * height;
      const hue = 200 - (currentTempo - 0.5) * 60 + i * 2;
      ctx.fillStyle = 'hsl(' + hue + ', 80%, 60%)';
      ctx.fillRect(i * barW, height - h, barW - 1, h);
    }
  }
  draw();
}

function setTempoUI(tempo, mode) {
  const pct = Math.min(100, ((tempo - 0.5) / 1.5) * 100);
  tempoFill.style.width = pct + '%';
  if (mode === 'steady') {
    tempoLabel.textContent = 'Steady — fixed sensitivity';
    musicBarLabel.textContent = 'Sensitivity (no music)';
  } else {
    tempoLabel.textContent = tempo.toFixed(1) + 'x — ' +
      (tempo < 1.0 ? 'slow = strict' : tempo > 1.5 ? 'fast = lenient' : 'moderate');
    musicBarLabel.textContent = '♩ Music Tempo — controls movement sensitivity';
  }
}

function render(state) {
  lastState = state;
  roundBadge.textContent = 'Round ' + (state.roundNumber || 0);
  scoreBadge.textContent = 'First to ' + (state.targetScore || 3);
  if (document.activeElement !== targetScoreInput) {
    targetScoreInput.value = state.targetScore || 3;
  }

  playersEl.innerHTML = '';
  if (state.players.length === 0) {
    playersEl.innerHTML = '<span class="empty-hint">Waiting for players… need at least 2 to start</span>';
  } else {
    state.players.forEach(p => {
      const chip = document.createElement('div');
      let cls = 'player-chip';
      if (!p.alive && (state.gameState === 'playing' || state.gameState === 'countdown')) cls += ' out';
      if (!p.alive && state.gameState === 'roundover') cls += ' out';
      if (!p.connected) cls += ' away';
      chip.className = cls;
      chip.style.borderColor = p.color;
      chip.style.color = p.color;

      const label = document.createElement('span');
      label.textContent = p.name + (p.connected ? '' : ' (away)');
      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = '(' + (p.score || 0) + ')';

      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'kick-btn';
      kick.textContent = 'Kick';
      kick.title = 'Remove player';
      kick.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('kickPlayer', p.token || p.id);
      });

      chip.appendChild(label);
      chip.appendChild(score);
      if (state.gameState === 'lobby' || state.gameState === 'roundover' || state.gameState === 'matchover') {
        chip.appendChild(kick);
      }
      playersEl.appendChild(chip);
    });
  }

  const connectedCount = state.players.filter(p => p.connected !== false).length;
  const busy = state.gameState === 'playing' || state.gameState === 'countdown';
  const matchDone = state.gameState === 'matchover';
  startBtn.disabled = connectedCount < 2 || busy || matchDone;
  newMatchBtn.style.display = matchDone ? 'inline-block' : 'none';
  targetScoreInput.disabled = busy;
  tempoModeSelect.disabled = busy;

  if (state.gameState === 'lobby') {
    countdownDisplay.style.display = 'none';
    winnerDisplay.style.display = 'none';
    matchDisplay.style.display = 'none';
    musicPanel.style.display = 'none';
    playersEl.style.display = 'flex';
  } else if (state.gameState === 'countdown') {
    winnerDisplay.style.display = 'none';
    matchDisplay.style.display = 'none';
    musicPanel.style.display = 'none';
  } else if (state.gameState === 'playing') {
    countdownDisplay.style.display = 'none';
    winnerDisplay.style.display = 'none';
    matchDisplay.style.display = 'none';
    musicPanel.style.display = 'block';
    playersEl.style.display = 'flex';
    setTempoUI(state.tempo, state.tempoMode);
  } else if (state.gameState === 'roundover') {
    countdownDisplay.style.display = 'none';
    matchDisplay.style.display = 'none';
    musicPanel.style.display = 'none';
    playersEl.style.display = 'flex';
    winnerDisplay.style.display = 'block';
  } else if (state.gameState === 'matchover') {
    countdownDisplay.style.display = 'none';
    winnerDisplay.style.display = 'none';
    musicPanel.style.display = 'none';
    playersEl.style.display = 'flex';
    matchDisplay.style.display = 'block';
    if (state.matchWinner) {
      matchName.textContent = state.matchWinner.name;
      matchName.style.color = state.matchWinner.color;
    }
  }
}

socket.on('state', render);

socket.on('countdown', (n) => {
  playersEl.style.display = 'none';
  countdownDisplay.style.display = 'block';
  countdownDisplay.textContent = n;
  winnerDisplay.style.display = 'none';
  matchDisplay.style.display = 'none';
});

socket.on('go', () => {
  countdownDisplay.style.display = 'none';
  playersEl.style.display = 'flex';
});

socket.on('musicCommand', (cmd) => {
  if (cmd.action === 'play') {
    startMusic(cmd.tempoMode);
  } else if (cmd.action === 'stop') {
    stopMusic();
  }
});

socket.on('tempoUpdate', (data) => {
  currentTempo = data.tempo;
  updateMusicTempo(data.tempo);
  const mode = lastState && lastState.tempoMode;
  setTempoUI(data.tempo, mode);
});

socket.on('roundOver', (data) => {
  winnerDisplay.style.display = 'block';
  musicPanel.style.display = 'none';
  winnerName.textContent = data.winner ? data.winner.name + ' 🏆' : 'No winner';
  winnerName.style.color = data.winner ? data.winner.color : '#fff';
});

socket.on('matchOver', (data) => {
  matchDisplay.style.display = 'block';
  winnerDisplay.style.display = 'none';
  matchName.textContent = data.winner ? data.winner.name + ' 👑' : 'No champion';
  matchName.style.color = data.winner ? data.winner.color : '#fff';
});

socket.on('playerOut', () => {
  if (audioCtx) {
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = 150;
    g.gain.value = 0.2;
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.start();
    osc.frequency.exponentialRampToValueAtTime(50, audioCtx.currentTime + 0.3);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    osc.stop(audioCtx.currentTime + 0.4);
  }
});

socket.on('hostAway', () => {
  /* only players receive this normally */
});

socket.on('disconnect', () => {
  statusBanner.style.display = 'block';
  statusBanner.textContent = 'Reconnecting… room will stay open briefly.';
});

startBtn.addEventListener('click', (e) => {
  e.preventDefault();
  winnerDisplay.style.display = 'none';
  matchDisplay.style.display = 'none';
  initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  socket.emit('startRound', { tempoMode: tempoModeSelect.value });
});

resetBtn.addEventListener('click', (e) => {
  e.preventDefault();
  stopMusic();
  socket.emit('resetLobby');
});

newMatchBtn.addEventListener('click', (e) => {
  e.preventDefault();
  stopMusic();
  socket.emit('newMatch', { targetScore: parseInt(targetScoreInput.value, 10) || 3 });
});

targetScoreInput.addEventListener('change', () => {
  const v = parseInt(targetScoreInput.value, 10);
  if (v >= 1 && v <= 20) socket.emit('setTargetScore', v);
});