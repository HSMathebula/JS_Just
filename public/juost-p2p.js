/**
 * Connects to the Node Socket.IO server when available (npm start).
 * On GitHub Pages / static hosting, the host tab becomes the room
 * and players join over PeerJS (WebRTC).
 */
(function (global) {
  const COLORS = ['#ff5252', '#40c4ff', '#69f0ae', '#ffd740', '#e040fb', '#ff6e40', '#eeff41', '#b388ff'];
  const DEFAULT_TARGET_SCORE = 3;
  const PLAYER_GRACE_MS = 20000;
  const PEER_PREFIX = 'juost';

  function newToken() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function generateRoomCode(taken) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return taken && taken.has(code) ? generateRoomCode(taken) : code;
  }

  function FakeSocket() {
    this.listeners = {};
    this.id = null;
    this.connected = false;
    this.p2p = false;
  }
  FakeSocket.prototype.on = function (ev, fn) {
    (this.listeners[ev] || (this.listeners[ev] = [])).push(fn);
    return this;
  };
  FakeSocket.prototype._in = function (ev, data) {
    (this.listeners[ev] || []).forEach((fn) => {
      try { fn(data); } catch (err) { console.error(err); }
    });
  };
  FakeSocket.prototype.emit = function () {};

  function isLocalGameServer() {
    const host = location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  }

  function trySocketIO(timeoutMs) {
    return new Promise((resolve) => {
      if (typeof io !== 'function') return resolve(null);
      if (!isLocalGameServer()) return resolve(null);
      let done = false;
      const finish = (sock) => {
        if (done) return;
        done = true;
        resolve(sock);
      };
      let s;
      try {
        s = io({
          reconnection: false,
          timeout: timeoutMs,
          transports: ['websocket', 'polling']
        });
      } catch (e) {
        return finish(null);
      }
      const t = setTimeout(() => {
        try { s.close(); } catch (e) {}
        finish(null);
      }, timeoutMs);
      s.on('connect', () => {
        clearTimeout(t);
        if (s.io && s.io.opts) s.io.opts.reconnection = true;
        finish(s);
      });
      s.on('connect_error', () => {
        clearTimeout(t);
        try { s.close(); } catch (e) {}
        finish(null);
      });
    });
  }

  function bindIoSocket(wrapper, ioSock) {
    Object.keys(wrapper.listeners).forEach((ev) => {
      wrapper.listeners[ev].forEach((fn) => ioSock.on(ev, fn));
    });
    wrapper.on = function (ev, fn) {
      ioSock.on(ev, fn);
      return wrapper;
    };
    wrapper.emit = function (ev, data) {
      ioSock.emit(ev, data);
    };
    Object.defineProperty(wrapper, 'id', {
      configurable: true,
      get: function () { return ioSock.id; }
    });
    wrapper.connected = true;
    wrapper.p2p = false;
    wrapper._in('connect');
  }

  function publicPlayerList(room) {
    return Object.values(room.playersByToken).map((p) => ({
      id: p.id,
      token: p.token,
      name: p.name,
      color: p.color,
      alive: p.alive,
      score: p.score,
      connected: p.connected
    }));
  }

  function nextColor(room) {
    const used = new Set(Object.values(room.playersByToken).map((p) => p.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
  }

  function RoomEngine(send) {
    this.send = send;
    this.room = null;
  }

  RoomEngine.prototype.broadcastState = function () {
    const room = this.room;
    if (!room) return;
    this.send('state', {
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
    }, null);
  };

  RoomEngine.prototype.create = function (targetScore) {
    const code = generateRoomCode();
    this.room = {
      code,
      hostToken: newToken(),
      players: {},
      playersByToken: {},
      gameState: 'lobby',
      sensitivity: 1.0,
      tempo: 1.0,
      tempoMode: 'accelerating',
      musicTrack: 'default',
      roundNumber: 0,
      targetScore: DEFAULT_TARGET_SCORE,
      matchWinner: null,
      sensitivityTimer: null,
      countdownTimer: null
    };
    const score = parseInt(targetScore, 10);
    if (score >= 1 && score <= 20) this.room.targetScore = score;
    return this.room;
  };

  RoomEngine.prototype.attachPlayer = function (connId, conn) {
    this.room.players[connId] = { conn: conn, connId: connId };
  };

  RoomEngine.prototype.sendTo = function (player, event, data) {
    this.send(event, data, player && player.id);
  };

  RoomEngine.prototype.clearPlayerTimer = function (player) {
    if (player && player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
  };

  RoomEngine.prototype.removePlayer = function (player) {
    this.clearPlayerTimer(player);
    if (player.id && this.room.players[player.id]) delete this.room.players[player.id];
    delete this.room.playersByToken[player.token];
  };

  RoomEngine.prototype.endRound = function (winner) {
    const room = this.room;
    room.gameState = 'roundover';
    clearInterval(room.sensitivityTimer);
    clearInterval(room.countdownTimer);
    room.sensitivityTimer = null;
    room.countdownTimer = null;
    if (winner) winner.score = (winner.score || 0) + 1;
    const winnerPayload = winner
      ? { id: winner.id, token: winner.token, name: winner.name, color: winner.color, score: winner.score }
      : null;
    this.send('roundOver', {
      winner: winnerPayload,
      roundNumber: room.roundNumber,
      targetScore: room.targetScore
    }, null);
    this.send('musicCommand', { action: 'stop' }, null);
    if (winner && winner.score >= room.targetScore) {
      room.gameState = 'matchover';
      room.matchWinner = winner;
      this.send('matchOver', { winner: winnerPayload, targetScore: room.targetScore }, null);
    }
    this.broadcastState();
  };

  RoomEngine.prototype.checkForWinner = function () {
    const room = this.room;
    if (room.gameState !== 'playing') return;
    const present = Object.values(room.playersByToken);
    const alive = present.filter((p) => p.alive);
    if (alive.length === 0) this.endRound(null);
    else if (alive.length === 1) this.endRound(alive[0]);
  };

  RoomEngine.prototype.handleHost = function (ev, data) {
    const room = this.room;
    if (!room) return;
    if (ev === 'startRound') {
      const tempoMode = (data && data.tempoMode) || 'accelerating';
      if (room.gameState === 'countdown' || room.gameState === 'playing' || room.gameState === 'matchover') return;
      const players = Object.values(room.playersByToken);
      const ready = players.filter((p) => p.connected);
      if (ready.length < 2) return;
      room.tempoMode = ['accelerating', 'random', 'steady'].includes(tempoMode) ? tempoMode : 'accelerating';
      room.musicTrack = room.tempoMode === 'steady' ? 'none' : 'default';
      players.forEach((p) => { p.alive = !!p.connected; });
      room.roundNumber++;
      room.sensitivity = room.tempoMode === 'steady' ? 1.0 : 0.5;
      room.tempo = 1.0;
      room.gameState = 'countdown';
      room.matchWinner = null;
      this.broadcastState();
      let count = 3;
      this.send('countdown', count, null);
      const self = this;
      room.countdownTimer = setInterval(() => {
        count--;
        if (count > 0) {
          self.send('countdown', count, null);
        } else {
          clearInterval(room.countdownTimer);
          room.countdownTimer = null;
          room.gameState = 'playing';
          self.broadcastState();
          self.send('go', null, null);
          if (room.tempoMode === 'steady') {
            self.send('musicCommand', { action: 'stop' }, null);
            self.send('tempoUpdate', { tempo: room.tempo, sensitivity: room.sensitivity }, null);
          } else {
            self.send('musicCommand', {
              action: 'play',
              tempoMode: room.tempoMode,
              musicTrack: room.musicTrack
            }, null);
            room.sensitivityTimer = setInterval(() => {
              if (room.gameState !== 'playing') return;
              if (room.tempoMode === 'random') room.tempo = 0.5 + Math.random() * 1.5;
              else room.tempo = Math.min(room.tempo + 0.02, 2.0);
              room.sensitivity = 0.4 + (room.tempo * 0.8);
              self.send('tempoUpdate', { tempo: room.tempo, sensitivity: room.sensitivity }, null);
            }, 1500);
          }
        }
      }, 1000);
    } else if (ev === 'resetLobby') {
      room.gameState = 'lobby';
      room.matchWinner = null;
      Object.values(room.playersByToken).forEach((p) => { p.alive = true; });
      clearInterval(room.sensitivityTimer);
      clearInterval(room.countdownTimer);
      room.sensitivityTimer = null;
      room.countdownTimer = null;
      this.send('musicCommand', { action: 'stop' }, null);
      this.send('backToLobby', null, null);
      this.broadcastState();
    } else if (ev === 'newMatch') {
      const score = parseInt(data && data.targetScore, 10);
      if (score >= 1 && score <= 20) room.targetScore = score;
      room.gameState = 'lobby';
      room.roundNumber = 0;
      room.matchWinner = null;
      Object.values(room.playersByToken).forEach((p) => { p.alive = true; p.score = 0; });
      clearInterval(room.sensitivityTimer);
      clearInterval(room.countdownTimer);
      room.sensitivityTimer = null;
      room.countdownTimer = null;
      this.send('musicCommand', { action: 'stop' }, null);
      this.send('backToLobby', null, null);
      this.broadcastState();
    } else if (ev === 'setTargetScore') {
      if (room.gameState !== 'lobby' && room.gameState !== 'matchover') return;
      const score = parseInt(data, 10);
      if (score >= 1 && score <= 20) {
        room.targetScore = score;
        this.broadcastState();
      }
    } else if (ev === 'kickPlayer') {
      let player = room.players[data];
      if (!player || !player.token) {
        player = Object.values(room.playersByToken).find(
          (p) => p.token === data || p.id === data
        );
      }
      if (!player) return;
      this.send('kicked', null, player.id);
      this.removePlayer(player);
      this.broadcastState();
      if (room.gameState === 'playing') this.checkForWinner();
    }
  };

  RoomEngine.prototype.handlePlayer = function (connId, ev, data, conn) {
    const room = this.room;
    if (!room) return;

    if (ev === 'joinRoom') {
      if (room.gameState === 'countdown' || room.gameState === 'playing') {
        this.send('joinError', { message: 'Round in progress. Join when the host is back in lobby or between rounds.' }, connId);
        return;
      }
      if (room.gameState === 'matchover') {
        this.send('joinError', { message: 'Match is over. Wait for the host to start a new match.' }, connId);
        return;
      }
      if (Object.keys(room.playersByToken).length >= 8) {
        this.send('joinError', { message: 'Room is full (max 8 players).' }, connId);
        return;
      }
      const name = (data && data.name || 'Player').toString().slice(0, 16).trim() || 'Player';
      const token = newToken();
      const player = {
        id: connId,
        token: token,
        name: name,
        color: nextColor(room),
        alive: true,
        score: 0,
        connected: true,
        disconnectTimer: null,
        conn: conn
      };
      room.players[connId] = player;
      room.playersByToken[token] = player;
      this.send('joined', {
        id: connId,
        token: token,
        color: player.color,
        name: player.name,
        roomCode: room.code,
        gameState: room.gameState
      }, connId);
      this.broadcastState();
      return;
    }

    if (ev === 'rejoinRoom') {
      const player = room.playersByToken[data && data.token];
      if (!player) {
        this.send('rejoinFailed', { message: 'Session expired. Join again.' }, connId);
        return;
      }
      this.clearPlayerTimer(player);
      if (player.id && room.players[player.id] && player.id !== connId) {
        delete room.players[player.id];
      }
      player.id = connId;
      player.connected = true;
      player.conn = conn;
      if (data && data.name) player.name = data.name.toString().slice(0, 16).trim() || player.name;
      room.players[connId] = player;
      this.send('joined', {
        id: connId,
        token: player.token,
        color: player.color,
        name: player.name,
        roomCode: room.code,
        gameState: room.gameState,
        rejoined: true,
        alive: player.alive,
        score: player.score
      }, connId);
      this.broadcastState();
      if (room.gameState === 'playing' && player.alive) {
        this.send('go', null, connId);
        this.send('tempoUpdate', { tempo: room.tempo, sensitivity: room.sensitivity }, connId);
        if (room.tempoMode !== 'steady') {
          this.send('musicCommand', {
            action: 'play',
            tempoMode: room.tempoMode,
            musicTrack: room.musicTrack
          }, connId);
        }
      } else if (room.gameState === 'playing' && !player.alive) {
        this.send('playerOut', { id: player.id, name: player.name, color: player.color, token: player.token }, connId);
      }
      return;
    }

    if (ev === 'hit') {
      const p = room.players[connId];
      if (!p || !p.alive || room.gameState !== 'playing') return;
      p.alive = false;
      this.send('playerOut', { id: p.id, token: p.token, name: p.name, color: p.color }, null);
      this.broadcastState();
      this.checkForWinner();
    }
  };

  RoomEngine.prototype.playerDisconnected = function (connId) {
    const room = this.room;
    if (!room) return;
    const player = room.players[connId];
    if (!player || !player.token) return;
    player.connected = false;
    delete room.players[connId];
    player.id = null;
    this.broadcastState();
    this.clearPlayerTimer(player);
    const self = this;
    player.disconnectTimer = setTimeout(() => {
      if (!self.room) return;
      const p = self.room.playersByToken[player.token];
      if (!p || p.connected) return;
      self.removePlayer(p);
      self.broadcastState();
      if (self.room.gameState === 'playing') self.checkForWinner();
    }, PLAYER_GRACE_MS);
  };

  function peerIdFor(code) {
    return PEER_PREFIX + String(code).toUpperCase();
  }

  function startPeerHost(sock, preferredCode) {
    if (typeof Peer !== 'function') {
      sock._in('connect_error', { message: 'PeerJS failed to load.' });
      return;
    }

    const conns = new Map();
    let engine = null;
    let peer = null;
    let creating = false;

    function send(event, data, targetId) {
      if (targetId == null || targetId === 'host') sock._in(event, data);
      if (targetId && targetId !== 'host') {
        const c = conns.get(targetId);
        if (c && c.open) c.send({ e: event, d: data });
        return;
      }
      if (targetId == null) {
        conns.forEach((c) => {
          if (c.open) c.send({ e: event, d: data });
        });
      }
    }

    function attachConn(conn) {
      const connId = conn.peer;
      conns.set(connId, conn);
      conn.on('data', (msg) => {
        if (!msg || !engine) return;
        engine.handlePlayer(connId, msg.e, msg.d, conn);
      });
      conn.on('close', () => {
        conns.delete(connId);
        if (engine) engine.playerDisconnected(connId);
      });
      conn.on('error', () => {
        conns.delete(connId);
        if (engine) engine.playerDisconnected(connId);
      });
    }

    function openPeer(code, targetScore, isReclaim) {
      if (creating) return;
      creating = true;
      const id = peerIdFor(code);
      peer = new Peer(id);
      const failTimer = setTimeout(() => {
        sock._in('connect_error', { message: 'Could not create a room. Reload and try again.' });
      }, 12000);
      peer.on('open', () => {
        clearTimeout(failTimer);
        creating = false;
        engine = new RoomEngine(send);
        if (isReclaim) {
          engine.create(targetScore);
          engine.room.code = code;
        } else {
          engine.create(targetScore);
          engine.room.code = code;
        }
        sock.connected = true;
        sock.p2p = true;
        sock._in('roomCreated', {
          code: engine.room.code,
          hostToken: engine.room.hostToken,
          targetScore: engine.room.targetScore,
          p2p: true,
          reclaimed: !!isReclaim
        });
        engine.broadcastState();
      });
      peer.on('connection', (conn) => {
        conn.on('open', () => attachConn(conn));
        if (conn.open) attachConn(conn);
      });
      peer.on('error', (err) => {
        clearTimeout(failTimer);
        if (err && err.type === 'unavailable-id') {
          creating = false;
          try { peer.destroy(); } catch (e) {}
          openPeer(generateRoomCode(), targetScore, false);
          return;
        }
        creating = false;
        sock._in('connect_error', { message: (err && err.message) || 'Could not create a room.' });
      });
    }

    sock.emit = function (ev, data) {
      if (ev === 'createRoom') {
        openPeer(generateRoomCode(), data && data.targetScore, false);
        return;
      }
      if (ev === 'reclaimHost') {
        const code = data && data.code;
        if (code) openPeer(String(code).toUpperCase(), data && data.targetScore, true);
        else openPeer(generateRoomCode(), data && data.targetScore, false);
        return;
      }
      if (engine) engine.handleHost(ev, data);
    };

    sock._in('connect');
  }

  function startPeerPlayer(sock) {
    if (typeof Peer !== 'function') {
      sock._in('connect_error', { message: 'PeerJS failed to load.' });
      return;
    }

    let peer = null;
    let conn = null;
    const pending = [];

    function ensurePeer() {
      return new Promise((resolve, reject) => {
        if (peer && peer.id) return resolve(peer);
        peer = new Peer();
        const t = setTimeout(() => reject(new Error('timeout')), 12000);
        peer.on('open', (id) => {
          clearTimeout(t);
          sock.id = id;
          sock.connected = true;
          resolve(peer);
        });
        peer.on('error', (err) => {
          clearTimeout(t);
          reject(err);
        });
      });
    }

    async function connectToHost(ev, data) {
      const code = (data && data.code || '').toUpperCase();
      try {
        await ensurePeer();
      } catch (e) {
        sock._in('joinError', { message: 'Could not reach the room service. Check your network.' });
        return;
      }
      if (conn) {
        try { conn.close(); } catch (e) {}
        conn = null;
      }
      conn = peer.connect(peerIdFor(code), { reliable: true });
      const t = setTimeout(() => {
        sock._in('joinError', { message: 'Room not found. Check the code and that the host tab is still open.' });
      }, 8000);
      conn.on('open', () => {
        clearTimeout(t);
        conn.send({ e: ev, d: data });
        pending.forEach((item) => conn.send({ e: item[0], d: item[1] }));
        pending.length = 0;
      });
      conn.on('data', (msg) => {
        if (msg && msg.e) sock._in(msg.e, msg.d);
      });
      conn.on('close', () => {
        sock.connected = false;
        sock._in('disconnect');
      });
      peer.on('error', (err) => {
        clearTimeout(t);
        if (err && err.type === 'peer-unavailable') {
          sock._in('joinError', { message: 'Room not found. Check the code and that the host tab is still open.' });
        }
      });
    }

    sock.emit = function (ev, data) {
      if (ev === 'joinRoom' || ev === 'rejoinRoom') {
        connectToHost(ev, data);
        return;
      }
      if (conn && conn.open) conn.send({ e: ev, d: data });
      else pending.push([ev, data]);
    };

    sock.p2p = true;
    sock.connected = true;
    sock._in('connect');
  }

  global.JuostNet = {
    connect: function (opts) {
      const sock = new FakeSocket();
      const role = (opts && opts.role) || 'player';
      (async function () {
        const ioSock = await trySocketIO(2500);
        if (ioSock) {
          bindIoSocket(sock, ioSock);
          return;
        }
        if (role === 'host') startPeerHost(sock);
        else startPeerPlayer(sock);
      })();
      return sock;
    }
  };
})(window);
