import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('ADMIN_API_KEY', '');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.apiKey) throw new ForbiddenException('Admin API not configured');
    const request = context.switchToHttp().getRequest();
    const key = request.headers['x-admin-key'];
    if (key !== this.apiKey) throw new ForbiddenException('Invalid admin key');
    return true;
  }
}
