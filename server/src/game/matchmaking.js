import { makeId, nowMs } from '../db/db.js';

class Matchmaker {
  constructor() {
    this.queueSolo = []; // { socketId, userId }
    this.queueTeam = [];
  }

  enqueue({ mode, socketId, userId }) {
    const entry = { socketId, userId, queuedAt: nowMs() };
    if (mode === 'solo') this.queueSolo.push(entry);
    else this.queueTeam.push(entry);
  }

  dequeueSocket(socketId) {
    this.queueSolo = this.queueSolo.filter((e) => e.socketId !== socketId);
    this.queueTeam = this.queueTeam.filter((e) => e.socketId !== socketId);
  }

  tryMatch(mode) {
    if (mode === 'solo') {
      if (this.queueSolo.length < 2) return null;
      const p1 = this.queueSolo.shift();
      const p2 = this.queueSolo.shift();
      return {
        matchId: makeId('m_'),
        mode: 'solo',
        players: [p1, p2]
      };
    }

    if (this.queueTeam.length < 6) return null;
    const picked = this.queueTeam.splice(0, 6);
    return {
      matchId: makeId('m_'),
      mode: 'team',
      players: picked
    };
  }
}

export { Matchmaker };
export default Matchmaker;