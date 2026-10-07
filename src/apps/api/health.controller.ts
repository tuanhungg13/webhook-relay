import { Controller, Get } from '@nestjs/common';
import { Public } from './http/public.js';

/** Liveness probe (spec 05): always 200 while the process is serving requests. */
@Controller()
export class HealthController {
  /** Trả `{ status: 'ok' }` cho mọi request; route công khai nên không cần key. */
  @Public()
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
