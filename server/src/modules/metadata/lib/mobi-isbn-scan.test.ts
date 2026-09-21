import { hyphenated, ISBN_13 } from '../../../common/test-utils/isbn-fixtures';
import { palmDocDecompress, scanMobiTextForIsbn } from './mobi-isbn-scan';

const ISBN_13_HUMAN = hyphenated(ISBN_13);

/** Literals only, which is a valid PalmDOC stream: 0x09-0x7F stand for themselves, anything else is a one byte run. */
function palmDocLiterals(text: string): Buffer {
  const out: number[] = [];
  for (const byte of Buffer.from(text, 'latin1')) {
    if (byte === 0 || (byte >= 0x09 && byte <= 0x7f)) out.push(byte);
    else out.push(0x01, byte);
  }
  return Buffer.from(out);
}

interface BookOptions {
  records: string[];
  compression?: number;
  encryption?: number;
  encoding?: number;
  extraFlags?: number;
  trailing?: (index: number) => Buffer;
}

/** A minimal PalmDB with a MOBI record 0 and the given text records. */
function buildBook(options: BookOptions): { file: Buffer; offsets: number[] } {
  const compression = options.compression ?? 2;
  const rec0 = Buffer.alloc(248, 0);
  rec0.writeUInt16BE(compression, 0);
  rec0.writeUInt16BE(options.records.length, 8);
  rec0.writeUInt16BE(options.encryption ?? 0, 12);
  rec0.write('MOBI', 16, 'ascii');
  rec0.writeUInt32BE(232, 20);
  rec0.writeUInt32BE(options.encoding ?? 1252, 28);
  rec0.writeUInt16BE(options.extraFlags ?? 0, 242);

  const bodies = options.records.map((text, i) => {
    const body = compression === 2 ? palmDocLiterals(text) : Buffer.from(text, 'latin1');
    return Buffer.concat([body, options.trailing?.(i) ?? Buffer.alloc(0)]);
  });
  const all = [rec0, ...bodies];
  const headerSize = 78 + all.length * 8 + 2;
  const offsets: number[] = [];
  let cursor = headerSize;
  for (const record of all) {
    offsets.push(cursor);
    cursor += record.length;
  }
  const header = Buffer.alloc(headerSize, 0);
  header.writeUInt16BE(all.length, 76);
  offsets.forEach((offset, i) => header.writeUInt32BE(offset, 78 + i * 8));
  return { file: Buffer.concat([header, ...all]), offsets };
}

const page = (n: number) => `<p>Chapter text number ${n}</p>`;

describe('palmDocDecompress', () => {
  it('passes literals and literal runs through', () => {
    expect(palmDocDecompress(Buffer.from([0x41, 0x42, 0x03, 0x80, 0x81, 0x82, 0x43])).toString('latin1')).toBe('AB\x80\x81\x82C');
  });

  it('expands a space plus character', () => {
    expect(palmDocDecompress(Buffer.from([0x41, 0xc2])).toString('latin1')).toBe('A B');
  });

  it('follows a back-reference into the output so far', () => {
    // "abc" then distance 3, length 3 (pair = distance << 3 | (length - 3)) copies "abc" again.
    const pair = 0x8000 | (3 << 3) | 0;
    expect(palmDocDecompress(Buffer.from([0x61, 0x62, 0x63, pair >> 8, pair & 0xff])).toString()).toBe('abcabc');
  });

  it('stops at a back-reference that points before the start instead of looping or throwing', () => {
    const pair = 0x8000 | (9 << 3);
    expect(palmDocDecompress(Buffer.from([0x61, pair >> 8, pair & 0xff, 0x62])).toString()).toBe('a');
  });

  it('never produces more than the cap', () => {
    const pair = 0x8000 | (1 << 3) | 7;
    expect(
      palmDocDecompress(
        Buffer.from([
          0x61,
          ...Array(200)
            .fill([pair >> 8, pair & 0xff])
            .flat(),
        ]),
        50,
      ).length,
    ).toBeLessThanOrEqual(60);
  });
});

describe('scanMobiTextForIsbn', () => {
  it('recovers a labeled ISBN from the front matter of a PalmDOC book', () => {
    const { file, offsets } = buildBook({ records: [page(1), `<p>Copyright 2021</p><p>ISBN ${ISBN_13_HUMAN}</p>`, page(3)] });

    expect(scanMobiTextForIsbn(file, offsets)).toEqual({ isbn10: null, isbn13: ISBN_13 });
  });

  it('reads an uncompressed book too', () => {
    const { file, offsets } = buildBook({ compression: 1, records: [`<p>ISBN: ${ISBN_13_HUMAN}</p>`] });

    expect(scanMobiTextForIsbn(file, offsets)).toEqual({ isbn10: null, isbn13: ISBN_13 });
  });

  it('falls back to the last records when the front has none', () => {
    const records = Array.from({ length: 40 }, (_, i) => page(i));
    records[38] = `<p>Colophon ISBN ${ISBN_13_HUMAN}</p>`;
    const { file, offsets } = buildBook({ records });

    expect(scanMobiTextForIsbn(file, offsets)).toEqual({ isbn10: null, isbn13: ISBN_13 });
  });

  it('does not read the middle of a long book', () => {
    const records = Array.from({ length: 40 }, (_, i) => page(i));
    records[20] = `<p>ISBN ${ISBN_13_HUMAN}</p>`;
    const { file, offsets } = buildBook({ records });

    expect(scanMobiTextForIsbn(file, offsets)).toEqual({ isbn10: null, isbn13: null });
  });

  it('ignores a number nothing labels as an ISBN', () => {
    const { file, offsets } = buildBook({ records: [`<p>Barcode ${ISBN_13_HUMAN}</p>`] });

    expect(scanMobiTextForIsbn(file, offsets)).toEqual({ isbn10: null, isbn13: null });
  });

  it('strips the trailing entries a writer appends to each record', () => {
    // Flag bit 1 = one trailing entry, encoded as a size byte counting itself: 3 bytes in all.
    const { file, offsets } = buildBook({
      extraFlags: 0b10,
      records: [`<p>ISBN ${ISBN_13_HUMAN}</p>`],
      trailing: () => Buffer.from([0x7a, 0x7b, 0x83]),
    });

    expect(scanMobiTextForIsbn(file, offsets)).toEqual({ isbn10: null, isbn13: ISBN_13 });
  });

  it('reads UTF-8 text when the header says so', () => {
    const { file, offsets } = buildBook({ compression: 1, encoding: 65001, records: [`<p>İ ISBN ${ISBN_13_HUMAN}</p>`] });

    expect(scanMobiTextForIsbn(file, offsets)).toEqual({ isbn10: null, isbn13: ISBN_13 });
  });

  it.each([
    ['HUFF/CDIC compression', { compression: 17480 }],
    ['encryption', { encryption: 2 }],
  ])('reads nothing for a book with %s', (_name, extra) => {
    const { file, offsets } = buildBook({ records: [`<p>ISBN ${ISBN_13_HUMAN}</p>`], ...extra });

    expect(scanMobiTextForIsbn(file, offsets)).toEqual({ isbn10: null, isbn13: null });
  });

  it('never throws on a truncated file', () => {
    const { file, offsets } = buildBook({ records: [page(1), page(2)] });

    expect(scanMobiTextForIsbn(file.subarray(0, 100), offsets)).toEqual({ isbn10: null, isbn13: null });
    expect(scanMobiTextForIsbn(Buffer.alloc(0), [])).toEqual({ isbn10: null, isbn13: null });
  });
});
