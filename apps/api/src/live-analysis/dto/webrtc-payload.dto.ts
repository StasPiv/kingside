import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * KS-3836 / ADR-116 §2.2. DTO для WebRTC-сигналинга в namespace
 * `/live-analysis`. Все события привязаны к `lectureId` (UUID).
 *
 * `toSocketId` / `fromSocketId` — socket.io id'шники (короткие строки
 * с base64-алфавитом). Жёсткая регулярка не ставится: формат за нас
 * нормализует socket.io, нам достаточно ограничения на длину и тип.
 *
 * SDP — текст; верхний потолок 32 KB взят с большим запасом
 * относительно типичного offer'а (1.5–4 KB). При превышении →
 * `invalid-payload`.
 */

const MAX_SDP_LENGTH = 32 * 1024;
const MAX_SOCKET_ID = 64;

export class WebRTCPeerJoinedDto {
  @IsUUID()
  lectureId!: string;
}

export class WebRTCPeerLeftDto {
  @IsUUID()
  lectureId!: string;
}

export class WebRTCOfferDto {
  @IsUUID()
  lectureId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SOCKET_ID)
  toSocketId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SDP_LENGTH)
  sdp!: string;
}

export class WebRTCAnswerDto {
  @IsUUID()
  lectureId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SOCKET_ID)
  toSocketId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SDP_LENGTH)
  sdp!: string;
}

export class IceCandidateDto {
  @IsString()
  @MaxLength(1024)
  candidate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sdpMid?: string | null;

  @IsOptional()
  @IsInt()
  sdpMLineIndex?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  usernameFragment?: string | null;
}

export class WebRTCIceDto {
  @IsUUID()
  lectureId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SOCKET_ID)
  toSocketId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => IceCandidateDto)
  candidate!: IceCandidateDto;
}
