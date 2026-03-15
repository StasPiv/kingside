import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CreateClientLogsDto } from './dto/create-client-logs.dto';
import { IpRateLimitGuard } from './ip-rate-limit.guard';

@Controller('logs')
export class ClientLogsController {
  private readonly logger = new Logger(ClientLogsController.name);

  @Post()
  @UseGuards(IpRateLimitGuard)
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateClientLogsDto): void {
    for (const event of dto.logs) {
      this.logger.log(
        `[client] type=${event.type} ts=${event.timestamp} url=${event.url ?? '-'} msg=${event.message}${event.stack ? ` stack=${event.stack}` : ''}`,
      );
    }
  }
}
