import { TimeShiftEngine } from './timeShiftEngine.js';
import { MatchClock } from './clock.js';
import { makeId, nowMs } from '../db/db.js';

function computeEloDelta({ playerRating, opponentRating, score, k = 24 }) {
  // score: 1 win, 0 draw, -1 loss -> map to 1/0.5/0
  const s = score === 1 ? 1 : score === 0 ? 0.5 : 0;
  const expected = 1 / (1 + 10 ** ((opponentRating - playerRating) / 400));
  return Math.round(k * (s - expected));
}

export class GameManager {
  constructor({ db }) {
    this.db = db;
    this.matches = new Map(); // matchId -> match
  }

  createMatch({ matchId, mode, timeControlMs, participants }) {
    // participants: [{ socketId, userId }]

    // Assign colors randomly per match.
    const shuffled = [...participants].sort(() => Math.random() - 0.5);
    const assignments = [];

    if (mode === 'solo') {
      const white = shuffled[0];
      const black = shuffled[1];
      assignments.push({ ...white, color: 'w', boardRole: null });
      assignments.push({ ...black, color: 'b', boardRole: null });
    } else {
      // 3v3: first three are White team (board 1/2/3), next three are Black team.
      const whiteTeam = shuffled.slice(0, 3);
      const blackTeam = shuffled.slice(3, 6);
      for (let i = 0; i < 3; i++) {
        assignments.push({ ...whiteTeam[i], color: 'w', boardRole: i + 1 });
        assignments.push({ ...blackTeam[i], color: 'b', boardRole: i + 1 });
      }
    }

    const engine = new TimeShiftEngine();
    const clock = new MatchClock({ initialMs: timeControlMs });
    clock.start();

    const match = {
      id: matchId ?? makeId('m_'),
      mode,
      timeControlMs,
      createdAt: nowMs(),
      endedAt: null,
      result: null, // 'w'|'b'|'draw'
      termination: null,
      engine,
      clock,
      assignments,
      sockets: new Set(assignments.map((a) => a.socketId))
    };

    // persist match + players
    const insertMatch = this.db.prepare(
      `INSERT INTO matches (id, mode, time_control_ms, created_at) VALUES (?, ?, ?, ?)`
    );
    const insertPlayer = this.db.prepare(
      `INSERT INTO match_players (match_id, user_id, color, board_role, team_index) VALUES (?, ?, ?, ?, ?)`
    );

    const tx = this.db.transaction(() => {
      insertMatch.run(match.id, match.mode, match.timeControlMs, match.createdAt);
      for (const a of assignments) {
        insertPlayer.run(match.id, a.userId, a.color, a.boardRole, a.color === 'w' ? 1 : 2);
      }
    });
    tx();

    this.matches.set(match.id, match);
    return match;
  }

  getMatch(matchId) {
    return this.matches.get(matchId) || null;
  }

  findMatchBySocket(socketId) {
    for (const m of this.matches.values()) {
      if (m.sockets.has(socketId)) return m;
    }
    return null;
  }

  getPlayerAssignment(match, socketId) {
    return match.assignments.find((a) => a.socketId === socketId) || null;
  }

  canMove({ match, socketId, boardIndex }) {
    const a = this.getPlayerAssignment(match, socketId);
    if (!a) return false;

    // must match current turn color
    if (a.color !== match.engine.currentTurn.color) return false;

    if (match.mode === 'solo') return true;

    // team mode: must control the current active board
    return a.boardRole === boardIndex;
  }

  finishMatch({ match, result, termination }) {
    if (match.endedAt) return match;
    match.endedAt = nowMs();
    match.result = result;
    match.termination = termination;
    match.clock.pause();

    // Update match row
    this.db
      .prepare(`UPDATE matches SET ended_at = ?, result = ?, termination = ? WHERE id = ?`)
      .run(match.endedAt, result === 'draw' ? 'draw' : result === 'w' ? 'white' : 'black', termination, match.id);

    // Elo: simple head-to-head by color average (team) or direct (solo).
    const users = this.db
      .prepare(`SELECT id, rating FROM users WHERE id IN (${match.assignments.map(() => '?').join(',')})`)
      .all(...match.assignments.map((a) => a.userId));
    const ratingByUserId = new Map(users.map((u) => [u.id, u.rating]));

    const whiteIds = match.assignments.filter((a) => a.color === 'w').map((a) => a.userId);
    const blackIds = match.assignments.filter((a) => a.color === 'b').map((a) => a.userId);

    const avg = (ids) => Math.round(ids.reduce((s, id) => s + (ratingByUserId.get(id) ?? 1200), 0) / ids.length);
    const whiteAvg = avg(whiteIds);
    const blackAvg = avg(blackIds);

    const scoreW = result === 'w' ? 1 : result === 'draw' ? 0 : -1;
    const scoreB = -scoreW;

    const updateUser = this.db.prepare(`UPDATE users SET rating = ? WHERE id = ?`);
    const insertHist = this.db.prepare(
      `INSERT INTO rating_history (id, user_id, match_id, old_rating, new_rating, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    );

    const tx = this.db.transaction(() => {
      for (const a of match.assignments) {
        const oldR = ratingByUserId.get(a.userId) ?? 1200;
        const delta = computeEloDelta({
          playerRating: oldR,
          opponentRating: a.color === 'w' ? blackAvg : whiteAvg,
          score: a.color === 'w' ? scoreW : scoreB
        });
        const newR = oldR + delta;
        updateUser.run(newR, a.userId);
        insertHist.run(makeId('rh_'), a.userId, match.id, oldR, newR, nowMs());
      }
    });
    tx();

    return match;
  }
}