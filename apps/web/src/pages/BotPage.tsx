import { useState, useRef, useCallback, useEffect } from 'react';
import { BotClient, BotLogEntry } from '../bot/BotClient';

export function BotPage() {
  const [username, setUsername] = useState('QueenGambit');
  const [password, setPassword] = useState('botpass123');
  const [timeControl, setTimeControl] = useState('blitz');
  const [status, setStatus] = useState('idle');
  const [logs, setLogs] = useState<BotLogEntry[]>([]);
  const botRef = useRef<BotClient | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleStart = useCallback(() => {
    if (botRef.current) {
      botRef.current.stop();
    }

    const bot = new BotClient({ username, password, timeControl, thinkingDelay: 1500 });
    bot.setCallbacks({
      onStatusChange: (s) => setStatus(s),
      onLog: (entry) => setLogs((prev) => [...prev.slice(-200), entry]),
    });
    botRef.current = bot;
    bot.start();
  }, [username, password, timeControl]);

  const handleStop = useCallback(() => {
    botRef.current?.stop();
    botRef.current = null;
  }, []);

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
      <h1>Bot Client</h1>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Bot username"
          disabled={status === 'playing' || status === 'in_queue'}
          style={{ padding: 8, width: 160 }}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Bot password"
          disabled={status === 'playing' || status === 'in_queue'}
          style={{ padding: 8, width: 160 }}
        />
        <select
          value={timeControl}
          onChange={(e) => setTimeControl(e.target.value)}
          disabled={status === 'playing' || status === 'in_queue'}
          style={{ padding: 8 }}
        >
          <option value="bullet">Bullet</option>
          <option value="blitz">Blitz</option>
          <option value="rapid">Rapid</option>
          <option value="classical">Classical</option>
        </select>
        {status === 'idle' || status === 'error' || status === 'stopped' ? (
          <button onClick={handleStart} style={{ padding: '8px 16px' }}>Start Bot</button>
        ) : (
          <button onClick={handleStop} style={{ padding: '8px 16px' }}>Stop Bot</button>
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        Status: <strong>{status}</strong>
      </div>

      <div
        style={{
          background: '#1a1a2e',
          color: '#e0e0e0',
          padding: 12,
          borderRadius: 8,
          height: 400,
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: 13,
        }}
      >
        {logs.map((entry, i) => (
          <div
            key={i}
            style={{
              color: entry.level === 'error' ? '#ff6b6b' : entry.level === 'warn' ? '#ffd93d' : '#a0d0a0',
              marginBottom: 2,
            }}
          >
            <span style={{ color: '#888' }}>{entry.ts.toLocaleTimeString()}</span>{' '}
            [{entry.level.toUpperCase()}] {entry.message}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
