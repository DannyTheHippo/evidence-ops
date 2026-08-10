import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { parseSelect } from '../utils/parse-select.util';
import { pickFields } from '../utils/pick-fields.util';

@Injectable()
export class SelectInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const fields = parseSelect(request.query?.select);

    if (request.method !== 'GET' || !fields.length) {
      return next.handle();
    }

    return next.handle().pipe(
      map((response: unknown) => {
        if (response === null || typeof response !== 'object') {
          return response;
        }

        if (Array.isArray(response)) {
          return response.map((item) => pickFields(item, fields));
        }

        const wrapper = response as { docs?: unknown };
        if (Array.isArray(wrapper.docs)) {
          return { ...response, docs: wrapper.docs.map((doc) => pickFields(doc, fields)) };
        }

        return pickFields(response, fields);
      }),
    );
  }
}
