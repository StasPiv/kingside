import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Like JwtAuthGuard but does NOT reject unauthenticated requests.
 * If token is valid → req.user is set. If missing/invalid → req.user is undefined.
 */
@Injectable()
export class OptionalJwtGuard extends AuthGuard('jwt') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest<TUser = any>(_err: any, user: any): TUser {
    // Don't throw on missing/invalid token — just return null
    return user || null;
  }

  canActivate(context: ExecutionContext) {
    // Always allow the request through, but try to authenticate
    return super.canActivate(context);
  }
}
