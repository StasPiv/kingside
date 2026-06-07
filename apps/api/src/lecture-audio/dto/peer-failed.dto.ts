import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * KS-3837 / ADR-116 §6.2. DTO тела запроса
 * `POST /lecture-audio/peer-failed` — метрика провального WebRTC-
 * соединения. Принимаем как от авторизованных, так и от анонимных
 * клиентов (зритель публичной лекции).
 *
 * Поля:
 *   - lectureId — UUID лекции.
 *   - reason — короткий ярлык причины («ice_failed», «handshake_timeout»,
 *     «sdp_negotiation_failed» и т.п.). Не валидируем enum'ом, потому
 *     что список будет дополняться фронтом; ограничиваемся длиной.
 *   - role — кто рапортует (publisher = тренер, subscriber = зритель).
 *   - iceConnectionState — последнее зафиксированное значение
 *     `RTCPeerConnection.iceConnectionState` (`new` | `checking` |
 *     `connected` | `completed` | `failed` | `disconnected` | `closed`).
 *     Тоже не enum — браузеры могут выдать что-то нестандартное.
 */

const MAX_REASON = 64;
const MAX_ICE_STATE = 32;

export class PeerFailedDto {
  @IsUUID()
  lectureId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_REASON)
  reason!: string;

  @IsIn(['publisher', 'subscriber'])
  role!: 'publisher' | 'subscriber';

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_ICE_STATE)
  iceConnectionState!: string;
}
