const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 2000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Room management ----
const rooms = new Map(); // roomCode -> RoomState

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

const COLORS = ['#ff5252', '#40c4ff', '#69f0ae', '#ffd740', '#e040fb', '#ff6e40', '#eeff41', '#b388ff'];

function createRoom(hostSocketId) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    players: {},          // socketId -> { id, name, color, alive, score }
    gameState: 'lobby',   // lobby | countdown | playing | roundover
    sensitivity: 1.0,
    tempo: 1.0,           // current music tempo multiplier
    musicTrack: 'default',
    roundNumber: 0,
    sensitivityTimer: null,
    countdownTimer: null
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

function getRoomByPlayer(socketId) {
  for (const room of rooms.values()) {
    if (room.players[socketId] || room.hostId === socketId) return room;
  }
  return null;
}

function nextColor(room) {
  const used = new Set(Object.values(room.players).map(p => p.color));
  return COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
}

function publicPlayerList(room) {
  return Object.values(room.players).map(p => ({
    id: p.id, name: p.name, color: p.color, alive: p.alive, score: p.score
  }));
}

function broadcastRoomState(room) {
  io.to(room.code).emit('state', {
    roomCode: room.code,
    gameState: room.gameState,
    players: publicPlayerList(room),
    sensitivity: room.sensitivity,
    tempo: room.tempo,
    roundNumber: room.roundNumber
  });
}

function checkForWinner(room) {
  if (room.gameState !== 'playing') return;
  const alive = Object.values(room.players).filter(p => p.alive);
  if (alive.length <= 1 && Object.values(room.players).length > 1) {
    endRound(room, alive[0] || null);
  }
}

function endRound(room, winner) {
  room.gameState = 'roundover';
  clearInterval(room.sensitivityTimer);
  clearInterval(room.countdownTimer);
  if (winner) winner.score = (winner.score || 0) + 1;
  io.to(room.code).emit('roundOver', {
    winner: winner ? { id: winner.id, name: winner.name, color: winner.color, score: winner.score } : null
  });
  io.to(room.code).emit('musicCommand', { action: 'stop' });
  broadcastRoomState(room);
}

function cleanupRoom(room) {
  clearInterval(room.sensitivityTimer);
  clearInterval(room.countdownTimer);
  rooms.delete(room.code);
}

// ---- Socket handlers ----
io.on('connection', (socket) => {

  // Host creates a room
  socket.on('createRoom', () => {
    const room = createRoom(socket.id);
    socket.join(room.code);
    socket.emit('roomCreated', { code: room.code });
    broadcastRoomState(room);
  });

  // Player joins a room
  socket.on('joinRoom', ({ code, name }) => {
    const room = getRoom(code);
    if (!room) {
      socket.emit('joinError', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    if (room.gameState !== 'lobby') {
      socket.emit('joinError', { message: 'Game already in progress. Wait for the next round.' });
      return;
    }
    if (Object.keys(room.players).length >= 8) {
      socket.emit('joinError', { message: 'Room is full (max 8 players).' });
      return;
    }

    name = (name || 'Player').toString().slice(0, 16).trim() || 'Player';
    const color = nextColor(room);
    room.players[socket.id] = {
      id: socket.id,
      name,
      color,
      alive: true,
      score: 0
    };
    socket.join(room.code);
    socket.emit('joined', { id: socket.id, color, name, roomCode: room.code });
    broadcastRoomState(room);
  });

  // Host starts a round
  socket.on('startRound', (data) => {
    const tempoMode = (data && data.tempoMode) || 'accelerating';
    const room = getRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (Object.keys(room.players).length < 1) return;

    // Reset all players
    Object.values(room.players).forEach(p => p.alive = true);
    room.roundNumber++;
    room.sensitivity = 0.5;
    room.tempo = 1.0;
    room.gameState = 'countdown';
    broadcastRoomState(room);

    // Countdown sequence
    let count = 3;
    io.to(room.code).emit('countdown', count);

    room.countdownTimer = setInterval(() => {
      count--;
      if (count > 0) {
        io.to(room.code).emit('countdown', count);
      } else {
        clearInterval(room.countdownTimer);
        room.gameState = 'playing';
        broadcastRoomState(room);
        io.to(room.code).emit('go');

        // Start music on host
        io.to(room.code).emit('musicCommand', {
          action: 'play',
          tempoMode: tempoMode || 'accelerating' // 'accelerating' | 'random' | 'steady'
        });

        // Ramp sensitivity based on tempo — music drives the game
        // Higher tempo = higher sensitivity threshold = more forgiving (can move more)
        // Lower tempo = lower threshold = must be very still
        room.sensitivityTimer = setInterval(() => {
          if (room.gameState !== 'playing') return;

          if (tempoMode === 'random') {
            // Random tempo shifts
            room.tempo = 0.5 + Math.random() * 1.5;
          } else {
            // Accelerating — slowly speeds up
            room.tempo = Math.min(room.tempo + 0.02, 2.0);
          }
          // Sensitivity scales with tempo
          room.sensitivity = 0.4 + (room.tempo * 0.8);

          io.to(room.code).emit('tempoUpdate', {
            tempo: room.tempo,
            sensitivity: room.sensitivity
          });
        }, 1500);
      }
    }, 1000);
  });

  // Player got hit (moved too much)
  socket.on('hit', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || !p.alive || room.gameState !== 'playing') return;
    p.alive = false;
    io.to(room.code).emit('playerOut', { id: p.id, name: p.name, color: p.color });
    broadcastRoomState(room);
    checkForWinner(room);
  });

  // Reset to lobby
  socket.on('resetLobby', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.gameState = 'lobby';
    Object.values(room.players).forEach(p => p.alive = true);
    clearInterval(room.sensitivityTimer);
    clearInterval(room.countdownTimer);
    io.to(room.code).emit('musicCommand', { action: 'stop' });
    io.to(room.code).emit('backToLobby');
    broadcastRoomState(room);
  });

  // Kick player
  socket.on('kickPlayer', (playerId) => {
    const room = getRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.players[playerId]) {
      const target = io.sockets.sockets.get(playerId);
      if (target) {
        target.emit('kicked');
        target.leave(room.code);
      }
      delete room.players[playerId];
      broadcastRoomState(room);
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;

    if (room.hostId === socket.id) {
      // Host disconnected — notify players and close room
      io.to(room.code).emit('roomClosed', { message: 'Host disconnected.' });
      cleanupRoom(room);
    } else if (room.players[socket.id]) {
      delete room.players[socket.id];
      broadcastRoomState(room);
      checkForWinner(room);
    }
  });
});

// ---- Server startup ----
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
  console.log('\n  \u{1F93A}  Juost server running!\n');
  console.log(`  Host screen (big display):  http://${ip}:${PORT}/host.html`);
  console.log(`  Player join (on phones):    http://${ip}:${PORT}/\n`);
  console.log('  Make sure phones are on the same WiFi network.\n');
});
