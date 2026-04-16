import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminApiKeyGuard } from '../admin/admin-api-key.guard';
import { ToolExecutorService } from './tool-executor.service';

@Controller('internal/tools')
@UseGuards(AdminApiKeyGuard)
export class ToolExecutorController {
  constructor(private readonly toolExecutor: ToolExecutorService) {}

  @Get(':toolName')
  execute(
    @Param('toolName') toolName: string,
    @Query('userId') userId: string,
    @Query() params: Record<string, string>,
  ) {
    const { userId: _, toolName: __, ...toolParams } = params;
    return this.toolExecutor.execute(toolName, userId, toolParams);
  }
}
