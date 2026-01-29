const SUPABASE_URL = window.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';

const supabaseClient  =
  typeof window.supabase?.createClient === 'function'
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
 
window.sb = supabaseClient;
 
let isSubmittingMove = false;
 
let profile = null; // { id, username, rating }
let currentMatchId = null;
let currentAssignment = null; // { color, boardRole }
 
let engine = null; // TimeShiftEngine
let clock = null; // MatchClock
let matchMeta = null; // matches row
 
let boards = { 1: null, 2: null, 3: null };
let matchPlayersByUserId = new Map();
let lastAppliedMoveId = 0;
 
let queueChannel = null;
let matchMovesChannel = null;
let matchRowChannel = null;
 
let queuePollTimer = null; 
let clockUiTimer = null;

let movesPollTimer = null;

let timeoutCommitted = false;

let localAiEnabled = false;
let aiColor = null;          // 'w' or 'b'
let stockfish = null;

let _lastClockLog = 0;
 
const lastMoveByBoard = { 1: null, 2: null, 3: null };
 
function applyLastMoveHighlight(boardIndex) {
  const root = document.getElementById(`board${boardIndex}`);
  if (!root) return;
 
  // squares are inside an inner div created by chessboard.js
  const scope = root;
 
  scope.querySelectorAll('.last-from, .last-to').forEach(n => {
    n.classList.remove('last-from', 'last-to');
  });
 
  const mv = lastMoveByBoard[boardIndex];
  if (!mv) return;
 
  const fromEl =
    scope.querySelector(`[data-square="${mv.from}"]`) || scope.querySelector(`.square-${mv.from}`);
  const toEl =
    scope.querySelector(`[data-square="${mv.to}"]`) || scope.querySelector(`.square-${mv.to}`);
 
  if (fromEl) fromEl.classList.add('last-from');
  if (toEl) toEl.classList.add('last-to');
}
 
function setLastMove(boardIndex, from, to) {
  lastMoveByBoard[boardIndex] = { from, to };
  // apply now + again after DOM updates
  applyLastMoveHighlight(boardIndex);
  requestAnimationFrame(() => applyLastMoveHighlight(boardIndex));
}
 

 
function uciToMove(uci) {
  if (!uci || uci === '0000') return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' };
} 
 
async function maybeComputerMove() {
	
  /*
  console.log('[AI maybeComputerMove] enter', {
  localAiEnabled,
  aiColor,
  ended: !!matchMeta?.ended_at,
  currentTurn: engine?.currentTurn,
  boardFinished: engine?.serialize?.().boardFinished
  }); 
  */
	
  if (!localAiEnabled || !engine || !clock || matchMeta?.ended_at) return;
  if (engine.currentTurn.color !== aiColor) return;
  if (!stockfish) { setStatus('AI not ready'); return; }
 
  const boardIndex = engine.currentTurn.board;
  const fen = engine.getFen(boardIndex);
 
  setStatus('Computer thinking…');
  try {
	//console.log('[AI think]', { boardIndex, fen });
    const uci = await stockfish.bestmove(fen, 300); // increase if needed
    const mv = uciToMove(uci);
 
    if (!mv) {
      setStatus('Computer has no move.');
      return;
    }
 
    const result = engine.applyMove({ boardIndex, from: mv.from, to: mv.to, promotion: mv.promotion });
    //console.log('[AI move result]', result, { nextTurn: engine.currentTurn });
	if (!result.ok) {
      setStatus(`Computer move failed: ${result.reason}`);
      return;
    }
 
	setLastMove(boardIndex, mv.from, mv.to);
 
    clock.switchTurn(engine.currentTurn.color);
    renderMatchUi();
 
    if (result.matchResult) {
      await commitMatchEnd({ result: result.matchResult, termination: 'checkmate' });
    }
 
    // safety: if engine still says it's AI turn, try again
    if (engine.currentTurn.color === aiColor && !matchMeta?.ended_at) {
      setTimeout(maybeComputerMove, 0);
    }
  } catch (e) {
    console.log('AI_ERROR', e);
    setStatus('Computer error (see console).');
  } finally {
    if (!matchMeta?.ended_at) setStatus('');
  }
}
 
 
function el(id) {
  return document.getElementById(id);
}
 
function setVisible(id, visible) {
  const node = el(id);
  if (!node) return;
  node.classList.toggle('hidden', !visible);
}
 
function fmtMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
 
function setStatus(text) {
  el('gameStatus').textContent = text || '';
}
 
function setQueueStatus(text) {
  el('queueStatus').textContent = text || '';
}
 
function setAuthError(text) {
  el('authError').textContent = text || '';
}
 
function usernameToEmail(usernameRaw) {
  const u = String(usernameRaw || '').trim();
  if (!u) return '';
  // NOTE: This is a placeholder to keep your original username+password UI.
  // In production you likely want real email addresses.
  return `${u.toLowerCase()}@tsc.local`;
}
 
function requireSupabaseConfigured() {
  if (!supabaseClient) throw new Error('Supabase client not loaded');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing Supabase config. Fill public/config.js (SUPABASE_URL, SUPABASE_ANON_KEY).');
  }
}
 
async function loadMyProfile() {
  requireSupabaseConfigured();
  const { data: userData, error: userErr } = await supabaseClient.auth.getUser();
  if (userErr) throw userErr;
  const user = userData.user;
  if (!user) return null;
 
  const { data: p, error: pErr } = await supabaseClient
    .from('profiles')
    .select('id, username, rating')
    .eq('id', user.id)
    .single();
  if (pErr) throw pErr;
  return p;
}
 
async function waitForMyMatch({ timeoutMs = 20000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data, error } = await supabaseClient
      .from('match_players')
      .select('match_id, created_at, matches!inner(ended_at)')
      .eq('user_id', profile.id)
      .is('matches.ended_at', null)
      .order('created_at', { ascending: false })
      .limit(1);
 
    if (!error && data?.[0]?.match_id) return data[0].match_id;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
 
 
function clearRealtime() {
  if (!supabaseClient) return;
  if (queueChannel) supabaseClient.removeChannel(queueChannel);
  if (matchMovesChannel) supabaseClient.removeChannel(matchMovesChannel);
  if (matchRowChannel) supabaseClient.removeChannel(matchRowChannel);
  queueChannel = null;
  matchMovesChannel = null;
  matchRowChannel = null;
}
 
function stopClockUi() {
  if (clockUiTimer) clearInterval(clockUiTimer);
  clockUiTimer = null;
}
 
function startClockUi() {
  
  stopClockUi();
  
  clockUiTimer = setInterval(() => {
    try {
      if (!clock || !matchMeta || matchMeta.ended_at) return;
      renderClocks();
      maybeCommitTimeout();
	  
	  const now = Date.now();
      if (now - _lastClockLog > 1000) {
        _lastClockLog = now;
        //console.log('[CLOCK tick]', clock.snapshot());
      }
	  
	  
	  
    } catch (e) {
      console.log('CLOCK_UI_TICK_ERROR', e);
    }
  }, 250);
}
 
 
 
 
function initBoardsIfNeeded() {
  if (boards[1]) return;
 
  const mk = (idx) =>
    Chessboard(`board${idx}`, {
      draggable: true,
      position: 'start',
      orientation: 'white',
      onDragStart: (source, piece) => canDragPiece(idx, piece),
      onDrop: (source, target, piece) => {
        if (!profile || !currentMatchId || !engine || source === target) return 'snapback';
        if (isSubmittingMove) return 'snapback';
        if (!canDragPiece(idx, pieceFromCode(piece))) return 'snapback';
 
        const result = engine.applyMove({
          boardIndex: idx,
          from: source,
          to: target,
          promotion: 'q'
        });
 
        if (!result.ok) {
          setStatus(`Move rejected: ${result.reason}`);
          return 'snapback';
        }
		
 		setLastMove(idx, source, target);
		
        clock.switchTurn(engine.currentTurn.color);
        renderMatchUi();
 
        isSubmittingMove = true;
        (async () => {
          try {
			 if (!localAiEnabled) {
			  await submitMove({ boardIndex: idx, from: source, to: target, promotion: 'q' });
			}
 
            if (result.matchResult) {
              await commitMatchEnd({ result: result.matchResult, termination: 'checkmate' });
            }
 
            // If local AI mode, let computer respond
            if (localAiEnabled) {
              await maybeComputerMove();
            }
          } finally {
            isSubmittingMove = false;
          }
        })();
 
        return; // keep piece (no snapback)
      }
    });
 
  boards[1] = mk(1);
  boards[2] = mk(2);
  boards[3] = mk(3);
}
 
function pieceFromCode(piece) {
  // chessboard.js gives codes like "wP" (already fine)
  return piece;
}
 
function canDragPiece(boardIndex, piece) {
  if (!engine || !currentAssignment || !matchMeta) return false;
  if (matchMeta.ended_at) return false;
 
  const { board, color } = engine.currentTurn;
  if (board !== boardIndex) return false;
  if (currentAssignment.color !== color) return false;
 
  if (matchMeta.mode === 'team') {
    if (currentAssignment.boardRole !== boardIndex) return false;
  }
 
  const pieceColor = piece?.charAt(0) === 'w' ? 'w' : piece?.charAt(0) === 'b' ? 'b' : null;
  return pieceColor === color;
}
 
function renderTurnIndicators() {
  const snapshot = engine.serialize();
  const boardFinished = snapshot.boardFinished;
  const boardResults = snapshot.boardResults;
 
  for (let i = 1; i <= 3; i++) {
    const wrap = document.querySelector(`#board${i}`).closest('.boardWrap');
    wrap.classList.toggle('active', engine.currentTurn.board === i && !boardFinished[i]);
    wrap.classList.toggle('finished', !!boardFinished[i]);
 
    const ind = el(`turn${i}`);
    if (boardFinished[i]) {
      ind.textContent = `Finished (${boardResults[i]} wins)`;
	  //console.log(`boardFinished, ${boardResults[i]} wins`);
    } else if (engine.currentTurn.board === i) {
      ind.textContent = `Active: ${engine.currentTurn.color === 'w' ? 'White' : 'Black'} to move`;
    } else {
      ind.textContent = 'Inactive';
    }
  }
}
 
function renderClocks() {
  if (!clock) return;
  const snap = clock.snapshot();
  el('clockWhite').textContent = `White: ${fmtMs(snap.remainingMs.w)}`;
  el('clockBlack').textContent = `Black: ${fmtMs(snap.remainingMs.b)}`;
  el('clockWhite').classList.toggle('active', snap.activeColor === 'w' && snap.running);
  el('clockBlack').classList.toggle('active', snap.activeColor === 'b' && snap.running);
}
 
function renderMatchHeader() {
  const roleText =
    matchMeta.mode === 'solo'
      ? `${currentAssignment?.color === 'w' ? 'White' : 'Black'} (controls all boards)`
      : `${currentAssignment?.color === 'w' ? 'White' : 'Black'} – Board ${currentAssignment?.boardRole}`;
 
  el('matchMeta').textContent = `Match ${currentMatchId} · ${matchMeta.mode.toUpperCase()} · ${roleText}`;
}
 
function renderBoards() {
  const snapshot = engine.serialize();
  boards[1].position(snapshot.positions[1], false);
  boards[2].position(snapshot.positions[2], false);
  boards[3].position(snapshot.positions[3], false);
}
 
function renderMatchUi() {
  initBoardsIfNeeded();
 
  if (!currentAssignment) return;
 
  setVisible('authCard', false);
  setVisible('lobbyCard', false);
  setVisible('gameCard', true);
 
  const orientation = currentAssignment && currentAssignment.color === 'b' ? 'black' : 'white';
  
  boards[1].orientation(orientation);
  boards[2].orientation(orientation);
  boards[3].orientation(orientation);
 
  renderBoards();
  
  applyLastMoveHighlight(1);
  applyLastMoveHighlight(2);
  applyLastMoveHighlight(3);
  
  renderTurnIndicators();
  renderClocks();
  renderMatchHeader();
   
 
  if (matchMeta.ended_at) {
    const r =
      matchMeta.result === 'draw' ? 'Draw' : matchMeta.result === 'white' ? 'White wins' : 'Black wins';
    setStatus(`Game over: ${r} (${matchMeta.termination || 'ended'})`);
  } else {
    setStatus('');
  }
  
}
 
async function subscribeForQueueMatch() {
  if (!profile) return;
  clearRealtime();
 
  queueChannel = supabaseClient
    .channel(`queue_watch_${profile.id}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'match_players',
        filter: `user_id=eq.${profile.id}`
      },
      async (payload) => {
        const matchId = payload?.new?.match_id;
        if (!matchId) return;
        setQueueStatus('Match found. Joining…');
        await enterMatch(matchId);
      }
    )
    .subscribe();
}


function renderQueueList(rows) {
  const elQ = el('queueList');
  if (!elQ) return;
  if (!rows || rows.length === 0) {
    elQ.textContent = 'Nobody waiting.';
    return;
  }
  elQ.textContent = rows.map(r => `${r.username} (${r.rating})`).join(' | ');
}
 
async function refreshQueueSnapshot() {
  if (!profile) return;
  const mode = el('modeSelect')?.value;
  const timeMs = Number(el('timeSelect')?.value) * 1000;
 
  const { data, error } = await window.sb.rpc('queue_snapshot', {
    mode_in: mode,
    time_control_ms_in: timeMs
  });
 
  if (error) {
    renderQueueList([{ username: `Error: ${error.message}`, rating: 0 }]);
    return;
  }
  renderQueueList(data);
}
 
function startQueuePolling() {
  if (queuePollTimer) return;
  queuePollTimer = setInterval(() => {
    const lobbyHidden = el('lobbyCard')?.classList.contains('hidden');
    const gameHidden = el('gameCard')?.classList.contains('hidden');
    if (!lobbyHidden && gameHidden) refreshQueueSnapshot();
  }, 1000);
}
 
function stopQueuePolling() {
  if (!queuePollTimer) return;
  clearInterval(queuePollTimer);
  queuePollTimer = null;
} 
 
 
async function enterMatch(matchId) {
  await supabaseClient.rpc('queue_leave');
  stopQueuePolling();
  setVisible('queueWidget', false);
  requireSupabaseConfigured();
  clearRealtime();
  stopClockUi();
  timeoutCommitted = false;
  lastAppliedMoveId = 0;
 
  currentMatchId = matchId;
 
  const { data: m, error: mErr } = await supabaseClient.from('matches').select('*').eq('id', matchId).single();
  if (mErr) throw mErr;
  matchMeta = m;
 
  const { data: players, error: pErr } = await supabaseClient
    .from('match_players')
    .select('user_id, color, board_role')
    .eq('match_id', matchId);
  if (pErr) throw pErr;
 
  matchPlayersByUserId = new Map(players.map((p) => [p.user_id, p]));
  const a = matchPlayersByUserId.get(profile.id);
  currentAssignment = a ? { color: a.color, boardRole: a.board_role } : null;
 
  engine = new window.TimeShiftEngine();
  clock = new window.MatchClock({ initialMs: matchMeta.time_control_ms });
  clock.start();
 
  await replayMoves();
 
  startMovesPolling();
 
  stopQueuePolling();
  setVisible('queueWidget', false);
 
  setVisible('authCard', false);
  setVisible('lobbyCard', false);
  setVisible('gameCard', true);
  
  resetGameUiState();
  
  renderMatchUi();
 
  matchRowChannel = supabaseClient
    .channel(`match_${matchId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'matches', filter: `id=eq.${matchId}` },
      (payload) => {
        if (!payload?.new) return;
        matchMeta = payload.new;
        if (matchMeta.ended_at) clock?.pause();
        renderMatchUi();
      }
    )
    .subscribe();
 
  startClockUi();
  /*clockUiTimer = setInterval(() => {
    renderClocks();
    maybeCommitTimeout();
  }, 250);*/
}
 
async function replayMoves() {
  const { data: moves, error: mvErr } = await supabaseClient
    .from('match_moves')
    .select('id, board_index, from_square, to_square, promotion, user_id, created_at')
    .eq('match_id', currentMatchId)
    .order('id', { ascending: true });
  if (mvErr) throw mvErr;
 
  for (const move of moves) {
    await applyMoveRow(move);
  }
}
 
async function applyMoveRow(move) {
	
  if (move.id <= lastAppliedMoveId) return;
  lastAppliedMoveId = move.id;
 
  if (!engine || !clock || !matchMeta)
  {
	  setStatus(`!engine || !clock || !matchMeta returned`);
	  return;
  }
  if (matchMeta.ended_at) {
	setStatus(`matchMeta.ended_at returned`);
	return;
  }
  const result = engine.applyMove({
    boardIndex: move.board_index,
    from: move.from_square,
    to: move.to_square,
    promotion: move.promotion || 'q'
  });
 
  if (!result.ok) {
	setStatus(`Move rejected by engine: ${result.reason}`);
	console.log('APPLY_MOVE_FAILED', {
    move,
    currentTurn: engine.currentTurn,
    reason: result.reason
    });  
    await fullResync();
    return;
  }
 
  setLastMove(move.board_index, move.from_square, move.to_square);
  
  clock.switchTurn(engine.currentTurn.color);
 
  if (result.matchResult) {
    await commitMatchEnd({ result: result.matchResult, termination: 'checkmate' });
  }
}
 
function applyLastMoveHighlight(boardIndex) {
  const root = document.getElementById(`board${boardIndex}`);
  if (!root) return;
 
  root.querySelectorAll('.last-from, .last-to').forEach(n => {
    n.classList.remove('last-from', 'last-to');
  });
 
  const mv = lastMoveByBoard[boardIndex];
  if (!mv) return;
 
  const fromEl = root.querySelector(`.square-${mv.from}`);
  const toEl = root.querySelector(`.square-${mv.to}`);
  if (fromEl) fromEl.classList.add('last-from');
  if (toEl) toEl.classList.add('last-to');
  //console.log('[HL]', boardIndex, lastMoveByBoard[boardIndex], !!fromEl, !!toEl);   // temp debug
}
 
function setLastMove(boardIndex, from, to) {
  lastMoveByBoard[boardIndex] = { from, to };
  applyLastMoveHighlight(boardIndex);
} 
 
 
function startMovesPolling() {
  if (movesPollTimer) return;
  movesPollTimer = setInterval(async () => {
    try {
      if (!currentMatchId || !engine || !clock || !matchMeta) return;
      if (matchMeta.ended_at) return;
 
      const { data, error } = await supabaseClient
        .from('match_moves')
        .select('id, board_index, from_square, to_square, promotion, user_id, created_at')
        .eq('match_id', currentMatchId)
        .gt('id', lastAppliedMoveId)
        .order('id', { ascending: true });
 
      if (error) return;
 
      for (const move of data) {
        await applyMoveRow(move);
      }
      renderMatchUi();
    } catch {
      // ignore polling errors
    }
  }, 500);
}
 

function stopMovesPolling() {
  if (!movesPollTimer) return;
  clearInterval(movesPollTimer);
  movesPollTimer = null;
}
 
 
async function fullResync() {
  engine = new window.TimeShiftEngine();
  clock = new window.MatchClock({ initialMs: matchMeta.time_control_ms });
  clock.start();
  startClockUi();
  lastAppliedMoveId = 0;
  await replayMoves();
  renderMatchUi();
}
 
async function submitMove({ boardIndex, from, to, promotion }) {
  requireSupabaseConfigured();
 
  const { data, error } = await supabaseClient
  .from('match_moves')
  .insert({
    match_id: currentMatchId,
    user_id: profile.id,
    board_index: boardIndex,
    from_square: from,
    to_square: to,
    promotion: promotion || 'q'
  })
  .select('id')
  .single();
 
if (error) {
  setStatus(`Insert failed: ${error.message}`);
  console.log('INSERT_FAILED', error);
  await fullResync();
  return;
}
 
// IMPORTANT: mark this id as already processed, so polling won't re-fetch it
lastAppliedMoveId = Math.max(lastAppliedMoveId, data.id);
}

 
async function commitMatchEnd({ result, termination }) {
  if (!currentMatchId || !matchMeta || matchMeta.ended_at) return;
 
  // LOCAL AI: end locally (no Supabase)
  if (localAiEnabled || currentMatchId === 'local_ai') {
    matchMeta = {
      ...matchMeta,
      ended_at: new Date().toISOString(),
      result: result === 'draw' ? 'draw' : result === 'w' ? 'white' : 'black',
      termination: termination || null
    };
    clock?.pause();
    renderMatchUi();
    return;
  }
 
  // ONLINE: end in Supabase
  const update = {
    ended_at: new Date().toISOString(),
    result: result === 'draw' ? 'draw' : result === 'w' ? 'white' : 'black',
    termination: termination || null
  };
 
  const { error } = await supabaseClient.rpc('end_match', {
    match_id_in: currentMatchId,
    result_in: update.result,
    termination_in: update.termination
  });
 
  if (error) {
    const { data: m } = await supabaseClient.from('matches').select('*').eq('id', currentMatchId).single();
    if (m) matchMeta = m;
  } else {
    matchMeta = { ...matchMeta, ...update };
  }
 
  profile = await loadMyProfile();
  el('me').textContent = `${profile.username} (rating ${profile.rating})`;
 
  clock?.pause();
  renderMatchUi();
}
 
async function maybeCommitTimeout() {
  if (!clock || !engine || !matchMeta || matchMeta.ended_at) return;
  if (timeoutCommitted) return;
  const flagged = clock.isFlagged();
  if (!flagged) return;
  timeoutCommitted = true;
  const winner = flagged === 'w' ? 'b' : 'w';
  await commitMatchEnd({ result: winner, termination: 'timeout' });
}
 
async function leaveQueue() {
  requireSupabaseConfigured();
  await supabaseClient.rpc('queue_leave');
 
  setQueueStatus('');
  if (queueChannel) {
    supabaseClient.removeChannel(queueChannel);
    queueChannel = null;
  }
}
 
async function logout() {
  
  localAiEnabled = false;
  aiColor = null;
  if (stockfish?.stop) stockfish.stop();
	stockfish = null;

  clearRealtime();
  stopClockUi();
  currentMatchId = null;
  currentAssignment = null;
  matchMeta = null;
  engine = null;
  clock = null;
  profile = null;
  el('me').textContent = '';
  setVisible('authCard', true);
  setVisible('lobbyCard', false);
  setVisible('gameCard', false);
  
  if (supabaseClient) await supabaseClient.auth.signOut();
  stopMovesPolling();
}
 
// UI wiring
el('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setAuthError('');
  try {
    requireSupabaseConfigured();
    const fd = new FormData(e.currentTarget);
    const username = String(fd.get('username') || '').trim();
    const password = String(fd.get('password') || '');
    const email = usernameToEmail(username);
    if (!username || !password) throw new Error('missing_fields');
    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) throw error;
 
    const user = data.user || (await supabaseClient.auth.getUser()).data.user;
    if (!user) throw new Error('signup_needs_confirmation');
 
    const { error: upErr } = await supabaseClient.from('profiles').upsert({ id: user.id, username, rating: 1200 });
    if (upErr) throw upErr;
 
    profile = await loadMyProfile();
	setVisible('queueWidget', true);
	startQueuePolling();
	refreshQueueSnapshot();

    el('me').textContent = `${profile.username} (rating ${profile.rating})`;
    setVisible('authCard', false);
    setVisible('lobbyCard', true);
    setVisible('gameCard', false);
  } catch (err) {
    setAuthError(err?.message || 'Registration failed');
  }
});
 
el('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setAuthError('');
  try {
    requireSupabaseConfigured();
    const fd = new FormData(e.currentTarget);
    const username = String(fd.get('username') || '').trim();
    const password = String(fd.get('password') || '');
    const email = usernameToEmail(username);
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
 
    profile = await loadMyProfile();
	startQueuePolling();
	refreshQueueSnapshot();

    el('me').textContent = `${profile.username} (rating ${profile.rating})`;
    setVisible('authCard', false);
    setVisible('lobbyCard', true);
    setVisible('gameCard', false);
	setVisible('queueWidget', true);
  } catch (err) {
    setAuthError(err?.message || 'Login failed');
  }
});
 
el('queueBtn').addEventListener('click', async () => {
  const btn = el('queueBtn');
  btn.disabled = true;
  try {
    if (!profile) return;
 
    setQueueStatus('');
    await leaveQueue();
 
    const mode = el('modeSelect').value;
    const timeControlMs = Number(el('timeSelect').value) * 1000;
 
    // ---- LOCAL AI MODE (no queue, no supabase match) ----
    if (mode === 'ai') {
      localAiEnabled = true;
      aiColor = Math.random() < 0.5 ? 'w' : 'b';
 
      // lazy-load stockfish client once
      if (!stockfish) {
        const mod = await import('/stockfish/stockfishClient.js');
        stockfish = await mod.createStockfish();
      }
 
      currentMatchId = 'local_ai';
      matchMeta = { mode: 'solo', time_control_ms: timeControlMs, ended_at: null, result: null, termination: null };
      currentAssignment = { color: aiColor === 'w' ? 'b' : 'w', boardRole: null };
 
      engine = new window.TimeShiftEngine();
	  
	  resetGameUiState();
	  
	  
      clock = new window.MatchClock({ initialMs: timeControlMs });
      clock.start();
	  startClockUi();
 
      setVisible('lobbyCard', false);
      setVisible('gameCard', true);
      renderMatchUi();
 
	  stopQueuePolling();	
	  setVisible('queueWidget', false);
 
      // if computer is white, it moves immediately
      await maybeComputerMove();
      return;
    }
 
    // ---- ONLINE PVP/PVT MODE (supabase queue) ----
    requireSupabaseConfigured();
 
    const { data, error } = await supabaseClient.rpc('queue_join', {
      mode_in: mode,
      time_control_ms_in: timeControlMs
    });
    if (error) throw error;
 
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.status === 'matched' && row?.match_id) {
      await enterMatch(row.match_id);
      return;
    }
 
    setQueueStatus(`Queued for ${mode}…`);
    await subscribeForQueueMatch();
    const matchId = await waitForMyMatch();
    if (matchId) await enterMatch(matchId);
  } catch (err) {
    setQueueStatus(err?.message || 'Queue failed');
  } finally {
    const inGame = !el('gameCard')?.classList.contains('hidden');
    if (!inGame) btn.disabled = false;
  }
});
 
 

el('leaveQueueBtn').addEventListener('click', async () => {
  try {
    await leaveQueue();
	const btn = el('queueBtn');
    if (btn) btn.disabled = false;
  } catch (err) {
    setQueueStatus(err?.message || 'Leave queue failed');
  }
});
 
el('logoutBtn').addEventListener('click', () => logout());
 
el('resignBtn').addEventListener('click', async () => {
  try {
    if (!currentMatchId || !currentAssignment) return;
    const winner = currentAssignment.color === 'w' ? 'b' : 'w';
    await commitMatchEnd({ result: winner, termination: 'resign' });
  } catch (err) {
    setStatus(err?.message || 'Resign failed');
  }
});
 
el('backToLobbyBtn').addEventListener('click', async () => {
  
	// If you leave an active match, end it (treat as resign)
  if (currentMatchId && currentAssignment && matchMeta && !matchMeta.ended_at) {
	const winner = currentAssignment.color === 'w' ? 'b' : 'w';
	await commitMatchEnd({ result: winner, termination: 'resign' });
  }
  
  // STOP AI 
  localAiEnabled = false;
  aiColor = null;
  if (stockfish?.stop) stockfish.stop();
  stockfish = null;
  
  setVisible('queueWidget', true);
  clearRealtime();
  stopClockUi();
  currentMatchId = null;
  currentAssignment = null;
  engine = null;
  clock = null;
  matchMeta = null;
  setVisible('gameCard', false);
  setVisible('lobbyCard', true);
  await leaveQueue();
  startQueuePolling();
  refreshQueueSnapshot();
  stopMovesPolling();
  const btn = el('queueBtn');
  if (btn) btn.disabled = false;
  isSubmittingMove = false; // optional safety
  setQueueStatus('');
  setStatus('');
  resetGameUiState();
});
 
 function resetGameUiState() {
  // clear last-move highlight state
  lastMoveByBoard[1] = null;
  lastMoveByBoard[2] = null;
  lastMoveByBoard[3] = null;
 
  // remove highlight classes from DOM
  applyLastMoveHighlight(1);
  applyLastMoveHighlight(2);
  applyLastMoveHighlight(3);
 
  // reset flags + messages
  isSubmittingMove = false;
  timeoutCommitted = false;
  setStatus('');
  
  if (boards[1]) {
    boards[1].position('start', false);
    boards[2].position('start', false);
    boards[3].position('start', false);
  };  
  
}
 
 
 
// Bootstrap
(async function boot() {
  setVisible('authCard', true);
  setVisible('lobbyCard', false);
  setVisible('gameCard', false);
  setVisible('queueWidget', true);
  
 
  try {
    requireSupabaseConfigured();
  } catch (e) {
    setAuthError(String(e?.message || e));
    return;
  }
 
  try {
    profile = await loadMyProfile();
	if (!profile) return;
	startQueuePolling();
	refreshQueueSnapshot();
    el('me').textContent = `${profile.username} (rating ${profile.rating})`;
    setVisible('authCard', false);
    setVisible('lobbyCard', true);
  } catch {
    // not logged in
  }
})();