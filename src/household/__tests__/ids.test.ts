import { pairId, sha1Hex, uuidv5 } from '../ids';

describe('ids', () => {
  it('sha1Hex matches FIPS 180-1', () => {
    expect(sha1Hex(new TextEncoder().encode('abc'))).toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    );
    expect(sha1Hex(new Uint8Array(0))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    const long = new TextEncoder().encode(
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    );
    expect(sha1Hex(long)).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1');
  });
  it('uuidv5 matches the RFC vector', () => {
    expect(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });
  it('pairId is stable and ordered', () => {
    expect(pairId('p1', 'm1')).toBe('cf608052-d4df-5679-a3f3-5083397fa5a7');
    expect(pairId('p1', 'm1')).not.toBe(pairId('m1', 'p1'));
  });
});
