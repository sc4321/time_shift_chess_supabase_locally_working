import { Chess } from 'chess.js';

function getInitialBoardMap() {
  return {
    a1: { square: 'a1', piece: 'wR' },
    b1: { square: 'b1', piece: 'wN' },
    c1: { square: 'c1', piece: 'wB' },
    d1: { square: 'd1', piece: 'wQ' },
    e1: { square: 'e1', piece: 'wK' },
    f1: { square: 'f1', piece: 'wB' },
    g1: { square: 'g1', piece: 'wN' },
    h1: { square: 'h1', piece: 'wR' },
    a2: { square: 'a2', piece: 'wP' },
    b2: { square: 'b2', piece: 'wP' },
    c2: { square: 'c2', piece: 'wP' },
    d2: { square: 'd2', piece: 'wP' },
    e2: { square: 'e2', piece: 'wP' },
    f2: { square: 'f2', piece: 'wP' },
    g2: { square: 'g2', piece: 'wP' },
    h2: { square: 'h2', piece: 'wP' },

    a8: { square: 'a8', piece: 'bR' },
    b8: { square: 'b8', piece: 'bN' },
    c8: { square: 'c8', piece: 'bB' },
    d8: { square: 'd8', piece: 'bQ' },
    e8: { square: 'e8', piece: 'bK' },
    f8: { square: 'f8', piece: 'bB' },
    g8: { square: 'g8', piece: 'bN' },
    h8: { square: 'h8', piece: 'bR' },
    a7: { square: 'a7', piece: 'bP' },
    b7: { square: 'b7', piece: 'bP' },
    c7: { square: 'c7', piece: 'bP' },
    d7: { square: 'd7', piece: 'bP' },
    e7: { square: 'e7', piece: 'bP' },
    f7: { square: 'f7', piece: 'bP' },
    g7: { square: 'g7', piece: 'bP' },
    h7: { square: 'h7', piece: 'bP' }
  };
}

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function updateBoardMap(boardMap, source, target) {
  for (const key of Object.keys(boardMap)) {
    const entry = boardMap[key];
    if (entry && entry.square === source) {
      entry.square = target;
      return;
    }
  }
}

function findCapturedPieceKey(boardMap, target, movingColor) {
  for (const key of Object.keys(boardMap)) {
    const entry = boardMap[key];
    if (entry && entry.square === target && entry.piece.charAt(0) !== movingColor) {
      return key;
    }
  }
  return null;
}

function boardMapToPosition(boardMap) {
  const position = {};
  for (const key of Object.keys(boardMap)) {
    const entry = boardMap[key];
    if (!entry) continue;
    position[entry.square] = entry.piece;
  }
  return position;
}

function positionToFenPiecePlacement(positionObj) {
  const fenRanks = [];
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  for (let r = 8; r >= 1; r--) {
    let fenRank = '';
    let emptyCount = 0;
    for (let f = 0; f < files.length; f++) {
      const square = `${files[f]}${r}`;
      const pieceCode = positionObj[square];
      if (pieceCode) {
        if (emptyCount > 0) {
          fenRank += String(emptyCount);
          emptyCount = 0;
        }
        const letter = pieceCode[1];
        fenRank += pieceCode[0] === 'w' ? letter.toUpperCase() : letter.toLowerCase();
      } else {
        emptyCount++;
      }
    }
    if (emptyCount > 0) fenRank += String(emptyCount);
    fenRanks.push(fenRank);
  }
  return fenRanks.join('/');
}

function updateGameStateFromBoardMap(game, boardMap) {
  const parts = game.fen().split(' ');
  const positionObj = boardMapToPosition(boardMap);
  parts[0] = positionToFenPiecePlacement(positionObj);
  game.load(parts.join(' '));
}

export class TimeShiftEngine {
  constructor() {
    this.boardMaps = {
      1: getInitialBoardMap(),
      2: deepCopy(getInitialBoardMap()),
      3: deepCopy(getInitialBoardMap())
    };

    this.games = {
      1: new Chess(),
      2: new Chess(),
      3: new Chess()
    };

    this.currentTurn = { board: 1, color: 'w' };
    this.boardFinished = { 1: false, 2: false, 3: false };
    this.boardResults = { 1: null, 2: null, 3: null }; // 'White' | 'Black'

    // Ensure all games align with maps.
    updateGameStateFromBoardMap(this.games[1], this.boardMaps[1]);
    updateGameStateFromBoardMap(this.games[2], this.boardMaps[2]);
    updateGameStateFromBoardMap(this.games[3], this.boardMaps[3]);
  }

  serialize() {
    return {
      currentTurn: deepCopy(this.currentTurn),
      boardFinished: deepCopy(this.boardFinished),
      boardResults: deepCopy(this.boardResults),
      positions: {
        1: boardMapToPosition(this.boardMaps[1]),
        2: boardMapToPosition(this.boardMaps[2]),
        3: boardMapToPosition(this.boardMaps[3])
      },
      fens: {
        1: this.games[1].fen(),
        2: this.games[2].fen(),
        3: this.games[3].fen()
      }
    };
  }

  allBoardsFinished() {
    return this.boardFinished[1] && this.boardFinished[2] && this.boardFinished[3];
  }

  computeMatchResultIfDone() {
    if (!this.allBoardsFinished()) return null;
    let whiteWins = 0;
    let blackWins = 0;
    for (let i = 1; i <= 3; i++) {
      if (this.boardResults[i] === 'White') whiteWins++;
      if (this.boardResults[i] === 'Black') blackWins++;
    }
    if (whiteWins > blackWins) return 'w';
    if (blackWins > whiteWins) return 'b';
    return 'draw';
  }

  advanceTurn() {
    do {
      if (this.currentTurn.color === 'w') {
        this.currentTurn.color = 'b';
      } else {
        this.currentTurn.color = 'w';
        this.currentTurn.board = (this.currentTurn.board % 3) + 1;
      }
    } while (this.boardFinished[this.currentTurn.board] && !this.allBoardsFinished());
  }

  propagateCaptureFromBoard1(capturedKey) {
    const b2 = this.boardMaps[2];
    const b3 = this.boardMaps[3];
    if (Object.prototype.hasOwnProperty.call(b2, capturedKey)) {
      delete b2[capturedKey];
      updateGameStateFromBoardMap(this.games[2], b2);
    }
    if (Object.prototype.hasOwnProperty.call(b3, capturedKey)) {
      delete b3[capturedKey];
      updateGameStateFromBoardMap(this.games[3], b3);
    }
  }

  propagateCaptureFromBoard2(capturedKey) {
    const b3 = this.boardMaps[3];
    if (Object.prototype.hasOwnProperty.call(b3, capturedKey)) {
      delete b3[capturedKey];
      updateGameStateFromBoardMap(this.games[3], b3);
    }
  }

  /**
   * Apply a move on a given board.
   *
   * @returns {{ ok: true, move: any, matchResult?: 'w'|'b'|'draw'|null } | { ok:false, reason: string }}
   */
  applyMove({ boardIndex, from, to, promotion = 'q' }) {
    if (this.boardFinished[boardIndex]) {
      return { ok: false, reason: `Board ${boardIndex} is finished` };
    }
    if (boardIndex !== this.currentTurn.board) {
      return { ok: false, reason: `Not active board` };
    }

    const boardMap = this.boardMaps[boardIndex];
    const game = this.games[boardIndex];

    // locate moving piece
    let movingPiece = null;
    for (const key of Object.keys(boardMap)) {
      const entry = boardMap[key];
      if (entry && entry.square === from) {
        movingPiece = entry;
        break;
      }
    }
    if (!movingPiece) return { ok: false, reason: 'No piece at source' };

    if (movingPiece.piece.charAt(0) !== this.currentTurn.color) {
      return { ok: false, reason: 'Not your color turn' };
    }

    // attempt move in chess.js
    const move = game.move({ from, to, promotion });
    if (move === null) return { ok: false, reason: 'Illegal move' };

    // determine capture key (normal vs en passant)
    let capturedKey = null;
    if (move.flags?.includes('e')) {
      const file = to.charAt(0);
      const rank = Number.parseInt(to.charAt(1), 10);
      const capturedSquare = movingPiece.piece.charAt(0) === 'w' ? `${file}${rank - 1}` : `${file}${rank + 1}`;
      capturedKey = findCapturedPieceKey(boardMap, capturedSquare, movingPiece.piece.charAt(0));
    } else {
      capturedKey = findCapturedPieceKey(boardMap, to, movingPiece.piece.charAt(0));
    }

    // pawn promotion: update identity piece code to Q
    if (move.promotion) {
      const color = movingPiece.piece.charAt(0);
      movingPiece.piece = `${color}Q`;
    }

    // castling: move rook in board map
    if (!move.castle && move.flags) {
      if (move.flags.includes('k')) move.castle = 'kingside';
      if (move.flags.includes('q')) move.castle = 'queenside';
    }
    if (move.castle) {
      let rookFrom;
      let rookTo;
      if (move.castle === 'kingside') {
        rookFrom = movingPiece.piece.charAt(0) === 'w' ? 'h1' : 'h8';
        rookTo = movingPiece.piece.charAt(0) === 'w' ? 'f1' : 'f8';
      } else {
        rookFrom = movingPiece.piece.charAt(0) === 'w' ? 'a1' : 'a8';
        rookTo = movingPiece.piece.charAt(0) === 'w' ? 'd1' : 'd8';
      }
      for (const key of Object.keys(boardMap)) {
        const entry = boardMap[key];
        if (entry && entry.square === rookFrom) {
          entry.square = rookTo;
          break;
        }
      }
    }

    // remove captured piece from this board map
    if (move.captured && capturedKey !== null) {
      delete boardMap[capturedKey];
    }

    // move the piece in board map
    updateBoardMap(boardMap, from, to);

    // sync older boards on capture
    if (move.captured && capturedKey !== null) {
      if (boardIndex === 1) this.propagateCaptureFromBoard1(capturedKey);
      if (boardIndex === 2) this.propagateCaptureFromBoard2(capturedKey);
    }

    // for boards 2/3, rebuild game state from board map to reflect any propagated changes
    if (boardIndex === 2 || boardIndex === 3) {
      updateGameStateFromBoardMap(game, boardMap);
    }

    // checkmate ends just this board
    if (game.isCheckmate()) {
      const winner = game.turn() === 'w' ? 'Black' : 'White';
      this.boardFinished[boardIndex] = true;
      this.boardResults[boardIndex] = winner;
    }

    // advance global turn
    this.advanceTurn();

    return { ok: true, move, matchResult: this.computeMatchResultIfDone() };
  }

  resignActiveBoard() {
    const boardIndex = this.currentTurn.board;
    if (this.boardFinished[boardIndex]) return { ok: false, reason: 'Board already finished' };
    const resigningColor = this.currentTurn.color;
    const winner = resigningColor === 'w' ? 'Black' : 'White';
    this.boardFinished[boardIndex] = true;
    this.boardResults[boardIndex] = winner;
    this.advanceTurn();
    return { ok: true, boardIndex, winnerColor: winner === 'White' ? 'w' : 'b', matchResult: this.computeMatchResultIfDone() };
  }
}