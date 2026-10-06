import { Controller, Get } from '@nestjs/common';

/** Liveness probe (spec 05): always 200 while the process is serving requests. */
@Controller()
export class HealthController {
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
