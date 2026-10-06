import { parseArgs } from 'node:util';
import {
  ID_KINDS,
  type IdKind,
  idFromUuid,
  idToUuid,
  parseId,
} from '../../core/id.js';
import type { AccessStore } from '../../features/access/access-store.port.js';
import { CreateApp } from '../../features/access/create-app.use-case.js';
import { IssueApiKey } from '../../features/access/issue-api-key.use-case.js';
import { RevokeApiKey } from '../../features/access/revoke-api-key.use-case.js';
import type { Clock } from '../../platform/clock.js';

/** Hướng dẫn sử dụng, được in ra khi người dùng gõ sai hoặc thiếu lệnh. */
export const USAGE = `usage:
  admin app create --name <name>
  admin key issue --app <app_id>
  admin key revoke --key <key_id>
  admin id decode <typeid>
  admin id encode --kind <${ID_KINDS.join('|')}> <uuid>`;

/** Kết quả của một lệnh: một object, sẽ được `main` in ra dạng JSON. */
type Output = Record<string, unknown>;
/** Các cờ `--xxx` mà CLI hiểu. Cờ nào người dùng không gõ thì có giá trị undefined. */
type Options = { name?: string; app?: string; key?: string; kind?: string };

/**
 * Chạy một lệnh quản trị và trả về kết quả để `main` in ra.
 *
 * Tạo app và cấp key chỉ làm được qua CLI này, không có API HTTP, để giảm chỗ bị tấn công (API-40).
 * - `argv`: các từ người dùng gõ sau `admin`, vd `['key', 'issue', '--app', 'app_...']`.
 * - `deps`: đồ nghề do `main` truyền vào: `store` để đọc/ghi dữ liệu, `clock` để lấy giờ.
 *   Nhận từ ngoài vào (không tự tạo) nên test có thể truyền database test và đồng hồ cố định.
 *
 * Lệnh sai, thiếu tham số hoặc không tìm thấy dữ liệu → ném lỗi kèm câu báo cho người vận hành.
 */
export async function runAdminCli(
  argv: string[],
  deps: { store: AccessStore; clock: Clock },
): Promise<Output> {
  const { values, positionals } = parseCommandLine(argv);
  // Hai từ đầu là tên lệnh (vd 'key issue'); các từ đứng riêng còn lại là tham số (vd typeid).
  const [group, action, ...rest] = positionals;
  const command = `${group} ${action}`;

  switch (command) {
    case 'app create':
      return createApp(values, deps);
    case 'key issue':
      return issueKey(values, deps);
    case 'key revoke':
      return revokeKey(values, deps);
    case 'id decode':
      return decodeId(rest[0]);
    case 'id encode':
      return encodeId(values.kind, rest[0]);
    default:
      throw new Error(USAGE);
  }
}

/**
 * Tách dòng lệnh thành hai phần bằng `parseArgs` có sẵn của Node:
 * - `values`: các cờ có giá trị, vd `--app app_123` → `{ app: 'app_123' }`.
 * - `positionals`: các từ đứng riêng, vd `['key', 'issue']`.
 * Gõ cờ không được khai báo (vd `--foo`) → ném lỗi kèm hướng dẫn sử dụng.
 */
function parseCommandLine(argv: string[]): {
  values: Options;
  positionals: string[];
} {
  try {
    return parseArgs({
      args: argv,
      options: {
        name: { type: 'string' },
        app: { type: 'string' },
        key: { type: 'string' },
        kind: { type: 'string' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    // Lỗi của parseArgs chỉ nói cờ nào sai; thêm USAGE để người dùng biết gõ lại thế nào.
    throw new Error(`${(error as Error).message}\n${USAGE}`);
  }
}

/** Lệnh `app create --name <tên>`: tạo app mới, trả về ID của app. */
async function createApp(
  values: Options,
  deps: { store: AccessStore; clock: Clock },
) {
  const { appId } = await new CreateApp(deps.store, deps.clock).execute({
    name: required(values.name, '--name'),
  });
  return { app_id: appId };
}

/**
 * Lệnh `key issue --app <app_id>`: cấp API key mới cho app.
 * Trả về ID của key, key thật và prefix. App không tồn tại → ném lỗi "app not found".
 */
async function issueKey(
  values: Options,
  deps: { store: AccessStore; clock: Clock },
) {
  const appId = parseRequiredId('app', required(values.app, '--app'));
  const result = await new IssueApiKey(deps.store, deps.clock).execute({
    appId,
  });
  // Rẽ nhánh theo `status`: trong mỗi nhánh TypeScript biết `result` có những trường nào
  // (vd chỉ nhánh 'issued' mới có `apiKey`).
  switch (result.status) {
    case 'app_not_found':
      throw new Error(`app not found: ${appId}`);
    case 'issued':
      // Lần duy nhất key thật được hiển thị; sau đó hệ thống chỉ còn hash, không lấy lại được (SEC-10).
      return {
        key_id: result.keyId,
        api_key: result.apiKey,
        prefix: result.prefix,
      };
  }
}

/**
 * Lệnh `key revoke --key <key_id>`: thu hồi key, trả về thời điểm thu hồi.
 * Key không tồn tại → ném lỗi "key not found".
 */
async function revokeKey(
  values: Options,
  deps: { store: AccessStore; clock: Clock },
) {
  const keyId = parseRequiredId('apiKey', required(values.key, '--key'));
  const result = await new RevokeApiKey(deps.store, deps.clock).execute({
    keyId,
  });
  switch (result.status) {
    case 'key_not_found':
      throw new Error(`key not found: ${keyId}`);
    case 'revoked':
      return { key_id: keyId, revoked_at: result.revokedAt.toISOString() };
  }
}

/**
 * Lệnh `id decode <typeid>`: đổi TypeID (vd `evt_01h4...`) sang UUID để tra trong database.
 * Không cần nói loại ID: hàm thử lần lượt từng loại, loại nào khớp tiền tố thì dùng loại đó.
 */
function decodeId(text: string | undefined): Output {
  const value = required(text, '<typeid>');
  for (const kind of ID_KINDS) {
    const id = parseId(kind, value);
    if (id) return { kind, uuid: idToUuid(id) };
  }
  throw new Error(`not a valid id: ${value}`);
}

/**
 * Lệnh `id encode --kind <loại> <uuid>`: đổi UUID (vd copy từ database) sang TypeID.
 * Loại không hợp lệ → ném lỗi, kèm danh sách các loại được phép.
 */
function encodeId(kind: string | undefined, uuid: string | undefined): Output {
  const idKind = required(kind, '--kind');
  if (!isIdKind(idKind))
    throw new Error(`unknown kind "${idKind}" (${ID_KINDS.join(', ')})`);
  return { id: idFromUuid(idKind, required(uuid, '<uuid>')) };
}

/**
 * Kiểm tra `text` có phải ID loại `kind` không. Đúng thì trả về ID đã có kiểu `Id<K>`,
 * sai thì ném lỗi dễ đọc, vd "not a valid key id: evt_...".
 */
function parseRequiredId<K extends IdKind>(kind: K, text: string) {
  const id = parseId(kind, text);
  if (!id)
    throw new Error(
      // Loại 'apiKey' được báo là "key" cho khớp với cờ --key mà người dùng đã gõ.
      `not a valid ${kind === 'apiKey' ? 'key' : kind} id: ${text}`,
    );
  return id;
}

/** Trả về `value` nếu người dùng có gõ; thiếu thì ném lỗi "missing <name>" kèm hướng dẫn. */
function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`missing ${name}\n${USAGE}`);
  return value;
}

/**
 * Kiểm tra chuỗi có phải tên một loại ID hợp lệ không ('app', 'event'...).
 * Kiểu trả về `value is IdKind` báo cho TypeScript: sau khi hàm trả true, `value` là IdKind.
 */
function isIdKind(value: string): value is IdKind {
  return (ID_KINDS as readonly string[]).includes(value);
}
