export async function createStockfish() {
  const worker = new Worker('/stockfish/stockfish-17.1-lite-single-03e3232.js');
 
  function send(cmd) { worker.postMessage(cmd); }
 
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Stockfish init timeout')), 5000);
    worker.onmessage = (e) => {
      const line = String(e.data || '');
      if (line === 'uciok') {
        // wait for readyok too
        send('isready');
      }
      if (line === 'readyok') {
        clearTimeout(t);
        resolve();
      }
    };
    send('uci');
  });
 
  async function bestmove(fen, movetimeMs = 200) {
    send(`position fen ${fen}`);
    send(`go movetime ${movetimeMs}`);
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bestmove timeout')), 8000);
      const prev = worker.onmessage;
      worker.onmessage = (e) => {
        const line = String(e.data || '');
        if (line.startsWith('bestmove ')) {
          clearTimeout(t);
          worker.onmessage = prev;
          resolve(line.split(' ')[1]); // e2e4
        } else if (prev) {
          prev(e);
        }
      };
    });
  }
 
  return { bestmove, stop: () => worker.terminate() };
}