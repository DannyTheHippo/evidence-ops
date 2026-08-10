import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AsyncLocalStorage } from 'node:async_hooks';
import { IS_PUBLIC_ROUTE } from '../../../../shared/decorators/public-route.decorator';
import { AlsContext } from '../../../../shared/types/als-context.type';
import { AuthenticatedRequest } from '../../../../shared/types/authenticated-request.type';
import { JwtPayload } from '../types/jwt-payload.type';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,

    @Inject(AsyncLocalStorage)
    private readonly als: AsyncLocalStorage<AlsContext>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = JwtAuthGuard.extractToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);

      request.user = { userId: payload.sub, email: payload.email };

      const store = this.als.getStore();
      if (store) {
        store.user = payload.sub;
      }

      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private static extractToken(header?: string): string | undefined {
    if (!header?.startsWith('Bearer ')) {
      return undefined;
    }

    return header.slice('Bearer '.length).trim() || undefined;
  }
}
