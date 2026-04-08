import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

const CHECK_INTERVAL_MS = 15_000;
/** Estimated time for a new instance to become healthy (seconds) */
const SCALE_UP_ETA_SEC = 60;

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

      // gateway.server is a Namespace (not root Server) when namespace is set.
      // Root server with engine is at .server.server
      const rootServer = (gateway.server as any).server ?? gateway.server;
      const currentConnections = rootServer.engine?.clientsCount ?? 0;
      const overloaded = currentConnections > this.threshold;

      this.logger.log(`check: connections=${currentConnections}, threshold=${this.threshold}, busy=${this.isBusy}`);

      if (overloaded && !this.isBusy) {
        // Transition to busy
        this.isBusy = true;
        ScalingService.busy = true;
        this.emitToAll(rootServer, 'server:busy', {
          connections: currentConnections,
          threshold: this.threshold,
          etaSec: SCALE_UP_ETA_SEC,
        });
        this.logger.warn(`server:busy emitted (${currentConnections} > ${this.threshold})`);
      } else if (!overloaded && this.isBusy) {
        // Transition to ready
        this.isBusy = false;
        ScalingService.busy = false;
        this.emitToAll(rootServer, 'server:ready', {
          connections: currentConnections,
          threshold: this.threshold,
        });
        this.logger.log(`server:ready emitted (${currentConnections} <= ${this.threshold})`);
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
