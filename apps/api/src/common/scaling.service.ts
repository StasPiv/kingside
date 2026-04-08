import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

const CHECK_INTERVAL_MS = 15_000;

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

  constructor(private readonly moduleRef: ModuleRef) {
    this.threshold = parseInt(process.env.WS_SCALE_THRESHOLD || '80', 10);
    this.cooldownMs = parseInt(process.env.WS_SCALE_COOLDOWN || '120000', 10);
    this.cluster = process.env.ECS_CLUSTER || '';
    this.service = process.env.ECS_SERVICE || '';
    this.enabled = !!(this.cluster && this.service);
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.log('ScalingService disabled (ECS_CLUSTER/ECS_SERVICE not set)');
      return;
    }

    try {
      const { ECSClient } = await import('@aws-sdk/client-ecs');
      this.ecsClient = new ECSClient({});
      this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
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
      const currentConnections = gateway?.server?.engine?.clientsCount ?? 0;
      await this.checkAndScale(currentConnections);
    } catch (e: unknown) {
      this.logger.error(`ScalingService check failed: ${(e as Error).message}`);
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
