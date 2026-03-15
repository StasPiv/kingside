import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  override getAuthenticateOptions() {
    return { session: false };
  }
}

@Injectable()
export class FacebookAuthGuard extends AuthGuard('facebook') {
  override getAuthenticateOptions() {
    return { session: false };
  }
}
