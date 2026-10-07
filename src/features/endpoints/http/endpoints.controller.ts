import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
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
import type { CreateEndpoint } from '../use-cases/create-endpoint.use-case.js';
import type { DeleteEndpoint } from '../use-cases/delete-endpoint.use-case.js';
import type { DisableEndpoint } from '../use-cases/disable-endpoint.use-case.js';
import type { EnableEndpoint } from '../use-cases/enable-endpoint.use-case.js';
import type { GetEndpoint } from '../use-cases/get-endpoint.use-case.js';
import type { ListEndpoints } from '../use-cases/list-endpoints.use-case.js';
import type { RotateEndpointSecret } from '../use-cases/rotate-endpoint-secret.use-case.js';
import type { UpdateEndpoint } from '../use-cases/update-endpoint.use-case.js';
import {
  createEndpointBody,
  listEndpointsQuery,
  updateEndpointBody,
} from './endpoint.schemas.js';
import {
  type EndpointView,
  type EndpointWithSecretView,
  toEndpointView,
  toEndpointWithSecretView,
} from './endpoint.view.js';

/** Tám use case của endpoint, gom lại để controller nhận qua một tham số; lắp ở `ApiModule`. */
export interface EndpointUseCases {
  create: CreateEndpoint;
  get: GetEndpoint;
  list: ListEndpoints;
  update: UpdateEndpoint;
  delete: DeleteEndpoint;
  disable: DisableEndpoint;
  enable: EnableEndpoint;
  rotateSecret: RotateEndpointSecret;
}

/** Token Nest để tiêm `EndpointUseCases` (interface không tồn tại lúc chạy nên cần một Symbol). */
export const ENDPOINT_USE_CASES = Symbol('EndpointUseCases');

/** Phản hồi của `GET /v1/endpoints`: một trang và cursor trang sau (null khi hết, API-10). */
interface EndpointListView {
  data: EndpointView[];
  next_cursor: string | null;
}

/**
 * Các route `/v1/endpoints...` (spec 05, mục Endpoint). Mọi route cần API key (guard toàn cục).
 *
 * Controller chỉ kiểm đầu vào, gọi use case và đổi kết quả sang HTTP. ID sai định dạng, endpoint
 * không tồn tại, của app khác hay đã xóa đều trả CÙNG một `404` (DAT-04, API-04, API-33).
 */
@Controller('v1/endpoints')
export class EndpointsController {
  constructor(
    @Inject(ENDPOINT_USE_CASES) private readonly useCases: EndpointUseCases,
  ) {}

  /** Tạo endpoint: `201` kèm `secret`; URL sai hoặc vượt giới hạn → `422`. */
  @Post()
  async create(
    @CurrentApp() app: AuthenticatedApp,
    @Body() body: unknown,
  ): Promise<EndpointWithSecretView> {
    const input = parseWith(createEndpointBody, body);
    const result = await this.useCases.create.execute({
      appId: app.appId,
      customerId: input.customer_id,
      url: input.url,
      eventTypes: input.event_types,
      rateLimitRps: input.rate_limit_rps,
      maxConcurrency: input.max_concurrency,
    });
    switch (result.status) {
      case 'created':
        return toEndpointWithSecretView(result.endpoint);
      case 'invalid_url':
        throw invalidUrl(result.message);
      case 'limit_exceeded':
        throw new ApiError(
          422,
          'limit_exceeded',
          'too many endpoints for this customer',
          { limit: result.limit },
        );
    }
  }

  /** Danh sách endpoint, mới nhất trước, phân trang bằng cursor (API-10). */
  @Get()
  async list(
    @CurrentApp() app: AuthenticatedApp,
    @Query() query: unknown,
  ): Promise<EndpointListView> {
    const input = parseWith(listEndpointsQuery, query);
    const afterId =
      input.cursor === undefined
        ? undefined
        : decodeCursor(input.cursor, (id) => parseId('endpoint', id));
    const page = await this.useCases.list.execute({
      appId: app.appId,
      customerId: input.customer_id,
      afterId,
      limit: input.limit,
    });
    return {
      data: page.endpoints.map(toEndpointView),
      next_cursor: page.nextAfterId && encodeCursor(page.nextAfterId),
    };
  }

  /** Xem một endpoint, không có secret. */
  @Get(':id')
  async get(
    @CurrentApp() app: AuthenticatedApp,
    @Param('id') id: string,
  ): Promise<EndpointView> {
    const result = await this.useCases.get.execute({
      appId: app.appId,
      id: endpointIdOr404(id),
    });
    if (result.status === 'not_found') throw notFound();
    return toEndpointView(result.endpoint);
  }

  /** Sửa một phần; trường lạ, body rỗng hay URL sai → `422`. */
  @Patch(':id')
  async update(
    @CurrentApp() app: AuthenticatedApp,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<EndpointView> {
    const endpointId = endpointIdOr404(id);
    const input = parseWith(updateEndpointBody, body);
    const result = await this.useCases.update.execute({
      appId: app.appId,
      id: endpointId,
      patch: {
        url: input.url,
        eventTypes: input.event_types,
        rateLimitRps: input.rate_limit_rps,
        maxConcurrency: input.max_concurrency,
      },
    });
    switch (result.status) {
      case 'updated':
        return toEndpointView(result.endpoint);
      case 'not_found':
        throw notFound();
      case 'invalid_url':
        throw invalidUrl(result.message);
    }
  }

  /** Xóa mềm: `204`; xóa lần hai → `404` (API-33). */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentApp() app: AuthenticatedApp,
    @Param('id') id: string,
  ): Promise<void> {
    const result = await this.useCases.delete.execute({
      appId: app.appId,
      id: endpointIdOr404(id),
    });
    if (result.status === 'not_found') throw notFound();
  }

  /** Vô hiệu hóa (idempotent): `204`. */
  @Post(':id/disable')
  @HttpCode(204)
  async disable(
    @CurrentApp() app: AuthenticatedApp,
    @Param('id') id: string,
  ): Promise<void> {
    const result = await this.useCases.disable.execute({
      appId: app.appId,
      id: endpointIdOr404(id),
    });
    if (result.status === 'not_found') throw notFound();
  }

  /** Kích hoạt lại (idempotent): `204`. */
  @Post(':id/enable')
  @HttpCode(204)
  async enable(
    @CurrentApp() app: AuthenticatedApp,
    @Param('id') id: string,
  ): Promise<void> {
    const result = await this.useCases.enable.execute({
      appId: app.appId,
      id: endpointIdOr404(id),
    });
    if (result.status === 'not_found') throw notFound();
  }

  /** Xoay secret: `200` kèm endpoint và `secret` mới (API-35). */
  @Post(':id/rotate-secret')
  @HttpCode(200)
  async rotateSecret(
    @CurrentApp() app: AuthenticatedApp,
    @Param('id') id: string,
  ): Promise<EndpointWithSecretView> {
    const result = await this.useCases.rotateSecret.execute({
      appId: app.appId,
      id: endpointIdOr404(id),
    });
    if (result.status === 'not_found') throw notFound();
    return toEndpointWithSecretView(result.endpoint);
  }
}

/** Đọc ID endpoint từ đường dẫn; sai định dạng thì ném `404` y như không tìm thấy (DAT-04). */
function endpointIdOr404(text: string): Id<'endpoint'> {
  const id = parseId('endpoint', text);
  if (id === null) throw notFound();
  return id;
}

/** `404` duy nhất của endpoint: message cố định để mọi trường hợp không tìm thấy giống từng byte. */
function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'endpoint not found');
}

/** `422` cho URL sai luật tĩnh, cùng dạng `details` với lỗi kiểm đầu vào khác. */
function invalidUrl(message: string): ApiError {
  return validationFailed([{ field: 'url', message }]);
}
