import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import helmet from 'helmet';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';

import { openDb, makeId, nowMs } from './db/db.js';
import { signJwt, verifyJwt, getBearerToken } from './auth.js';
import * as matchmakingModule from './game/matchmaking.js';
import { GameManager } from './game/gameManager.js';

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || './data.sqlite3';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

const db = openDb(DB_PATH);
const Matchmaker =
  matchmakingModule.Matchmaker ??
  matchmakingModule.default ??
  matchmakingModule.default?.Matchmaker;
if (!Matchmaker) {
  throw new Error('Failed to load Matchmaker from ./game/matchmaking.js');
}
const matchmaker = new Matchmaker();
const gameManager = new GameManager({ db });

// -----------------------------
// REST: auth + profile
// -----------------------------

const registerSchema = z.object({
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(6).max(200)
});

function bcryptHash(password, saltRounds = 10) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(password, saltRounds, (err, hash) => (err ? reject(err) : resolve(hash)));
  });
}
 
function bcryptCompare(password, passwordHash) {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, passwordHash, (err, same) => (err ? reject(err) : resolve(same)));
  });
}


app.post('/api/register', async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
 
    const { username, password } = parsed.data;
    const passwordHash = await bcryptHash(password, 10);
 
    const id = makeId('u_');
    try {
      db.prepare(
        `INSERT INTO users (id, username, password_hash, rating, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(id, username, passwordHash, 1200, nowMs());
    } catch (e) {
      return res.status(409).json({ error: 'username_taken' });
    }
 
    const token = signJwt({ userId: id, username }, JWT_SECRET);
    return res.json({ token, user: { id, username, rating: 1200 } });
  } catch (e) {
    console.error('REGISTER_FAILED', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

app.post('/api/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });

  const { username, password } = parsed.data;
  const user = db.prepare(`SELECT id, username, password_hash, rating FROM users WHERE username = ?`).get(username);
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  //const ok = await bcrypt.compare(password, user.password_hash);
  const ok = await bcryptCompare(password, user.password_hash);
  
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const token = signJwt({ userId: user.id, username: user.username }, JWT_SECRET);
  res.json({ token, user: { id: user.id, username: user.username, rating: user.rating } });
});

app.get('/api/me', (req, res) => {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  let decoded;
  try {
    decoded = verifyJwt(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const user = db.prepare(`SELECT id, username, rating FROM users WHERE id = ?`).get(decoded.sub);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  res.json({ user });
});

// serve client (cross-platform safe path resolution)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
//const publicDir = path.resolve(__dirname, '..', '..', '..', 'public');
//const publicDir = path.resolve(__dirname, '..', '..', 'public');

const projectRootDir = path.resolve(__dirname, '..', '..'); // adjust if needed
const publicDir = path.join(projectRootDir, 'public');

app.use('/img', express.static(path.join(projectRootDir, 'img')));

app.use(express.static(publicDir));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

function authSocket(socket) {
  const token = socket.handshake.auth?.token;
  if (!token) return null;
  try {
    const decoded = verifyJwt(token, JWT_SECRET);
    const user = db.prepare(`SELECT id, username, rating FROM users WHERE id = ?`).get(decoded.sub);
    if (!user) return null;
    return user;
  } catch {
    return null;
  }
}

function emitMatchState(match) {
  const payload = {
    matchId: match.id,
    mode: match.mode,
    timeControlMs: match.timeControlMs,
    endedAt: match.endedAt,
    result: match.result,
    termination: match.termination,
    engine: match.engine.serialize(),
    clock: match.clock.snapshot(),
    assignments: match.assignments.map((a) => ({
      userId: a.userId,
      socketId: a.socketId,
      color: a.color,
      boardRole: a.boardRole
    }))
  };
  io.to(match.id).emit('match_state', payload);
}

// tick clocks and handle timeouts
setInterval(() => {
  for (const match of gameManager.matches.values()) {
    if (match.endedAt) continue;
    const flagged = match.clock.isFlagged();
    if (flagged) {
      const winner = flagged === 'w' ? 'b' : 'w';
      gameManager.finishMatch({ match, result: winner, termination: 'timeout' });
    }
    emitMatchState(match);
  }
}, 1000);

io.on('connection', (socket) => {
  const user = authSocket(socket);
  if (!user) {
    socket.emit('fatal', { error: 'unauthorized' });
    socket.disconnect(true);
    return;
  }

  socket.emit('hello', { user });

  socket.on('queue_join', (msg) => {
    const schema = z.object({
      mode: z.enum(['solo', 'team']),
      timeControl: z.enum(['180', '600']) // seconds
    });
    const parsed = schema.safeParse(msg);
    if (!parsed.success) return;

    const { mode, timeControl } = parsed.data;
    matchmaker.dequeueSocket(socket.id);
    matchmaker.enqueue({ mode, socketId: socket.id, userId: user.id });

    // try to match
    const matchInfo = matchmaker.tryMatch(mode);
    if (!matchInfo) {
      socket.emit('queue_status', { status: 'queued', mode });
      return;
    }

    const timeControlMs = Number(timeControl) * 1000;
    const match = gameManager.createMatch({
      matchId: matchInfo.matchId,
      mode: matchInfo.mode,
      timeControlMs,
      participants: matchInfo.players
    });

    for (const a of match.assignments) {
      const s = io.sockets.sockets.get(a.socketId);
      if (!s) continue;
      s.join(match.id);
      s.emit('queue_status', { status: 'matched', matchId: match.id });
    }

    emitMatchState(match);
  });

  socket.on('queue_leave', () => {
    matchmaker.dequeueSocket(socket.id);
    socket.emit('queue_status', { status: 'idle' });
  });

/*
  socket.on('move_attempt', (msg) => {
	  try{
		const schema = z.object({
		  matchId: z.string().min(1),
		  boardIndex: z.number().int().min(1).max(3),
		  from: z.string().min(2).max(2),
		  to: z.string().min(2).max(2),
		  promotion: z.string().optional()
		});
		
		const parsed = schema.safeParse(msg);
		
		if (!parsed.success) return;

		const { matchId, boardIndex, from, to, promotion } = parsed.data;

		console.log('MOVE_ATTEMPT 1', { user: user.username, matchId, boardIndex, from, to });

		const match = gameManager.getMatch(matchId);
		
		console.log('MOVE_ATTEMPT 2', { user: user.username, matchId, boardIndex, from, to });
		
		if (!match || match.endedAt) return;

		if (!gameManager.canMove({ match, socketId: socket.id, boardIndex })) {
		  socket.emit('move_rejected', { reason: 'not_allowed' });
	  return;}}
	  catch (e) {
		console.error('MOVE_ATTEMPT_HANDLER_FAILED', e);
		socket.emit('move_rejected', { reason: 'server_error' });
		}
	});
*/


  socket.on('move_attempt', (msg) => {
  try {
    const schema = z.object({
      matchId: z.string().min(1),
      boardIndex: z.number().int().min(1).max(3),
      from: z.string().min(2).max(2),
      to: z.string().min(2).max(2),
      promotion: z.string().optional()
    });
 
    const parsed = schema.safeParse(msg);
    if (!parsed.success) return;
 
    const { matchId, boardIndex, from, to, promotion } = parsed.data;
 
    console.log('MOVE_ATTEMPT', { user: user.username, matchId, boardIndex, from, to });
 
    const match = gameManager.getMatch(matchId);
    if (!match || match.endedAt) return;
 
    if (!gameManager.canMove({ match, socketId: socket.id, boardIndex })) {
      socket.emit('move_rejected', { reason: 'not_allowed' });
      return;
    }
 
    // ensure clock active color matches engine turn
    match.clock.activeColor = match.engine.currentTurn.color;
 
    const result = match.engine.applyMove({ boardIndex, from, to, promotion: promotion ?? 'q' });
    if (!result.ok) {
      socket.emit('move_rejected', { reason: result.reason });
      return;
    }
 
    // switch clock to next turn
    match.clock.switchTurn(match.engine.currentTurn.color);
 
    if (result.matchResult) {
      if (result.matchResult === 'draw') {
        gameManager.finishMatch({ match, result: 'draw', termination: 'checkmate' });
      } else {
        gameManager.finishMatch({ match, result: result.matchResult, termination: 'checkmate' });
      }
    }
 
    emitMatchState(match);
  } catch (e) {
    console.error('MOVE_ATTEMPT_HANDLER_FAILED', e);
    socket.emit('move_rejected', { reason: 'server_error' });
  }
});

  socket.on('resign', (msg) => {
    const schema = z.object({ matchId: z.string().min(1) });
    const parsed = schema.safeParse(msg);
    if (!parsed.success) return;

    const match = gameManager.getMatch(parsed.data.matchId);
    if (!match || match.endedAt) return;

    const a = gameManager.getPlayerAssignment(match, socket.id);
    if (!a) return;

    // resigning loses the whole match
    const winner = a.color === 'w' ? 'b' : 'w';
    gameManager.finishMatch({ match, result: winner, termination: 'resign' });
    emitMatchState(match);
  });

  socket.on('disconnect', () => {
    matchmaker.dequeueSocket(socket.id);
    // For MVP: treat disconnect as resign if in active match.
    const match = gameManager.findMatchBySocket(socket.id);
    if (match && !match.endedAt) {
      const a = gameManager.getPlayerAssignment(match, socket.id);
      if (a) {
        const winner = a.color === 'w' ? 'b' : 'w';
        gameManager.finishMatch({ match, result: winner, termination: 'resign' });
        emitMatchState(match);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});