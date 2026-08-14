const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname + '/public'));

// ---- Game state ----
const COLORS = ['#ff5252', '#40c4ff', '#69f0ae', '#ffd740', '#e040fb', '#ff6e40', '#eeff41', '#b388ff'];
let players = {}; // socket.id -> { id, name, color, alive, joinedAt }
let gameState = 'lobby'; // 'lobby' | 'countdown' | 'playing' | 'roundover'
let sensitivity = 1.0; // multiplier, ramps up during play
let roundTimer = null;
let sensitivityTimer = null;

function publicPlayerList() {
  return Object.values(players).map(p => ({
    id: p.id, name: p.name, color: p.color, alive: p.alive
  }));
}

function broadcastState() {
  io.emit('state', {
    gameState,
    players: publicPlayerList(),
    sensitivity
  });
}

function nextColor() {
  const used = new Set(Object.values(players).map(p => p.color));
  return COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
}

function checkForWinner() {
  if (gameState !== 'playing') return;
  const alive = Object.values(players).filter(p => p.alive);
  if (alive.length <= 1 && Object.values(players).length > 1) {
    endRound(alive[0] || null);
  }
}

function endRound(winner) {
  gameState = 'roundover';
  clearInterval(sensitivityTimer);
  clearTimeout(roundTimer);
  io.emit('roundOver', { winner: winner ? { id: winner.id, name: winner.name, color: winner.color } : null });
  broadcastState();
}

io.on('connection', (socket) => {
  socket.on('join', (name) => {
    name = (name || 'Player').toString().slice(0, 16).trim() || 'Player';
    players[socket.id] = {
      id: socket.id,
      name,
      color: nextColor(),
      alive: true,
      joinedAt: Date.now()
    };
    socket.emit('joined', { id: socket.id, color: players[socket.id].color, name });
    broadcastState();
  });

  socket.on('hostJoin', () => {
    socket.join('hosts');
    broadcastState();
  });

  // Player reports they've been jostled beyond threshold
  socket.on('hit', () => {
    const p = players[socket.id];
    if (!p || !p.alive || gameState !== 'playing') return;
    p.alive = false;
    io.emit('playerOut', { id: p.id, name: p.name });
    broadcastState();
    checkForWinner();
  });

  socket.on('startRound', () => {
    if (Object.keys(players).length < 1) return;
    // reset everyone alive
    Object.values(players).forEach(p => p.alive = true);
    sensitivity = 0.6; // starts forgiving (slow music equivalent = actually starts strict per JS Joust; we'll ramp up)
    gameState = 'countdown';
    broadcastState();
    io.emit('countdown', 3);

    let count = 3;
    const cd = setInterval(() => {
      count--;
      if (count > 0) {
        io.emit('countdown', count);
      } else {
        clearInterval(cd);
        gameState = 'playing';
        broadcastState();
        io.emit('go');

        // Ramp sensitivity up over the round (game gets more forgiving over time,
        // mirroring the tempo of J.S. Joust speeding up)
        sensitivityTimer = setInterval(() => {
          sensitivity = Math.min(sensitivity + 0.03, 2.2);
          io.emit('sensitivity', sensitivity);
        }, 1500);
      }
    }, 1000);
  });

  socket.on('resetLobby', () => {
    gameState = 'lobby';
    Object.values(players).forEach(p => p.alive = true);
    clearInterval(sensitivityTimer);
    clearTimeout(roundTimer);
    broadcastState();
    io.emit('backToLobby');
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      delete players[socket.id];
      broadcastState();
      checkForWinner();
    }
  });
});

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const ip = getLocalIP();
  console.log('\n  🤺  Juost server running!\n');
  console.log(`  Host screen (big display):  http://${ip}:${PORT}/host.html`);
  console.log(`  Player join (on phones):    http://${ip}:${PORT}/\n`);
  console.log('  Make sure phones are on the same wifi network.\n');
});
