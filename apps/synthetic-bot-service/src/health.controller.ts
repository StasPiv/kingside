import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health(): { status: string; taskId: string; uptime: number } {
    return {
      status: 'ok',
      taskId: process.env.ECS_TASK_ID || 'local',
      uptime: process.uptime(),
    };
  }
}
