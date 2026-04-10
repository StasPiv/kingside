import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { I18nService } from 'nestjs-i18n';
import { JwtPayload } from '../../auth/jwt.strategy';

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly i18n: I18nService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    const token =
      client.handshake.auth?.token ||
      client.handshake.query?.token;

    if (!token) {
      throw new WsException(this.i18n.t('messages.auth.missingToken'));
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(String(token));
      client.data.user = { id: payload.sub, username: payload.username };
      return true;
    } catch {
      throw new WsException(this.i18n.t('messages.auth.invalidToken'));
    }
  }
}
