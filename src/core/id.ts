import { randomBytes } from 'node:crypto';

/**
 * DAT-01..03 / D-17: ids are UUIDv7, stored as native `uuid` in Postgres and shown everywhere
 * else as TypeID (`<prefix>_<26 Crockford base32 chars>`, https://github.com/jetify-com/typeid).
 * Conversion lives only here and in the Postgres adapter.
 */
const ID_PREFIXES = {
  app: 'app',
  apiKey: 'key',
  endpoint: 'ep',
  event: 'evt',
  delivery: 'del',
  attempt: 'att',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

declare const idKind: unique symbol;
/** A TypeID string checked to belong to kind `K`; only produced by this module. */
export type Id<K extends IdKind> = string & { readonly [idKind]: K };

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const SUFFIX_LENGTH = 26;
// 26 chars × 5 bits = 130 bits for a 128-bit value, so the first char carries at most 3 bits.
const SUFFIX_PATTERN = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UUID_V7_TIMESTAMP_MS = 2 ** 48 - 1;
const UUID_BYTES = 16;
const TIMESTAMP_BYTES = 6;

/** UUIDv7 (RFC 9562) for `nowMs`; the caller passes app-clock time (DAT-22). */
export function newId<K extends IdKind>(kind: K, nowMs: number): Id<K> {
  if (
    !Number.isInteger(nowMs) ||
    nowMs < 0 ||
    nowMs > MAX_UUID_V7_TIMESTAMP_MS
  ) {
    throw new RangeError(
      `UUIDv7 timestamp must be an integer in [0, 2^48): ${nowMs}`,
    );
  }
  const bytes = randomBytes(UUID_BYTES);
  bytes.writeUIntBE(nowMs, 0, TIMESTAMP_BYTES);
  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10
  return withPrefix(kind, encodeSuffix(BigInt(`0x${bytes.toString('hex')}`)));
}

/**
 * Validates untrusted input (API path, query). Wrong format and wrong prefix both give null,
 * so callers answer exactly like a missing resource (DAT-04).
 */
export function parseId<K extends IdKind>(kind: K, text: string): Id<K> | null {
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!text.startsWith(prefix)) return null;
  return SUFFIX_PATTERN.test(text.slice(prefix.length))
    ? (text as Id<K>)
    : null;
}

/** For values read from Postgres: a malformed uuid there is a bug, so it throws. */
export function idFromUuid<K extends IdKind>(kind: K, uuid: string): Id<K> {
  if (!UUID_PATTERN.test(uuid))
    throw new Error(`invalid uuid: ${JSON.stringify(uuid)}`);
  return withPrefix(
    kind,
    encodeSuffix(BigInt(`0x${uuid.replaceAll('-', '')}`)),
  );
}

export function idToUuid(id: Id<IdKind>): string {
  const suffix = id.slice(id.lastIndexOf('_') + 1);
  const hex = decodeSuffix(suffix)
    .toString(16)
    .padStart(UUID_BYTES * 2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function withPrefix<K extends IdKind>(kind: K, suffix: string): Id<K> {
  return `${ID_PREFIXES[kind]}_${suffix}` as Id<K>;
}

function encodeSuffix(value: bigint): string {
  let remaining = value;
  let suffix = '';
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    suffix = ALPHABET[Number(remaining & 31n)] + suffix;
    remaining >>= 5n;
  }
  return suffix;
}

function decodeSuffix(suffix: string): bigint {
  let value = 0n;
  for (const char of suffix)
    value = (value << 5n) | BigInt(ALPHABET.indexOf(char));
  return value;
}
