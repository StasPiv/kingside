import { io, Socket } from 'socket.io-client';
import { Chess } from 'chess.js';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const GAME_URL = import.meta.env.VITE_GAME_URL ?? API_URL;

export type BotConfig = {
  username: string;
  password: string;
  timeControl?: string;
  /** Delay before making a move (ms) to simulate thinking */
  thinkingDelay?: number;
};

export type BotLogEntry = {
  ts: Date;
  level: 'info' | 'warn' | 'error';
  message: string;
};

type BotStatus = 'idle' | 'connecting' | 'in_queue' | 'playing' | 'error' | 'stopped';

const TIME_CONTROLS: Record<string, { initialTime: number; increment: number }> = {
  bullet: { initialTime: 60, increment: 0 },
  blitz: { initialTime: 300, increment: 0 },
  rapid: { initialTime: 600, increment: 0 },
  classical: { initialTime: 1800, increment: 0 },
};

export class BotClient {
  private gameSocket: Socket | null = null;
  private matchSocket: Socket | null = null;
  private token: string | null = null;
  private config: BotConfig;
  private gameId: string | null = null;
  private chess: Chess = new Chess();
  private botColor: 'white' | 'black' | null = null;
  private _status: BotStatus = 'idle';
  private _logs: BotLogEntry[] = [];
  private onStatusChange?: (status: BotStatus) => void;
  private onLog?: (entry: BotLogEntry) => void;
  private moveTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(config: BotConfig) {
    this.config = { thinkingDelay: 1000, ...config };
  }

  get status() { return this._status; }
  get logs() { return this._logs; }

  setCallbacks(cbs: { onStatusChange?: (s: BotStatus) => void; onLog?: (e: BotLogEntry) => void }) {
    this.onStatusChange = cbs.onStatusChange;
    this.onLog = cbs.onLog;
  }

  private log(level: BotLogEntry['level'], message: string) {
    const entry: BotLogEntry = { ts: new Date(), level, message };
    this._logs.push(entry);
    this.onLog?.(entry);
    const prefix = `[Bot ${this.config.username}]`;
    if (level === 'error') console.error(prefix, message);
    else console.log(prefix, message);
  }

  private setStatus(status: BotStatus) {
    this._status = status;
    this.onStatusChange?.(status);
  }

  async start() {
    try {
      this.setStatus('connecting');
      this.log('info', 'Logging in...');

      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: this.config.username,
          password: this.config.password,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `Login failed: ${res.status}`);
      }

      const { accessToken } = await res.json();
      this.token = accessToken;

      const meRes = await fetch(`${API_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (meRes.ok) {
        const me = await meRes.json();
        this.log('info', `Logged in as ${me.username} (${me.id})`);
      }

      const socketOpts = { auth: { token: this.token }, transports: ['websocket'] as ['websocket'] };

      // Two sockets matching the real frontend: /matchmaking and /game
      this.matchSocket = io(`${GAME_URL}/matchmaking`, socketOpts);
      this.gameSocket = io(`${GAME_URL}/game`, socketOpts);

      this.setupMatchmakingListeners();
      this.setupGameListeners();

      let connected = 0;
      const onBothConnected = () => {
        connected++;
        if (connected === 2) {
          this.log('info', 'Both sockets connected');
          this.setStatus('in_queue');
          this.joinMatchmaking();
        }
      };

      this.matchSocket.on('connect', () => {
        this.log('info', 'Matchmaking socket connected');
        onBothConnected();
      });

      this.gameSocket.on('connect', () => {
        this.log('info', 'Game socket connected');
        onBothConnected();
      });

      for (const s of [this.matchSocket, this.gameSocket]) {
        s.on('connect_error', (err) => {
          this.log('error', `Socket connection error: ${err.message}`);
          this.setStatus('error');
        });
        s.on('disconnect', (reason) => {
          this.log('warn', `Socket disconnected: ${reason}`);
          if (this._status !== 'stopped') this.setStatus('idle');
        });
      }
    } catch (err: any) {
      this.log('error', `Start failed: ${err.message}`);
      this.setStatus('error');
    }
  }

  stop() {
    this.setStatus('stopped');
    if (this.moveTimeoutId) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }
    if (this.matchSocket) {
      this.matchSocket.emit('matchmaking:leave');
      this.matchSocket.disconnect();
      this.matchSocket = null;
    }
    if (this.gameSocket) {
      this.gameSocket.disconnect();
      this.gameSocket = null;
    }
    this.gameId = null;
    this.botColor = null;
    this.log('info', 'Bot stopped');
  }

  private joinMatchmaking() {
    if (!this.matchSocket) return;
    const tc = this.config.timeControl ?? 'blitz';
    const control = TIME_CONTROLS[tc] ?? TIME_CONTROLS.blitz;

    this.matchSocket.emit('matchmaking:join', {
      timeInitial: control.initialTime,
      increment: control.increment,
    });
    this.log('info', `Joined ${tc} matchmaking queue`);
  }

  private setupMatchmakingListeners() {
    if (!this.matchSocket) return;

    this.matchSocket.on('matchmaking:found', (data: { gameId: string; color: string; opponent?: { username?: string } }) => {
      this.log('info', `Match found! Game: ${data.gameId}, color: ${data.color}, opponent: ${data.opponent?.username ?? '?'}`);
      this.gameId = data.gameId;
      this.botColor = data.color as 'white' | 'black';
      this.setStatus('playing');

      // Join the game room via game socket
      this.gameSocket!.emit('game:join', { gameId: data.gameId });
      this.log('info', `Sent game:join for ${data.gameId}`);
    });

    this.matchSocket.on('error', (data: { code?: string; message: string }) => {
      this.log('error', `Matchmaking error: ${data.code ?? ''} ${data.message}`);
    });
  }

  private setupGameListeners() {
    if (!this.gameSocket) return;

    this.gameSocket.on('game:state', (state: any) => {
      this.log('info', `game:state fen=${state.fen} status=${state.status}`);
      if (state.fen) this.chess.load(state.fen);
      if (state.status === 'active') this.tryMakeMove();
    });

    this.gameSocket.on('game:move', (data: { uci: string; san: string; fen: string }) => {
      this.log('info', `game:move ${data.san} (${data.uci})`);
      this.chess.load(data.fen);
      this.tryMakeMove();
    });

    this.gameSocket.on('game:end', (data: { result: string; termination: string }) => {
      this.log('info', `Game ended: ${data.result} by ${data.termination}`);
      this.gameId = null;
      this.botColor = null;
      this.chess.reset();
      this.setStatus('in_queue');

      setTimeout(() => {
        if (this._status !== 'stopped') this.joinMatchmaking();
      }, 2000);
    });

    this.gameSocket.on('game:draw:offered', () => {
      if (this.gameId && this.gameSocket) {
        this.gameSocket.emit('game:draw:decline', { gameId: this.gameId });
        this.log('info', 'Declined draw offer');
      }
    });

    this.gameSocket.on('error', (data: { code?: string; message: string }) => {
      this.log('error', `Game error: ${data.code ?? ''} ${data.message}`);
    });
  }

  private tryMakeMove() {
    if (!this.gameId || !this.botColor || !this.gameSocket) return;
    if (this._status === 'stopped') return;

    const turn = this.chess.turn() === 'w' ? 'white' : 'black';
    if (turn !== this.botColor) return;
    if (this.chess.isGameOver()) return;

    const delay = this.config.thinkingDelay ?? 1000;
    this.log('info', `My turn (${this.botColor}), thinking for ${delay}ms...`);

    if (this.moveTimeoutId) clearTimeout(this.moveTimeoutId);
    this.moveTimeoutId = setTimeout(() => this.makeMove(), delay);
  }

  private makeMove() {
    if (!this.gameId || !this.gameSocket) return;
    if (this.chess.isGameOver()) return;

    const moves = this.chess.moves({ verbose: true });
    if (moves.length === 0) return;

    const move = this.selectMove(moves);
    const uci = move.from + move.to + (move.promotion ?? '');

    this.gameSocket.emit('game:move', { gameId: this.gameId, uci });
    this.log('info', `Made move: ${move.san} (${uci})`);
  }

  private selectMove(moves: ReturnType<Chess['moves']>): any {
    // Prioritize: checkmates > captures > checks > random
    const checkmates = moves.filter((m: any) => m.san.includes('#'));
    if (checkmates.length > 0) return checkmates[0];

    const captures = moves.filter((m: any) => m.captured);
    const checks = moves.filter((m: any) => m.san.includes('+'));

    if (captures.length > 0 && Math.random() < 0.7) {
      return captures[Math.floor(Math.random() * captures.length)];
    }
    if (checks.length > 0 && Math.random() < 0.5) {
      return checks[Math.floor(Math.random() * checks.length)];
    }

    return moves[Math.floor(Math.random() * moves.length)];
  }
}
