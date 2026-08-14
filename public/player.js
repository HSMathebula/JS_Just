const SESSION_KEY = 'juost_player';
const socket = io({ reconnection: true, reconnectionAttempts: 20 });

const app = document.getElementById('app');
const screens = document.querySelectorAll('.screen');
const countdownScreen = document.getElementById('countdownScreen');
const statusWord = document.getElementById('statusWord');
const statusSub = document.getElementById('statusSub');
const tempoIndicator = document.getElementById('tempoIndicator');
const codeInput = document.getElementById('codeInput');
const nameInput = document.getElementById('nameInput');
const joinBtn = document.getElementById('joinBtn');
const playerNameTag = document.getElementById('playerNameTag');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const roundInfo = document.getElementById('roundInfo');
const errorMsg = document.getElementById('errorMsg');
const secureHint = document.getElementById('secureHint');
const tapOutBtn = document.getElementById('tapOutBtn');
const reconnectBanner = document.getElementById('reconnectBanner');
const disconnectReason = document.getElementById('disconnectReason');

let connected = false;
let myName = '';
let myColor = '#40c4ff';
let myToken = null;
let myRoomCode = null;
let alive = true;
let motionActive = false;
let useTapControl = false;
let motionAvailable = false;
let sensitivity = 0.5;
let tempo = 1.0;
let inRoom = false;

const BASE_THRESHOLD = 24;

// ---- Player audio (hear the beat) ----
let audioCtx = null;
let musicOsc = null;
let musicGain = null;
let lfo = null;

function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {}
}

function startMusic(tempoMode) {
  if (tempoMode === 'steady') {
    stopMusic();
    return;
  }
  initAudio();
  if (!audioCtx) return;
  stopMusic();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  musicGain = audioCtx.createGain();
  musicGain.gain.value = 0.12;
  musicGain.connect(audioCtx.destination);

  musicOsc = audioCtx.createOscillator();
  musicOsc.type = 'triangle';
  musicOsc.frequency.value = 220;
  musicOsc.connect(musicGain);
  musicOsc.start();

  lfo = audioCtx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = tempo * 2;
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 0.1;
  lfo.connect(lfoGain);
  lfoGain.connect(musicGain.gain);
  lfo.start();
}

function updateMusicTempo(t) {
  tempo = t;
  if (lfo) lfo.frequency.value = t * 2.5;
  if (musicOsc) musicOsc.frequency.value = 180 + t * 80;
}

function stopMusic() {
  if (musicOsc) { try { musicOsc.stop(); } catch (e) {} musicOsc = null; }
  if (lfo) { try { lfo.stop(); } catch (e) {} lfo = null; }
  musicGain = null;
}

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
  catch (e) { return null; }
}

function saveSession(data) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

function showScreen(id) {
  screens.forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function updateSecureHint() {
  if (!window.isSecureContext) {
    secureHint.textContent = 'This page is not HTTPS — motion may be blocked. You can still play with Tap to move.';
  } else {
    secureHint.textContent = '';
  }
}
updateSecureHint();

function requestMotionPermission(cb) {
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission().then(state => {
      cb(state === 'granted');
    }).catch(() => cb(false));
  } else if (typeof DeviceMotionEvent === 'undefined') {
    cb(false);
  } else {
    // Non-iOS: assume available; may still get no events (desktop)
    cb(true);
  }
}

function probeMotion(cb) {
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    window.removeEventListener('devicemotion', onEvt);
    cb(ok);
  };
  function onEvt(e) {
    const acc = e.accelerationIncludingGravity || e.acceleration;
    if (acc && (acc.x != null || acc.y != null || acc.z != null)) finish(true);
  }
  window.addEventListener('devicemotion', onEvt);
  setTimeout(() => finish(false), 800);
}

socket.on('connect', () => {
  connected = true;
  reconnectBanner.style.display = 'none';

  const session = loadSession();
  if (session && session.token && session.code) {
    myName = session.name || myName || 'Player';
    myToken = session.token;
    myRoomCode = session.code;
    socket.emit('rejoinRoom', { code: session.code, token: session.token, name: myName });
  }
});

socket.on('disconnect', () => {
  connected = false;
  if (inRoom) reconnectBanner.style.display = 'block';
});

socket.on('rejoinFailed', (data) => {
  clearSession();
  inRoom = false;
  myToken = null;
  errorMsg.textContent = data.message || 'Could not rejoin. Join again.';
  showScreen('joinScreen');
});

joinBtn.addEventListener('click', (e) => {
  e.preventDefault();
  const code = codeInput.value.trim().toUpperCase();
  myName = nameInput.value.trim() || 'Player';
  errorMsg.textContent = '';

  if (!connected) {
    errorMsg.textContent = 'Not connected to server. Make sure it is running.';
    return;
  }
  if (code.length !== 4) {
    errorMsg.textContent = 'Enter the 4-letter room code from the host screen.';
    return;
  }

  initAudio();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

  requestMotionPermission((granted) => {
    motionAvailable = granted;
    if (!granted) {
      useTapControl = true;
      secureHint.textContent = 'Motion unavailable — you will use Tap to move during rounds.';
    } else {
      // Confirm events actually fire (desktop often grants API but sends nothing)
      probeMotion((hasData) => {
        motionAvailable = hasData;
        useTapControl = !hasData;
        if (!hasData) {
          secureHint.textContent = 'No motion data — Tap to move will be enabled in-game.';
        }
      });
    }
    socket.emit('joinRoom', { code: code, name: myName });
  });
});

[codeInput, nameInput].forEach(el => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
  });
});

function enterLobby(data) {
  inRoom = true;
  myColor = data.color;
  myToken = data.token;
  myRoomCode = data.roomCode;
  myName = data.name;
  saveSession({ code: data.roomCode, token: data.token, name: data.name });
  playerNameTag.textContent = data.name;
  playerNameTag.style.color = data.color;
  roomCodeDisplay.textContent = 'Room: ' + data.roomCode;
  app.style.backgroundColor = '#0b0b12';
  showScreen('lobbyScreen');
}

socket.on('joined', (data) => {
  enterLobby(data);
  if (data.rejoined && data.gameState === 'playing') {
    // go / playerOut handled by follow-up events from server
  } else if (data.rejoined && (data.gameState === 'roundover' || data.gameState === 'matchover')) {
    // wait for roundOver / matchOver events
  } else if (data.gameState === 'roundover') {
    statusWord.textContent = 'WAIT';
    statusWord.style.color = myColor;
    statusSub.textContent = 'Joined between rounds — wait for the next start';
    showScreen('statusScreen');
    tapOutBtn.style.display = 'none';
  }
});

socket.on('joinError', (data) => {
  errorMsg.textContent = data.message;
});

socket.on('state', (state) => {
  if (!inRoom) return;
  roundInfo.textContent = 'Round ' + (state.roundNumber || 0) + ' · first to ' + (state.targetScore || 3);
});

socket.on('countdown', (n) => {
  stopMusic();
  showScreen('countdownScreen');
  countdownScreen.textContent = n;
});

socket.on('go', () => {
  alive = true;
  sensitivity = 0.5;
  tempo = 1.0;
  statusWord.textContent = 'ALIVE';
  statusWord.style.color = myColor;
  statusSub.textContent = useTapControl
    ? 'tap when you should move / get out'
    : 'hold steady — move with the beat';
  tempoIndicator.textContent = '♩ tempo: 1.0x';
  app.style.backgroundColor = '#0b0b12';
  showScreen('statusScreen');
  tapOutBtn.style.display = useTapControl ? 'block' : 'none';
  if (!useTapControl) startMotionWatch();
  else stopMotionWatch();
});

socket.on('musicCommand', (cmd) => {
  if (cmd.action === 'play') startMusic(cmd.tempoMode);
  else if (cmd.action === 'stop') stopMusic();
});

socket.on('tempoUpdate', (data) => {
  tempo = data.tempo;
  sensitivity = data.sensitivity;
  updateMusicTempo(tempo);
  tempoIndicator.textContent = '♩ tempo: ' + tempo.toFixed(1) + 'x';

  if (alive) {
    const hue = Math.round(200 - (tempo - 0.5) * 80);
    statusSub.style.color = 'hsl(' + hue + ', 70%, 70%)';
    if (!useTapControl) {
      statusSub.textContent = tempo < 1.0 ? 'slow — freeze!' : tempo > 1.5 ? 'fast — move freely!' : 'hold steady';
    }
  }
});

socket.on('playerOut', (data) => {
  if (data.id === socket.id || (myToken && data.token === myToken)) {
    markOut('you moved too much!');
  }
});

function markOut(reason) {
  alive = false;
  statusWord.textContent = 'OUT';
  statusWord.style.color = '#ff5252';
  statusSub.textContent = reason || 'you moved too much!';
  statusSub.style.color = '';
  tempoIndicator.textContent = '';
  app.style.backgroundColor = '#210505';
  tapOutBtn.style.display = 'none';
  stopMotionWatch();
  stopMusic();
}

socket.on('backToLobby', () => {
  alive = true;
  stopMotionWatch();
  stopMusic();
  app.style.backgroundColor = '#0b0b12';
  showScreen('lobbyScreen');
});

socket.on('roundOver', (data) => {
  stopMotionWatch();
  stopMusic();
  tapOutBtn.style.display = 'none';
  showScreen('statusScreen');

  const iWon = data.winner && (
    data.winner.id === socket.id ||
    (myToken && data.winner.token === myToken)
  );
  if (iWon) {
    statusWord.textContent = 'WIN!';
    statusWord.style.color = '#ffd740';
    statusSub.textContent = 'You survived round ' + (data.roundNumber || '') + '!';
  } else if (data.winner) {
    statusWord.textContent = 'ROUND OVER';
    statusWord.style.color = '#aaa';
    statusSub.textContent = data.winner.name + ' won · waiting for host';
  } else {
    statusWord.textContent = 'ROUND OVER';
    statusWord.style.color = '#aaa';
    statusSub.textContent = 'No winner · waiting for host';
  }
  statusSub.style.color = '';
  tempoIndicator.textContent = '';
  app.style.backgroundColor = '#0b0b12';
});

socket.on('matchOver', (data) => {
  stopMotionWatch();
  stopMusic();
  tapOutBtn.style.display = 'none';
  showScreen('statusScreen');
  const iWon = data.winner && (
    data.winner.id === socket.id ||
    (myToken && data.winner.token === myToken)
  );
  statusWord.textContent = iWon ? 'CHAMPION!' : 'MATCH OVER';
  statusWord.style.color = iWon ? '#ffd740' : '#aaa';
  statusSub.textContent = data.winner
    ? data.winner.name + ' reached ' + (data.targetScore || '') + ' wins!'
    : 'Match finished';
  tempoIndicator.textContent = '';
  app.style.backgroundColor = '#0b0b12';
});

socket.on('kicked', () => {
  inRoom = false;
  clearSession();
  stopMotionWatch();
  stopMusic();
  disconnectReason.textContent = 'You were kicked from the room';
  showScreen('disconnectedScreen');
});

socket.on('roomClosed', (data) => {
  inRoom = false;
  clearSession();
  stopMotionWatch();
  stopMusic();
  disconnectReason.textContent = (data && data.message) || 'Host disconnected';
  showScreen('disconnectedScreen');
});

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

function startMotionWatch() {
  if (motionActive || useTapControl) return;
  motionActive = true;
  window.addEventListener('devicemotion', onMotion);
}

function stopMotionWatch() {
  motionActive = false;
  window.removeEventListener('devicemotion', onMotion);
}

function eliminateSelf() {
  if (!alive) return;
  alive = false;
  markOut('you moved too much!');
  vibrate([80, 60, 200]);
  socket.emit('hit');
}

tapOutBtn.addEventListener('click', (e) => {
  e.preventDefault();
  eliminateSelf();
});

function onMotion(e) {
  if (!alive) return;
  const acc = e.accelerationIncludingGravity || e.acceleration;
  if (!acc) return;
  const mag = Math.sqrt((acc.x || 0) ** 2 + (acc.y || 0) ** 2 + (acc.z || 0) ** 2);

  const threshold = BASE_THRESHOLD * sensitivity;

  if (mag > threshold * 0.65 && mag <= threshold) {
    app.style.backgroundColor = '#3a1a1a';
    vibrate(30);
    setTimeout(() => { if (alive) app.style.backgroundColor = '#0b0b12'; }, 100);
  }

  if (mag > threshold) {
    eliminateSelf();
  }
}

// Prefill code from ?code=
const params = new URLSearchParams(location.search);
if (params.get('code')) codeInput.value = params.get('code').slice(0, 4).toUpperCase();