export class Metrics {
  private latencies: number[] = [];
  private errors = 0;
  private totalRequests = 0;
  private gamesStarted = 0;
  private gamesCompleted = 0;
  private movesMade = 0;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  recordLatency(ms: number): void {
    this.latencies.push(ms);
    this.totalRequests++;
  }

  recordError(): void {
    this.errors++;
    this.totalRequests++;
  }

  recordGameStarted(): void {
    this.gamesStarted++;
  }

  recordGameCompleted(): void {
    this.gamesCompleted++;
  }

  recordMove(): void {
    this.movesMade++;
  }

  startPeriodicReport(intervalSec = 10): void {
    this.intervalHandle = setInterval(() => this.report(), intervalSec * 1000);
  }

  stopPeriodicReport(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  report(): void {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
    const avg = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const errorRate = this.totalRequests > 0 ? (this.errors / this.totalRequests * 100).toFixed(1) : '0';

    console.log(
      `[Metrics] requests=${this.totalRequests} errors=${this.errors} (${errorRate}%) ` +
      `avg=${avg.toFixed(0)}ms p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms p99=${p99.toFixed(0)}ms | ` +
      `games: started=${this.gamesStarted} completed=${this.gamesCompleted} moves=${this.movesMade}`,
    );
  }

  reset(): void {
    this.latencies = [];
    this.errors = 0;
    this.totalRequests = 0;
    this.gamesStarted = 0;
    this.gamesCompleted = 0;
    this.movesMade = 0;
  }

  /** Serializable snapshot for worker_threads communication */
  snapshot(): { totalRequests: number; errors: number; gamesStarted: number; gamesCompleted: number; movesMade: number } {
    return {
      totalRequests: this.totalRequests,
      errors: this.errors,
      gamesStarted: this.gamesStarted,
      gamesCompleted: this.gamesCompleted,
      movesMade: this.movesMade,
    };
  }

  /** Merge snapshot from worker into this instance */
  merge(snap: { totalRequests: number; errors: number; gamesStarted: number; gamesCompleted: number; movesMade: number }): void {
    this.totalRequests += snap.totalRequests;
    this.errors += snap.errors;
    this.gamesStarted += snap.gamesStarted;
    this.gamesCompleted += snap.gamesCompleted;
    this.movesMade += snap.movesMade;
  }
}
