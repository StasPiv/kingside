import { Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { JwtPayload } from './jwt.strategy';

const THROTTLE_SEC = 60;

@Injectable()
export class LastSeenMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      next();
      return;
    }

    try {
      const payload = this.jwt.verify<JwtPayload>(header.slice(7));
      const userId = payload.sub;
      if (userId && !userId.startsWith('pending:')) {
        const key = `lastSeen:${userId}`;
        const set = await this.redis.set(key, '1', 'EX', THROTTLE_SEC, 'NX');
        if (set) {
          await this.prisma.user.update({
            where: { id: userId },
            data: { lastSeenAt: new Date() },
          });
        }
      }
    } catch {
      // Invalid token or DB error — silently ignore
    }

    next();
  }
}
