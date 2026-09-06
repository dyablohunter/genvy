import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { createZip, crc32 } from '../src/services/zip.js';

/** Read the archive back the way an extractor does: central directory first. */
function readZip(zip: Buffer) {
  // End of central directory: fixed 22 bytes at the tail (no comment).
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  expect(cdOffset + cdSize).toBe(eocd);

  const entries: { name: string; data: Buffer; method: number; stored: number }[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const rawSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    // Follow the pointer into the local header and pull the payload out.
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const lNameLen = zip.readUInt16LE(localOffset + 26);
    const lExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const body = zip.subarray(start, start + compSize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);

    expect(data.length).toBe(rawSize);
    expect(crc32(data)).toBe(crc); // integrity, exactly as an extractor checks
    entries.push({ name, data, method, stored: compSize });
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return entries;
}

describe('zip bundle', () => {
  it('round-trips every entry with a valid CRC', async () => {
    const json = Buffer.from(JSON.stringify({ frames: Array.from({ length: 200 }, (_, i) => i) }));
    const bin = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    const zip = await createZip([
      { name: 'sprite.json', data: json },
      { name: 'sprite.png', data: bin },
      { name: 'anchor-south.png', data: Buffer.alloc(0) }, // empty file is legal
    ]);

    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['sprite.json', 'sprite.png', 'anchor-south.png']);
    expect(entries[0]!.data.equals(json)).toBe(true);
    expect(entries[1]!.data.equals(bin)).toBe(true);
    expect(entries[2]!.data.length).toBe(0);
  });

  it('deflates text but stores already-compressed images', async () => {
    // Highly repetitive JSON: deflate must shrink it a lot.
    const json = Buffer.from('{"a":1}'.repeat(500));
    const png = Buffer.from(Array.from({ length: 4000 }, () => Math.floor(Math.random() * 256)));
    const zip = await createZip([
      { name: 'x.json', data: json },
      { name: 'x.png', data: png },
    ]);
    const [text, image] = readZip(zip);
    expect(text!.method).toBe(8); // deflated
    expect(text!.stored).toBeLessThan(json.length / 4);
    expect(image!.method).toBe(0); // stored — deflate gains nothing on a PNG
    expect(image!.stored).toBe(png.length);
  });

  it('writes unicode names and keeps offsets consistent', async () => {
    const zip = await createZip([
      { name: 'phénix-v1.json', data: Buffer.from('{}') },
      { name: 'sprite.png', data: Buffer.from([1, 2, 3]) },
    ]);
    const entries = readZip(zip);
    expect(entries[0]!.name).toBe('phénix-v1.json');
    expect(entries[1]!.data.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });
});
