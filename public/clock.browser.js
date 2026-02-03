// Browser-friendly version of server/src/game/clock.js
// Exposes `window.MatchClock`.
 
(function () {
  class MatchClock {
    constructor({ initialMs }) {
      this.initialMs = initialMs;
      this.remaining = { w: initialMs, b: initialMs };
      this.activeColor = 'w';
      this.running = false;
      this.lastTs = null;
    }
 
    start(now = Date.now()) {
      if (this.running) return;
      this.running = true;
      this.lastTs = now;
    }
 
    pause(now = Date.now()) {
      this._tick(now);
      this.running = false;
      this.lastTs = null;
    }
 
    switchTurn(nextColor, now = Date.now()) {
      this._tick(now);
      this.activeColor = nextColor;
      this.lastTs = now;
    }
 
    _tick(now) {
      if (!this.running || this.lastTs === null) return;
      const dt = Math.max(0, now - this.lastTs);
      this.remaining[this.activeColor] = Math.max(0, this.remaining[this.activeColor] - dt);
      this.lastTs = now;
    }
 
    snapshot(now = Date.now()) {
      this._tick(now);
      return {
        remainingMs: { ...this.remaining },
        activeColor: this.activeColor,
        running: this.running
      };
    }
 
	setFromSnapshot({ remainingMs, activeColor }, now = Date.now()) {
	  this.remaining = { ...remainingMs };
	  this.activeColor = activeColor;
	  this.running = true;
	  this.lastTs = now;
	}
 
 
    isFlagged(now = Date.now()) {
      this._tick(now);
      if (this.remaining.w <= 0) return 'w';
      if (this.remaining.b <= 0) return 'b';
      return null;
    }
  }
 
  window.MatchClock = MatchClock;
})();