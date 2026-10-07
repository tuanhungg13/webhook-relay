import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { checkEventPayload } from '../../../core/event-payload.js';
import { type Id, parseId } from '../../../core/id.js';
import { ApiError } from '../../../platform/http/api-error.js';
import {
  type AuthenticatedApp,
  CurrentApp,
} from '../../../platform/http/current-app.js';
import {
  decodeCursor,
  encodeCursor,
} from '../../../platform/http/pagination.js';
import {
  parseWith,
  validationFailed,
} from '../../../platform/http/validate.js';
import type { GetEvent } from '../use-cases/get-event.use-case.js';
import type { IngestEvent } from '../use-cases/ingest-event.use-case.js';
import type { ListEvents } from '../use-cases/list-events.use-case.js';
import { ingestEventBody, listEventsQuery } from './event.schemas.js';
import {
  type EventDetailView,
  type EventSummaryView,
  type IngestedEventView,
  toEventDetailView,
  toEventSummaryView,
  toIngestedEventView,
} from './event.view.js';

/** Ba use case của sự kiện, gom lại để controller nhận qua một tham số; lắp ở `ApiModule`. */
export interface IngestionUseCases {
  ingest: IngestEvent;
  get: GetEvent;
  list: ListEvents;
}

/** Token Nest để tiêm `IngestionUseCases` (interface không tồn tại lúc chạy nên cần một Symbol). */
export const INGESTION_USE_CASES = Symbol('IngestionUseCases');

/** Mã HTTP khi sự kiện trùng khóa idempotency và cùng nội dung: App coi như đã nhận (spec 05). */
const HTTP_OK = 200;

/** Phản hồi của `GET /v1/events`: một trang và cursor trang sau (null khi hết, API-10). */
interface EventListView {
  data: EventSummaryView[];
  next_cursor: string | null;
}

/**
 * Các route `/v1/events...` (spec 05, mục Sự kiện). Mọi route cần API key (guard toàn cục).
 *
 * Sự kiện không tồn tại, của app khác hay ID sai định dạng đều trả CÙNG một `404` (DAT-04,
 * API-04); cursor trỏ tới sự kiện không thuộc (app, customer) đang hỏi là `422` như cursor hỏng.
 */
@Controller('v1/events')
export class EventsController {
  constructor(
    @Inject(INGESTION_USE_CASES) private readonly useCases: IngestionUseCases,
  ) {}

  /**
   * Gửi sự kiện: `202` khi mới, `200` khi trùng khóa cùng nội dung, `409` khi trùng khóa khác
   * nội dung, `422` khi đầu vào sai. Mã `200` đặt qua `@Res({ passthrough })`: Nest vẫn lo phần
   * trả body, và lỗi ném ra vẫn đi qua filter toàn cục.
   */
  @Post()
  @HttpCode(202)
  async ingest(
    @CurrentApp() app: AuthenticatedApp,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<IngestedEventView> {
    const input = parseWith(ingestEventBody, body);
    const issue = checkEventPayload(input.payload);
    if (issue) {
      throw validationFailed([{ field: issue.path, message: issue.message }]);
    }
    const result = await this.useCases.ingest.execute({
      appId: app.appId,
      customerId: input.customer_id,
      type: input.type,
      payload: input.payload,
      idempotencyKey: input.idempotency_key,
    });
    switch (result.status) {
      case 'created':
        return toIngestedEventView(result);
      case 'duplicate':
        response.status(HTTP_OK);
        return toIngestedEventView(result);
      case 'conflict':
        throw new ApiError(
          409,
          'idempotency_conflict',
          'idempotency_key was already used with a different request',
        );
    }
  }

  /** Danh sách sự kiện của một customer, mới nhất trước, không kèm payload (API-10). */
  @Get()
  async list(
    @CurrentApp() app: AuthenticatedApp,
    @Query() query: unknown,
  ): Promise<EventListView> {
    const input = parseWith(listEventsQuery, query);
    const afterId =
      input.cursor === undefined
        ? undefined
        : decodeCursor(input.cursor, (id) => parseId('event', id));
    const result = await this.useCases.list.execute({
      appId: app.appId,
      customerId: input.customer_id,
      type: input.type,
      afterId,
      limit: input.limit,
    });
    if (result.status === 'invalid_cursor') {
      throw validationFailed([{ field: 'cursor', message: 'invalid cursor' }]);
    }
    return {
      data: result.events.map(toEventSummaryView),
      next_cursor: result.nextAfterId && encodeCursor(result.nextAfterId),
    };
  }

  /** Xem một sự kiện đầy đủ kèm delivery tóm tắt. */
  @Get(':id')
  async get(
    @CurrentApp() app: AuthenticatedApp,
    @Param('id') id: string,
  ): Promise<EventDetailView> {
    const result = await this.useCases.get.execute({
      appId: app.appId,
      id: eventIdOr404(id),
    });
    if (result.status === 'not_found') throw notFound();
    return toEventDetailView(result.event);
  }
}

/** Đọc ID sự kiện từ đường dẫn; sai định dạng thì ném `404` y như không tìm thấy (DAT-04). */
function eventIdOr404(text: string): Id<'event'> {
  const id = parseId('event', text);
  if (id === null) throw notFound();
  return id;
}

/** `404` duy nhất của sự kiện: message cố định để mọi trường hợp không tìm thấy giống từng byte. */
function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'event not found');
}
