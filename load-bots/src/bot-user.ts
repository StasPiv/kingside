import { io, Socket } from 'socket.io-client';
import { Metrics } from './metrics.js';

export class BotUser {
  readonly username: string;
  private accessToken: string | null = null;
  private devSecret: string | null = null;
  private sockets = new Map<string, Socket>();

  constructor(
    private readonly baseUrl: string,
    private readonly wsUrl: string,
    username: string,
    private readonly metrics: Metrics,
  ) {
    this.username = username;
  }

  /** Authenticate via dev-bypass. Returns accessToken. */
  async login(secret: string): Promise<string> {
    const start = Date.now();
    const res = await fetch(`${this.baseUrl}/api/auth/dev-bypass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, user: this.username }),
    });

    if (!res.ok) {
      this.metrics.recordError();
      throw new Error(`Login failed: ${res.status}`);
    }

    const data = (await res.json()) as { accessToken: string };
    this.accessToken = data.accessToken;
    this.devSecret = secret;
    this.metrics.recordLatency(Date.now() - start);
    return this.accessToken;
  }

  /** GET request with auth. */
  async get<T = unknown>(path: string): Promise<T> {
    const start = Date.now();
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      this.metrics.recordError();
      throw new Error(`GET ${path}: ${res.status}`);
    }
    this.metrics.recordLatency(Date.now() - start);
    return res.json() as Promise<T>;
  }

  /** POST request with auth. */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const start = Date.now();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      this.metrics.recordError();
      throw new Error(`POST ${path}: ${res.status}`);
    }
    this.metrics.recordLatency(Date.now() - start);
    return res.json() as Promise<T>;
  }

  /** Connect to a Socket.IO namespace. Returns the socket. */
  connectWs(namespace: string): Socket {
    if (!this.accessToken) throw new Error('Not logged in');

    const socket = io(`${this.wsUrl}${namespace}`, {
      auth: { token: this.accessToken },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });

    this.sockets.set(namespace, socket);
    return socket;
  }

  /** Re-login and reconnect to a namespace. Returns new socket. */
  async reconnectWs(namespace: string): Promise<Socket> {
    // Disconnect old socket
    const old = this.sockets.get(namespace);
    if (old) { old.disconnect(); this.sockets.delete(namespace); }

    // Re-auth
    if (this.devSecret) {
      await this.login(this.devSecret);
    }

    return this.connectWs(namespace);
  }

  /** Get an existing socket by namespace. */
  getSocket(namespace: string): Socket | undefined {
    return this.sockets.get(namespace);
  }

  /** Disconnect all sockets. */
  disconnect(): void {
    for (const [ns, socket] of this.sockets) {
      socket.disconnect();
      this.sockets.delete(ns);
    }
  }

  private authHeaders(): Record<string, string> {
    if (!this.accessToken) throw new Error('Not logged in');
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}
