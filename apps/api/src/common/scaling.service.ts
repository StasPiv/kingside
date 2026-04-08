import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

const CHECK_INTERVAL_MS = 15_000;
/** Estimated time for a new instance to become healthy (seconds) */
const SCALE_UP_ETA_SEC = 60;
/** Minimum time to stay in busy state (ms) — prevents flapping */
const MIN_BUSY_MS = 60_000;
/** Consecutive checks below threshold needed to transition to ready */
const READY_CHECKS_REQUIRED = 4; // 4 × 15s = 60s

@Injectable()
export class ScalingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScalingService.name);
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly cluster: string;
  private readonly service: string;
  private readonly enabled: boolean;
  private lastScaleTime = 0;
  private ecsClient: any = null;
  private timer: NodeJS.Timeout | null = null;
  /** Track busy state to emit server:busy / server:ready transitions only once */
  private isBusy = false;
  /** Timestamp when busy state was entered */
  private busySince = 0;
  /** Consecutive checks where connections < threshold (for hysteresis) */
  private belowThresholdChecks = 0;
  /** Last known non-zero connection count (to filter engine.clientsCount=0 glitches) */
  private lastNonZeroCount = 0;

  /**
   * Static busy flag — accessible from RedisIoAdapter (which runs outside DI).
   * Set by the singleton ScalingService instance during check().
   */
  static busy = false;

  constructor(private readonly moduleRef: ModuleRef) {
    this.threshold = parseInt(process.env.WS_SCALE_THRESHOLD || '80', 10);
    this.cooldownMs = parseInt(process.env.WS_SCALE_COOLDOWN || '120000', 10);
    this.cluster = process.env.ECS_CLUSTER || '';
    this.service = process.env.ECS_SERVICE || '';
    this.enabled = !!(this.cluster && this.service);
  }

  getThreshold(): number {
    return this.threshold;
  }

  getBusyState(): boolean {
    return this.isBusy;
  }

  async onModuleInit() {
    // Always start the check timer — server:busy/ready emit doesn't require ECS
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);

    if (!this.enabled) {
      this.logger.log(`ScalingService: overload detection active (threshold=${this.threshold}), ECS scaling disabled (ECS_CLUSTER/ECS_SERVICE not set)`);
      return;
    }

    try {
      const { ECSClient } = await import('@aws-sdk/client-ecs');
      this.ecsClient = new ECSClient({});
      this.logger.log(`ScalingService enabled (threshold=${this.threshold}, cooldown=${this.cooldownMs / 1000}s, every ${CHECK_INTERVAL_MS / 1000}s)`);
    } catch (e: unknown) {
      this.logger.warn(`ScalingService: @aws-sdk/client-ecs not available: ${(e as Error).message}`);
    }
  }

  onModuleDestroy() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async check() {
    try {
      const { GameGateway } = await import('../game/game.gateway');
      const gateway = this.moduleRef.get(GameGateway, { strict: false });
      if (!gateway?.server) return;

      // gateway.server is a Namespace when namespace is configured.
      // Root io.Server (with engine) is accessible via .server on the Namespace.
      const srv = gateway.server as any;
      const rootServer = srv.server ?? srv;
      const rootEngine = rootServer.engine ?? srv.engine;
      let currentConnections = rootEngine?.clientsCount ?? 0;

      // Filter engine.clientsCount=0 glitches: if we had connections recently
      // and suddenly see 0, use last known count (engine may reset between ticks)
      if (currentConnections > 0) {
        this.lastNonZeroCount = currentConnections;
      } else if (this.isBusy && this.lastNonZeroCount > 0) {
        // While busy, treat 0 as a glitch — keep last known count
        this.logger.warn(`check: connections=0 while busy (glitch?), using lastNonZero=${this.lastNonZeroCount}`);
        currentConnections = this.lastNonZeroCount;
      }

      const overloaded = currentConnections > this.threshold;
      const now = Date.now();

      if (currentConnections > 0 || this.isBusy) {
        this.logger.log(
          `check: connections=${currentConnections}, threshold=${this.threshold}, ` +
          `busy=${this.isBusy}, belowChecks=${this.belowThresholdChecks}/${READY_CHECKS_REQUIRED}`,
        );
      }

      if (overloaded && !this.isBusy) {
        // Transition to busy
        this.isBusy = true;
        this.busySince = now;
        this.belowThresholdChecks = 0;
        ScalingService.busy = true;
        this.emitToAll(rootServer, 'server:busy', {
          connections: currentConnections,
          threshold: this.threshold,
          etaSec: SCALE_UP_ETA_SEC,
        });
        this.logger.warn(`server:busy emitted (${currentConnections} > ${this.threshold})`);
      } else if (!overloaded && this.isBusy) {
        // Hysteresis: don't transition to ready immediately
        this.belowThresholdChecks++;

        const busyElapsed = now - this.busySince;
        if (busyElapsed >= MIN_BUSY_MS && this.belowThresholdChecks >= READY_CHECKS_REQUIRED) {
          // Stable below threshold for enough checks AND minimum busy time elapsed
          this.isBusy = false;
          this.belowThresholdChecks = 0;
          ScalingService.busy = false;
          this.emitToAll(rootServer, 'server:ready', {
            connections: currentConnections,
            threshold: this.threshold,
          });
          this.logger.log(`server:ready emitted (${currentConnections} <= ${this.threshold}, stable for ${this.belowThresholdChecks} checks)`);
        } else {
          this.logger.log(
            `server:busy held: elapsed=${Math.round(busyElapsed / 1000)}s/${MIN_BUSY_MS / 1000}s, ` +
            `belowChecks=${this.belowThresholdChecks}/${READY_CHECKS_REQUIRED}`,
          );
        }
      } else if (overloaded && this.isBusy) {
        // Still overloaded — reset below-threshold counter
        this.belowThresholdChecks = 0;
      }

      await this.checkAndScale(currentConnections);
    } catch (e: unknown) {
      this.logger.error(`ScalingService check failed: ${(e as Error).message}`);
    }
  }

  /** Emit event to all connected clients across all namespaces */
  private emitToAll(server: any, event: string, payload: Record<string, unknown>): void {
    // server.emit broadcasts to the default namespace (/)
    // Also emit to named namespaces where clients are connected
    server.emit(event, payload);
    for (const ns of ['/game', '/tournament', '/matchmaking', '/broadcast', '/messages']) {
      const nsp = server._nsps?.get(ns);
      if (nsp) nsp.emit(event, payload);
    }
  }

  async checkAndScale(currentConnections: number): Promise<void> {
    if (!this.enabled || !this.ecsClient) return;
    if (currentConnections <= this.threshold) return;

    const now = Date.now();
    if (now - this.lastScaleTime < this.cooldownMs) return;

    this.lastScaleTime = now;
    this.logger.warn(`Scale trigger: ${currentConnections} connections > threshold ${this.threshold}`);

    try {
      const { DescribeServicesCommand, UpdateServiceCommand } = await import('@aws-sdk/client-ecs');

      // Get current desired count
      const describeRes = await this.ecsClient.send(new DescribeServicesCommand({
        cluster: this.cluster,
        services: [this.service],
      }));

      const svc = describeRes.services?.[0];
      if (!svc) {
        this.logger.error('ScalingService: ECS service not found');
        return;
      }

      const currentDesired = svc.desiredCount ?? 1;
      const newDesired = currentDesired + 1;

      await this.ecsClient.send(new UpdateServiceCommand({
        cluster: this.cluster,
        service: this.service,
        desiredCount: newDesired,
      }));

      this.logger.log(`Scale-up: desiredCount ${currentDesired} → ${newDesired}`);
    } catch (e: unknown) {
      this.logger.error(`Scale-up failed: ${(e as Error).message}`);
    }
  }
}
