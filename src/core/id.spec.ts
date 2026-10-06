import { idFromUuid, idToUuid, newId, parseId } from './id.js';

const SUFFIX_OF_UUID_V7_EXAMPLE = '01h455vb4pex5vsknk084sn02q';
const UUID_V7_EXAMPLE = '01890a5d-ac96-774b-bcce-b302099a8057';

/** Official TypeID spec vectors (typeid/spec valid.yml), suffix ↔ UUID. */
const VALID_VECTORS = [
  ['00000000000000000000000000', '00000000-0000-0000-0000-000000000000'],
  ['00000000000000000000000001', '00000000-0000-0000-0000-000000000001'],
  ['0000000000000000000000000a', '00000000-0000-0000-0000-00000000000a'],
  ['0000000000000000000000000g', '00000000-0000-0000-0000-000000000010'],
  ['00000000000000000000000010', '00000000-0000-0000-0000-000000000020'],
  ['7zzzzzzzzzzzzzzzzzzzzzzzzz', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
  [SUFFIX_OF_UUID_V7_EXAMPLE, UUID_V7_EXAMPLE],
] as const;

describe('idFromUuid / idToUuid', () => {
  it.each(VALID_VECTORS)('encodes and decodes %s', (suffix, uuid) => {
    const id = idFromUuid('event', uuid);

    expect(id).toBe(`evt_${suffix}`);
    expect(idToUuid(id)).toBe(uuid);
  });

  it('uses the prefix of each kind (DAT-02)', () => {
    expect(idFromUuid('app', UUID_V7_EXAMPLE)).toMatch(/^app_/);
    expect(idFromUuid('apiKey', UUID_V7_EXAMPLE)).toMatch(/^key_/);
    expect(idFromUuid('endpoint', UUID_V7_EXAMPLE)).toMatch(/^ep_/);
    expect(idFromUuid('event', UUID_V7_EXAMPLE)).toMatch(/^evt_/);
    expect(idFromUuid('delivery', UUID_V7_EXAMPLE)).toMatch(/^del_/);
    expect(idFromUuid('attempt', UUID_V7_EXAMPLE)).toMatch(/^att_/);
  });

  it('accepts upper-case UUID input and always outputs lower case', () => {
    const id = idFromUuid('event', UUID_V7_EXAMPLE.toUpperCase());

    expect(idToUuid(id)).toBe(UUID_V7_EXAMPLE);
  });

  it.each([
    '',
    'not-a-uuid',
    '01890a5dac96774bbcceb302099a8057',
    '01890a5d-ac96-774b-bcce-b302099a805',
  ])(
    'throws on malformed UUID %j (corrupt stored data is a bug, not input)',
    (uuid) => {
      expect(() => idFromUuid('event', uuid)).toThrow(/invalid uuid/);
    },
  );
});

describe('parseId', () => {
  it.each(VALID_VECTORS)('accepts evt_%s', (suffix) => {
    expect(parseId('event', `evt_${suffix}`)).toBe(`evt_${suffix}`);
  });

  it.each([
    ['wrong prefix (DAT-04)', `del_${SUFFIX_OF_UUID_V7_EXAMPLE}`],
    ['upper-case prefix', `EVT_${SUFFIX_OF_UUID_V7_EXAMPLE}`],
    ['upper-case suffix', `evt_${SUFFIX_OF_UUID_V7_EXAMPLE.toUpperCase()}`],
    ['missing prefix', SUFFIX_OF_UUID_V7_EXAMPLE],
    ['missing separator', `evt${SUFFIX_OF_UUID_V7_EXAMPLE}`],
    ['empty suffix', 'evt_'],
    ['suffix too short', 'evt_0000000000000000000000000'],
    ['suffix too long', 'evt_000000000000000000000000000'],
    ['suffix overflows 128 bits', 'evt_8zzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['letter outside Crockford alphabet', 'evt_0000000000000000000000000u'],
    ['ambiguous letter o', 'evt_0000000000000000000000000o'],
    ['raw UUID', `evt_${UUID_V7_EXAMPLE}`],
    ['empty string', ''],
  ])('rejects %s', (_case, text) => {
    expect(parseId('event', text)).toBeNull();
  });
});

describe('newId', () => {
  const NOW_MS = Date.UTC(2026, 9, 6, 12, 0, 0, 123);

  it('produces a parseable id of the requested kind', () => {
    const id = newId('delivery', NOW_MS);

    expect(parseId('delivery', id)).toBe(id);
  });

  it('is a UUIDv7 carrying the given millisecond timestamp (DAT-01)', () => {
    const hex = idToUuid(newId('event', NOW_MS)).replaceAll('-', '');

    expect(Number.parseInt(hex.slice(0, 12), 16)).toBe(NOW_MS);
    expect(hex[12]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(hex[16]);
  });

  it('sorts by time across milliseconds', () => {
    const earlier = newId('event', NOW_MS);
    const later = newId('event', NOW_MS + 1);

    expect(earlier < later).toBe(true);
  });

  it('is unique within the same millisecond', () => {
    const ids = new Set(
      Array.from({ length: 1_000 }, () => newId('event', NOW_MS)),
    );

    expect(ids.size).toBe(1_000);
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 48])(
    'throws on timestamp %s outside 48-bit range',
    (ms) => {
      expect(() => newId('event', ms)).toThrow(RangeError);
    },
  );
});
