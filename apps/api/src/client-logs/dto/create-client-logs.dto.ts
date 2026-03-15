import { IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ClientLogEventDto } from './client-log-event.dto';

export class CreateClientLogsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClientLogEventDto)
  logs!: ClientLogEventDto[];
}
