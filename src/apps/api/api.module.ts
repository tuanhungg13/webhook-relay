import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

/** Composition root of the `api` process: wires feature HTTP modules to adapters. */
@Module({
  controllers: [HealthController],
})
export class ApiModule {}
