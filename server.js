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

function makeTeamState(level = 0) {
  return { level, collected: [], fuseBag: [], sockets: [-1, -1, -1, -1] };
}

function emitTeamState(room) {
  if (!room || !room.team) return;
  io.to(room.id).emit('team:state', room.team);
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
      team: makeTeamState(0),
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
      socket.emit('team:state', room.team);
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
    room.team = makeTeamState(0);
    if (typeof ack === 'function') ack({ ok: true });
    emitRoom(room);
    io.to(room.id).emit('game:start', { level: 0 });
    emitTeamState(room);
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
      crouch: Boolean(state.crouch),
      running: Boolean(state.running),
      action: ['pickup', 'interact'].includes(state.action) ? state.action : 'idle',
      actionSeq: number(state.actionSeq, 0, 2147483647)
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

  socket.on('team:request', () => {
    const room = roomFor(socket);
    if (!room || !room.started || !room.team) return;
    socket.emit('team:state', room.team);
  });

  socket.on('team:fuse', (payload = {}, ack) => {
    const room = roomFor(socket);
    if (!room || !room.started || room.level !== 0 || !room.team || room.team.level !== 0) {
      return sendError(socket, ack, 'O objetivo compartilhado não está disponível neste nível.');
    }
    const now = Date.now();
    if (now - (socket.data.lastTeamActionAt || 0) < 180) {
      return sendError(socket, ack, 'Aguarde um instante antes de interagir novamente.');
    }
    socket.data.lastTeamActionAt = now;
    const action = String(payload.action || '');
    const fuseIndex = Number(payload.fuseIndex);
    const socketIndex = Number(payload.socketIndex);
    if (action === 'collect') {
      const itemId = cleanText(payload.itemId, 20);
      if (!/^F\d{1,2}_\d{1,2}$/.test(itemId) || !Number.isInteger(fuseIndex) || fuseIndex < 0 || fuseIndex > 3) {
        return sendError(socket, ack, 'Fusível inválido.');
      }
      if (room.team.collected.includes(itemId)) {
        if (typeof ack === 'function') ack({ ok: false, message: 'Esse fusível já foi recolhido pela equipe.' });
        return;
      }
      if (room.team.fuseBag.length >= 4 || room.team.fuseBag.includes(fuseIndex)) {
        return sendError(socket, ack, 'A equipe já possui esse fusível.');
      }
      room.team.collected.push(itemId);
      room.team.fuseBag.push(fuseIndex);
    } else if (action === 'insert') {
      if (!Number.isInteger(socketIndex) || socketIndex < 0 || socketIndex > 3 || !Number.isInteger(fuseIndex) || fuseIndex < 0 || fuseIndex > 3) {
        return sendError(socket, ack, 'Encaixe ou fusível inválido.');
      }
      if (room.team.sockets[socketIndex] !== -1) return sendError(socket, ack, 'Esse encaixe já está ocupado.');
      const bagIndex = room.team.fuseBag.indexOf(fuseIndex);
      if (bagIndex < 0) return sendError(socket, ack, 'A equipe não está carregando esse fusível.');
      room.team.fuseBag.splice(bagIndex, 1);
      room.team.sockets[socketIndex] = fuseIndex;
    } else if (action === 'remove') {
      if (!Number.isInteger(socketIndex) || socketIndex < 0 || socketIndex > 3) return sendError(socket, ack, 'Encaixe inválido.');
      const current = room.team.sockets[socketIndex];
      if (current < 0) return sendError(socket, ack, 'Esse encaixe já está vazio.');
      if (room.team.fuseBag.length >= 4) return sendError(socket, ack, 'A equipe não tem espaço para carregar outro fusível.');
      room.team.sockets[socketIndex] = -1;
      if (!room.team.fuseBag.includes(current)) room.team.fuseBag.push(current);
    } else {
      return sendError(socket, ack, 'Ação de equipe desconhecida.');
    }
    if (typeof ack === 'function') ack({ ok: true, team: room.team });
    emitTeamState(room);
  });

  socket.on('team:chat', (payload = {}, ack) => {
    const room = roomFor(socket);
    if (!room || !room.started) return sendError(socket, ack, 'Entre em uma partida para usar o chat.');
    const now = Date.now();
    if (now - (socket.data.lastChatAt || 0) < 650) return sendError(socket, ack, 'Espere um instante para enviar outra mensagem.');
    socket.data.lastChatAt = now;
    const player = room.players.get(socket.id);
    const message = cleanText(payload.message, 140);
    if (!message) return sendError(socket, ack, 'Digite uma mensagem antes de enviar.');
    const data = { id: socket.id, name: player ? player.name : 'JOGADOR', message, sentAt: now };
    if (typeof ack === 'function') ack({ ok: true });
    io.to(room.id).emit('team:chat', data);
  });

  socket.on('game:advance', payload => {
    const room = roomFor(socket);
    if (!room || !room.started) return;
    const nextLevel = Number(payload?.level);
    if (!Number.isInteger(nextLevel) || nextLevel < 1 || nextLevel > 6) return;
    if (nextLevel !== room.level + 1) return;
    room.level = nextLevel;
    room.team = makeTeamState(nextLevel);
    io.to(room.id).emit('game:level', { level: nextLevel });
    emitTeamState(room);
  });

  socket.on('room:leave', () => detachPlayer(socket, 'left'));
  socket.on('disconnect', () => detachPlayer(socket, 'disconnected'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`FORGOTTENROOMS online ativo na porta ${PORT}`);
});
