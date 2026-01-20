// You provide this file:
importScripts('./vendor/stockfish/stockfish-17.1-lite-single-03e3232.js');
 
// Different builds expose different APIs. One common one:
const engine = self.Stockfish ? self.Stockfish() : self.STOCKFISH ? self.STOCKFISH() : null;
if (!engine) throw new Error('Stockfish engine not found in this build.');
 
engine.onmessage = (e) => postMessage(typeof e === 'string' ? e : e.data);
onmessage = (e) => engine.postMessage(e.data);