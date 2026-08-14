const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();
const useHttps = process.argv.includes('--https') || process.env.HTTPS === '1';

let server;
if (useHttps) {
  const certDir = path.join(__dirname, '.certs');
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error('\n  HTTPS requested but .certs/key.pem and .certs/cert.pem are missing.');
    console.error('  Generate them (e.g. with mkcert) or run without --https.\n');
    process.exit(1);
  }
  server = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  }, app);
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  pingInterval: 2000,
  pingTimeout: 5000
});

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

// ---- Room management ----
const rooms = new Map(); // roomCode -> RoomState
const DEFAULT_TARGET_SCORE = 3;
const PLAYER_GRACE_MS = 20000;
const HOST_GRACE_MS = 30000;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

const COLORS = ['#ff5252', '#40c4ff', '#69f0ae', '#ffd740', '#e040fb', '#ff6e40', '#eeff41', '#b388ff'];

function createRoom(hostSocketId) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    hostToken: newToken(),
    players: {},          // socketId -> player
    playersByToken: {},   // token -> player (survives reconnect)
    gameState: 'lobby',   // lobby | countdown | playing | roundover | matchover
    sensitivity: 1.0,
    tempo: 1.0,
    tempoMode: 'accelerating',
    musicTrack: 'default',
    roundNumber: 0,
    targetScore: DEFAULT_TARGET_SCORE,
    matchWinner: null,
    sensitivityTimer: null,
    countdownTimer: null,
    hostDisconnectTimer: null
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

function getRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.hostId === socketId) return room;
    if (room.players[socketId]) return room;
  }
  return null;
}

function getRoomByHostToken(token) {
  if (!token) return null;
  for (const room of rooms.values()) {
    if (room.hostToken === token) return room;
  }
  return null;
}

function nextColor(room) {
  const used = setOfPlayerColors(room);
  return COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
}

function setOfPlayerColors(room) {
  return new Set(Object.values(room.playersByToken).map(p => p.color));
}

function connectedPlayers(room) {
  return Object.values(room.playersByToken).filter(p => p.connected);
}

function publicPlayerList(room) {
  return Object.values(room.playersByToken).map(p => ({
    id: p.id,
    token: p.token,
    name: p.name,
    color: p.color,
    alive: p.alive,
    score: p.score,
    connected: p.connected
  }));
}

function broadcastRoomState(room) {
  io.to(room.code).emit('state', {
    roomCode: room.code,
    gameState: room.gameState,
    players: publicPlayerList(room),
    sensitivity: room.sensitivity,
    tempo: room.tempo,
    tempoMode: room.tempoMode,
    musicTrack: room.musicTrack,
    roundNumber: room.roundNumber,
    targetScore: room.targetScore,
    matchWinner: room.matchWinner
      ? { id: room.matchWinner.id, name: room.matchWinner.name, color: room.matchWinner.color, score: room.matchWinner.score }
      : null
  });
}

function clearPlayerDisconnectTimer(player) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
}

function removePlayer(room, player) {
  clearPlayerDisconnectTimer(player);
  if (player.id && room.players[player.id]) delete room.players[player.id];
  delete room.playersByToken[player.token];
}

function checkForWinner(room) {
  if (room.gameState !== 'playing') return;

  const present = Object.values(room.playersByToken);
  const alive = present.filter(p => p.alive);

  // Nobody left alive
  if (alive.length === 0) {
    endRound(room, null);
    return;
  }

  // Last player alive wins (others out or left the room)
  if (alive.length === 1) {
    endRound(room, alive[0]);
  }
}

function endRound(room, winner) {
  room.gameState = 'roundover';
  clearInterval(room.sensitivityTimer);
  clearInterval(room.countdownTimer);
  room.sensitivityTimer = null;
  room.countdownTimer = null;

  if (winner) {
    winner.score = (winner.score || 0) + 1;
  }

  const winnerPayload = winner
    ? { id: winner.id, token: winner.token, name: winner.name, color: winner.color, score: winner.score }
    : null;

  io.to(room.code).emit('roundOver', {
    winner: winnerPayload,
    roundNumber: room.roundNumber,
    targetScore: room.targetScore
  });
  io.to(room.code).emit('musicCommand', { action: 'stop' });

  if (winner && winner.score >= room.targetScore) {
    room.gameState = 'matchover';
    room.matchWinner = winner;
    io.to(room.code).emit('matchOver', {
      winner: winnerPayload,
      targetScore: room.targetScore
    });
  }

  broadcastRoomState(room);
}

function cleanupRoom(room) {
  clearInterval(room.sensitivityTimer);
  clearInterval(room.countdownTimer);
  if (room.hostDisconnectTimer) clearTimeout(room.hostDisconnectTimer);
  Object.values(room.playersByToken).forEach(clearPlayerDisconnectTimer);
  rooms.delete(room.code);
}

function closeRoom(room, message) {
  io.to(room.code).emit('roomClosed', { message: message || 'Host disconnected.' });
  cleanupRoom(room);
}

// ---- Socket handlers ----
io.on('connection', (socket) => {

  // Host creates a new room
  socket.on('createRoom', ({ targetScore } = {}) => {
    const room = createRoom(socket.id);
    const score = parseInt(targetScore, 10);
    if (score >= 1 && score <= 20) room.targetScore = score;
    socket.join(room.code);
    socket.emit('roomCreated', {
      code: room.code,
      hostToken: room.hostToken,
      targetScore: room.targetScore
    });
    broadcastRoomState(room);
  });

  // Host reclaims an existing room after refresh/reconnect
  socket.on('reclaimHost', ({ hostToken, code }) => {
    const room = getRoomByHostToken(hostToken) || getRoom(code);
    if (!room || room.hostToken !== hostToken) {
      socket.emit('reclaimFailed', { message: 'Room no longer exists. Creating a new one.' });
      return;
    }
    if (room.hostDisconnectTimer) {
      clearTimeout(room.hostDisconnectTimer);
      room.hostDisconnectTimer = null;
    }
    room.hostId = socket.id;
    socket.join(room.code);
    socket.emit('roomCreated', {
      code: room.code,
      hostToken: room.hostToken,
      targetScore: room.targetScore,
      reclaimed: true
    });
    broadcastRoomState(room);
  });

  // Player joins a room
  socket.on('joinRoom', ({ code, name }) => {
    const room = getRoom(code);
    if (!room) {
      socket.emit('joinError', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    if (room.gameState === 'countdown' || room.gameState === 'playing') {
      socket.emit('joinError', { message: 'Round in progress. Join when the host is back in lobby or between rounds.' });
      return;
    }
    if (room.gameState === 'matchover') {
      socket.emit('joinError', { message: 'Match is over. Wait for the host to start a new match.' });
      return;
    }
    // lobby + roundover are joinable
    if (Object.keys(room.playersByToken).length >= 8) {
      socket.emit('joinError', { message: 'Room is full (max 8 players).' });
      return;
    }

    name = (name || 'Player').toString().slice(0, 16).trim() || 'Player';
    const color = nextColor(room);
    const token = newToken();
    const player = {
      id: socket.id,
      token,
      name,
      color,
      alive: true,
      score: 0,
      connected: true,
      disconnectTimer: null
    };
    room.players[socket.id] = player;
    room.playersByToken[token] = player;
    socket.join(room.code);
    socket.emit('joined', {
      id: socket.id,
      token,
      color,
      name,
      roomCode: room.code,
      gameState: room.gameState
    });
    broadcastRoomState(room);
  });

  // Player rejoins after disconnect / refresh
  socket.on('rejoinRoom', ({ code, token, name }) => {
    const room = getRoom(code);
    if (!room) {
      socket.emit('rejoinFailed', { message: 'Room no longer exists.' });
      return;
    }
    const player = room.playersByToken[token];
    if (!player) {
      socket.emit('rejoinFailed', { message: 'Session expired. Join again.' });
      return;
    }

    clearPlayerDisconnectTimer(player);
    if (player.id && room.players[player.id] && player.id !== socket.id) {
      delete room.players[player.id];
    }
    player.id = socket.id;
    player.connected = true;
    if (name) player.name = name.toString().slice(0, 16).trim() || player.name;
    room.players[socket.id] = player;
    socket.join(room.code);

    socket.emit('joined', {
      id: socket.id,
      token: player.token,
      color: player.color,
      name: player.name,
      roomCode: room.code,
      gameState: room.gameState,
      rejoined: true,
      alive: player.alive,
      score: player.score
    });
    broadcastRoomState(room);

    // If mid-round and still alive, tell client to resume play UI
    if (room.gameState === 'playing' && player.alive) {
      socket.emit('go');
      socket.emit('tempoUpdate', { tempo: room.tempo, sensitivity: room.sensitivity });
      if (room.tempoMode !== 'steady') {
        socket.emit('musicCommand', {
          action: 'play',
          tempoMode: room.tempoMode,
          musicTrack: room.musicTrack
        });
      }
    } else if (room.gameState === 'playing' && !player.alive) {
      socket.emit('playerOut', { id: player.id, name: player.name, color: player.color });
    } else if (room.gameState === 'roundover' || room.gameState === 'matchover') {
      const winner = room.matchWinner ||
        Object.values(room.playersByToken).find(p => p.alive) || null;
      // Prefer last round winner from scores if needed — emit roundOver for UI sync
      socket.emit('roundOver', {
        winner: winner
          ? { id: winner.id, name: winner.name, color: winner.color, score: winner.score }
          : null,
        roundNumber: room.roundNumber,
        targetScore: room.targetScore
      });
      if (room.gameState === 'matchover' && room.matchWinner) {
        socket.emit('matchOver', {
          winner: {
            id: room.matchWinner.id,
            name: room.matchWinner.name,
            color: room.matchWinner.color,
            score: room.matchWinner.score
          },
          targetScore: room.targetScore
        });
      }
    }
  });

  // Host starts a round
  socket.on('startRound', (data) => {
    const tempoMode = (data && data.tempoMode) || 'accelerating';
    const room = getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.gameState === 'countdown' || room.gameState === 'playing') return;
    if (room.gameState === 'matchover') return;

    const players = Object.values(room.playersByToken);
    const ready = players.filter(p => p.connected);
    // Elimination needs at least 2 connected players so a round can finish
    if (ready.length < 2) return;

    room.tempoMode = ['accelerating', 'random', 'steady'].includes(tempoMode)
      ? tempoMode
      : 'accelerating';
    room.musicTrack = room.tempoMode === 'steady' ? 'none' : 'default';

    players.forEach(p => { p.alive = !!p.connected; });
    room.roundNumber++;
    room.sensitivity = room.tempoMode === 'steady' ? 1.0 : 0.5;
    room.tempo = 1.0;
    room.gameState = 'countdown';
    room.matchWinner = null;
    broadcastRoomState(room);

    let count = 3;
    io.to(room.code).emit('countdown', count);

    const countdownGen = (room.countdownGen = (room.countdownGen || 0) + 1);
    room.countdownTimer = setInterval(() => {
      if (room.gameState !== 'countdown' || room.countdownGen !== countdownGen) {
        clearInterval(room.countdownTimer);
        room.countdownTimer = null;
        return;
      }
      count--;
      if (count > 0) {
        io.to(room.code).emit('countdown', count);
      } else {
        clearInterval(room.countdownTimer);
        room.countdownTimer = null;
        if (room.gameState !== 'countdown' || room.countdownGen !== countdownGen) return;
        room.gameState = 'playing';
        broadcastRoomState(room);
        io.to(room.code).emit('go');

        if (room.tempoMode === 'steady') {
          // No music; keep tempo/sensitivity fixed
          io.to(room.code).emit('musicCommand', { action: 'stop' });
          io.to(room.code).emit('tempoUpdate', {
            tempo: room.tempo,
            sensitivity: room.sensitivity
          });
        } else {
          io.to(room.code).emit('musicCommand', {
            action: 'play',
            tempoMode: room.tempoMode,
            musicTrack: room.musicTrack
          });

          room.sensitivityTimer = setInterval(() => {
            if (room.gameState !== 'playing') return;

            if (room.tempoMode === 'random') {
              room.tempo = 0.5 + Math.random() * 1.5;
            } else {
              // accelerating
              room.tempo = Math.min(room.tempo + 0.02, 2.0);
            }
            room.sensitivity = 0.4 + (room.tempo * 0.8);

            io.to(room.code).emit('tempoUpdate', {
              tempo: room.tempo,
              sensitivity: room.sensitivity
            });
          }, 1500);
        }
      }
    }, 1000);
  });

  // Player got hit (moved too much) or used manual-out fallback
  socket.on('hit', () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || !p.alive || room.gameState !== 'playing') return;
    p.alive = false;
    io.to(room.code).emit('playerOut', { id: p.id, token: p.token, name: p.name, color: p.color });
    broadcastRoomState(room);
    checkForWinner(room);
  });

  // Reset to lobby (also clears match)
  socket.on('resetLobby', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.gameState = 'lobby';
    room.countdownGen = (room.countdownGen || 0) + 1;
    room.matchWinner = null;
    Object.values(room.playersByToken).forEach(p => { p.alive = true; });
    clearInterval(room.sensitivityTimer);
    clearInterval(room.countdownTimer);
    room.sensitivityTimer = null;
    room.countdownTimer = null;
    io.to(room.code).emit('musicCommand', { action: 'stop' });
    io.to(room.code).emit('backToLobby');
    broadcastRoomState(room);
  });

  // New match (keep players, reset scores)
  socket.on('newMatch', ({ targetScore } = {}) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    const score = parseInt(targetScore, 10);
    if (score >= 1 && score <= 20) room.targetScore = score;
    room.gameState = 'lobby';
    room.countdownGen = (room.countdownGen || 0) + 1;
    room.roundNumber = 0;
    room.matchWinner = null;
    Object.values(room.playersByToken).forEach(p => {
      p.alive = true;
      p.score = 0;
    });
    clearInterval(room.sensitivityTimer);
    clearInterval(room.countdownTimer);
    room.sensitivityTimer = null;
    room.countdownTimer = null;
    io.to(room.code).emit('musicCommand', { action: 'stop' });
    io.to(room.code).emit('backToLobby');
    broadcastRoomState(room);
  });

  socket.on('setTargetScore', (targetScore) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.gameState !== 'lobby' && room.gameState !== 'matchover') return;
    const score = parseInt(targetScore, 10);
    if (score >= 1 && score <= 20) {
      room.targetScore = score;
      broadcastRoomState(room);
    }
  });

  // Kick player
  socket.on('kickPlayer', (playerIdOrToken) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;

    let player = room.players[playerIdOrToken];
    if (!player) {
      player = Object.values(room.playersByToken).find(
        p => p.token === playerIdOrToken || p.id === playerIdOrToken
      );
    }
    if (!player) return;

    const target = player.id ? io.sockets.sockets.get(player.id) : null;
    if (target) {
      target.emit('kicked');
      target.leave(room.code);
    }
    removePlayer(room, player);
    broadcastRoomState(room);
    if (room.gameState === 'playing') checkForWinner(room);
  });

  // Disconnect handling with grace period
  socket.on('disconnect', () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;

    if (room.hostId === socket.id) {
      room.hostId = null;
      if (room.hostDisconnectTimer) clearTimeout(room.hostDisconnectTimer);
      room.hostDisconnectTimer = setTimeout(() => {
        // Host never reclaimed
        const still = rooms.get(room.code);
        if (still && !still.hostId) {
          closeRoom(still, 'Host disconnected.');
        }
      }, HOST_GRACE_MS);
      io.to(room.code).emit('hostAway', { message: 'Host reconnecting…' });
      return;
    }

    const player = room.players[socket.id];
    if (!player) return;

    player.connected = false;
    delete room.players[socket.id];
    player.id = null;
    broadcastRoomState(room);

    clearPlayerDisconnectTimer(player);
    player.disconnectTimer = setTimeout(() => {
      const still = rooms.get(room.code);
      if (!still) return;
      const p = still.playersByToken[player.token];
      if (!p || p.connected) return;
      removePlayer(still, p);
      broadcastRoomState(still);
      if (still.gameState === 'playing') checkForWinner(still);
    }, PLAYER_GRACE_MS);
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
const protocol = useHttps ? 'https' : 'http';
server.listen(PORT, () => {
  const ip = getLocalIP();
  console.log('\n  \u{1F93A}  Juost server running!\n');
  console.log(`  Landing page:   ${protocol}://${ip}:${PORT}/`);
  console.log(`  Host screen:    ${protocol}://${ip}:${PORT}/host.html`);
  console.log(`  Player join:    ${protocol}://${ip}:${PORT}/play\n`);
  if (!useHttps) {
    console.log('  Tip: iOS motion needs HTTPS. Run with --https after placing');
    console.log('  certs in .certs/key.pem and .certs/cert.pem (e.g. mkcert).');
    console.log('  Without HTTPS, phones can still play using Tap to move.\n');
  } else {
    console.log('  HTTPS enabled — DeviceMotion should work on phones.\n');
  }
  console.log('  Make sure phones are on the same WiFi network.\n');
});
