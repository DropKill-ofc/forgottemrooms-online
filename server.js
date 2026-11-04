'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024,
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = Number(process.env.PORT) || 10000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'FORGOTTENROOMS', rooms: rooms.size }));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

function cleanText(value, maxLength, fallback = '') {
  return String(value ?? '')
    .replace(/[<>\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength) || fallback;
}

function makeRoomCode() {
  let code;
  do {
    const bytes = crypto.randomBytes(6);
    code = [...bytes].map(byte => ROOM_ALPHABET[byte & 31]).join('');
  } while (rooms.has(code));
  return code;
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, 32);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function passwordMatches(password, room) {
  try {
    const salt = Buffer.from(room.passwordSalt, 'hex');
    const expected = Buffer.from(room.passwordHash, 'hex');
    const actual = crypto.scryptSync(password, salt, 32);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function roomFor(socket) {
  const id = socket.data.roomId;
  return id ? rooms.get(id) : null;
}

function publicRoom(room, socketId) {
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    started: room.started,
    level: room.level,
    selfId: socketId,
    players: [...room.players.values()].map(player => ({
      id: player.id,
      name: player.name,
      seat: player.seat
    }))
  };
}

function emitRoom(room) {
  for (const player of room.players.values()) {
    io.to(player.id).emit('room:state', publicRoom(room, player.id));
  }
}

function sendError(socket, ack, message) {
  const result = { ok: false, message };
  if (typeof ack === 'function') ack(result);
  socket.emit('room:error', result);
}

function detachPlayer(socket, reason = 'left') {
  const room = roomFor(socket);
  if (!room) {
    socket.data.roomId = null;
    return;
  }

  room.players.delete(socket.id);
  socket.leave(room.id);
  socket.data.roomId = null;
  socket.data.lastStateAt = 0;

  if (room.players.size === 0) {
    rooms.delete(room.id);
    return;
  }

  if (!room.players.has(room.hostId)) {
    const nextHost = room.players.values().next().value;
    room.hostId = nextHost.id;
  }

  io.to(room.id).emit('player:left', { id: socket.id, reason });
  emitRoom(room);
}

io.on('connection', socket => {
  socket.data.roomId = null;
  socket.data.lastStateAt = 0;
  socket.data.lastJoinAttemptAt = 0;

  socket.on('room:create', (payload = {}, ack) => {
    if (roomFor(socket)) return sendError(socket, ack, 'Você já está em uma sala.');

    const now = Date.now();
    if (now - socket.data.lastJoinAttemptAt < 700) return sendError(socket, ack, 'Aguarde um instante e tente novamente.');
    socket.data.lastJoinAttemptAt = now;

    const playerName = cleanText(payload.playerName, 18);
    const roomName = cleanText(payload.roomName, 28);
    const password = String(payload.password ?? '');
    if (playerName.length < 2) return sendError(socket, ack, 'Seu nome precisa ter pelo menos 2 caracteres.');
    if (roomName.length < 2) return sendError(socket, ack, 'O nome da sala precisa ter pelo menos 2 caracteres.');
    if (password.length < 4 || password.length > 32) return sendError(socket, ack, 'A senha deve ter entre 4 e 32 caracteres.');

    const id = makeRoomCode();
    const pass = hashPassword(password);
    const room = {
      id,
      name: roomName,
      passwordSalt: pass.salt,
      passwordHash: pass.hash,
      hostId: socket.id,
      started: false,
      level: 0,
      players: new Map()
    };
    room.players.set(socket.id, { id: socket.id, name: playerName, seat: 0, state: null });
    rooms.set(id, room);
    socket.join(id);
    socket.data.roomId = id;

    const state = publicRoom(room, socket.id);
    if (typeof ack === 'function') ack({ ok: true, room: state });
    emitRoom(room);
  });

  socket.on('room:join', (payload = {}, ack) => {
    if (roomFor(socket)) return sendError(socket, ack, 'Você já está em uma sala.');

    const now = Date.now();
    if (now - socket.data.lastJoinAttemptAt < 700) return sendError(socket, ack, 'Aguarde um instante e tente novamente.');
    socket.data.lastJoinAttemptAt = now;

    const id = cleanText(payload.roomId, 6).toUpperCase();
    const playerName = cleanText(payload.playerName, 18);
    const password = String(payload.password ?? '');
    const room = rooms.get(id);
    if (playerName.length < 2) return sendError(socket, ack, 'Seu nome precisa ter pelo menos 2 caracteres.');
    if (!room) return sendError(socket, ack, 'Sala não encontrada. Confira o código.');
    if (!passwordMatches(password, room)) return sendError(socket, ack, 'Senha incorreta.');
    if (room.players.size >= 2) return sendError(socket, ack, 'Essa sala já está cheia.');

    const occupiedSeats = new Set([...room.players.values()].map(player => player.seat));
    const seat = [0, 1].find(value => !occupiedSeats.has(value));
    room.players.set(socket.id, { id: socket.id, name: playerName, seat, state: null });
    socket.join(id);
    socket.data.roomId = id;

    const state = publicRoom(room, socket.id);
    if (typeof ack === 'function') ack({ ok: true, room: state });
    emitRoom(room);

    if (room.started) {
      socket.emit('game:start', { level: room.level, seat });
    }
  });

  socket.on('room:start', (_payload = {}, ack) => {
    const room = roomFor(socket);
    if (!room) return sendError(socket, ack, 'Você não está em uma sala.');
    if (room.hostId !== socket.id) return sendError(socket, ack, 'Somente quem criou a sala pode iniciar.');
    if (room.players.size !== 2) return sendError(socket, ack, 'É necessário ter 2 jogadores na sala.');
    if (room.started) return sendError(socket, ack, 'A partida já foi iniciada.');

    room.started = true;
    room.level = 0;
    if (typeof ack === 'function') ack({ ok: true });
    emitRoom(room);
    io.to(room.id).emit('game:start', { level: 0 });
  });

  socket.on('player:state', state => {
    const room = roomFor(socket);
    if (!room || !room.started || !state || typeof state !== 'object') return;
    const player = room.players.get(socket.id);
    if (!player) return;

    const now = Date.now();
    if (now - socket.data.lastStateAt < 45) return;
    socket.data.lastStateAt = now;

    const number = (value, min, max, fallback = 0) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    };
    const safeState = {
      x: number(state.x, -400, 400),
      z: number(state.z, -400, 400),
      yaw: number(state.yaw, -100, 100),
      pitch: number(state.pitch, -1.7, 1.7),
      moving: Boolean(state.moving),
      crouch: Boolean(state.crouch)
    };
    player.state = safeState;
    socket.to(room.id).emit('player:state', {
      id: socket.id,
      name: player.name,
      seat: player.seat,
      ...safeState,
      sentAt: now
    });
  });

  socket.on('game:advance', payload => {
    const room = roomFor(socket);
    if (!room || !room.started) return;
    const nextLevel = Number(payload?.level);
    if (!Number.isInteger(nextLevel) || nextLevel < 1 || nextLevel > 6) return;
    if (nextLevel !== room.level + 1) return;
    room.level = nextLevel;
    io.to(room.id).emit('game:level', { level: nextLevel });
  });

  socket.on('room:leave', () => detachPlayer(socket, 'left'));
  socket.on('disconnect', () => detachPlayer(socket, 'disconnected'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`FORGOTTENROOMS online ativo na porta ${PORT}`);
});
