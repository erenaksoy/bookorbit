import { htmlToPlainText } from '../../../common/utils/html-to-text.utils';
import { findLabeledIsbn } from './isbn-detect';

const FRONT_RECORDS = 12;
const BACK_RECORDS = 6;
const MAX_RECORD_BYTES = 64 * 1024;

const COMPRESSION_NONE = 1;
const COMPRESSION_PALMDOC = 2;
const ENCODING_UTF8 = 65001;

/** The offset of the "extra data flags" field within record 0, present from a 228 byte MOBI header. */
const EXTRA_FLAGS_OFFSET = 242;
const MIN_HEADER_LENGTH_FOR_EXTRA_FLAGS = 228;

interface IsbnResult {
  isbn10: string | null;
  isbn13: string | null;
}

const EMPTY: IsbnResult = { isbn10: null, isbn13: null };

/**
 * PalmDOC's LZ77 variant, which MOBI, AZW and most AZW3 files use for their text records.
 *
 * A byte is a literal (0x09-0x7F, or 0x00), a run of 1-8 literal bytes (0x01-0x08), a space plus a
 * character (0xC0-0xFF), or a two byte back-reference (0x80-0xBF) into the output so far.
 */
export function palmDocDecompress(input: Buffer, maxBytes = MAX_RECORD_BYTES): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < input.length && out.length < maxBytes) {
    const byte = input[i++];
    if (byte === 0 || (byte >= 0x09 && byte <= 0x7f)) {
      out.push(byte);
    } else if (byte >= 0x01 && byte <= 0x08) {
      for (let n = 0; n < byte && i < input.length; n++) out.push(input[i++]);
    } else if (byte >= 0xc0) {
      out.push(0x20, byte ^ 0x80);
    } else {
      if (i >= input.length) break;
      const pair = (byte << 8) | input[i++];
      const distance = (pair >> 3) & 0x7ff;
      const length = (pair & 7) + 3;
      if (distance === 0 || distance > out.length) break;
      for (let n = 0; n < length; n++) out.push(out[out.length - distance]);
    }
  }
  return Buffer.from(out);
}

/** Bytes a record carries after its text: extra entries the writer appended, which are not markup. */
function trailingBytes(record: Buffer, flags: number): number {
  let size = 0;
  let remaining = flags >> 1;
  while (remaining) {
    if (remaining & 1) {
      let position = record.length - size;
      let value = 0;
      let shift = 0;
      while (position > 0) {
        const byte = record[position - 1];
        value |= (byte & 0x7f) << shift;
        shift += 7;
        position -= 1;
        if (byte & 0x80 || shift >= 28) break;
      }
      size += value;
    }
    remaining >>= 1;
  }
  if (flags & 1 && record.length - size - 1 >= 0) size += (record[record.length - size - 1] & 0x03) + 1;
  return size;
}

function recordBounds(file: Buffer, offsets: number[], index: number): Buffer | null {
  const start = offsets[index];
  const end = offsets[index + 1] ?? file.length;
  return start === undefined || start > end || end > file.length ? null : file.subarray(start, end);
}

function decodeTextRecord(file: Buffer, offsets: number[], index: number, compression: number, extraFlags: number): Buffer | null {
  const record = recordBounds(file, offsets, index);
  if (!record) return null;
  const body = record.subarray(0, record.length - trailingBytes(record, extraFlags));
  return compression === COMPRESSION_PALMDOC ? palmDocDecompress(body) : body.subarray(0, MAX_RECORD_BYTES);
}

/**
 * Fallback ISBN detection for MOBI, AZW and AZW3 files whose EXTH header carries no ISBN. Decodes a
 * bounded window of text records, the front matter first and then the back, and takes an ISBN that is
 * labeled as one, with the same rules the EPUB and PDF fallbacks use. Never throws.
 *
 * Only PalmDOC or uncompressed text is read. A book compressed with HUFF/CDIC, or one that is
 * encrypted, yields nothing.
 */
export function scanMobiTextForIsbn(file: Buffer, recordOffsets: number[]): IsbnResult {
  try {
    const rec0 = recordBounds(file, recordOffsets, 0);
    if (!rec0 || rec0.length < 16) return EMPTY;

    const compression = rec0.readUInt16BE(0);
    const textRecordCount = rec0.readUInt16BE(8);
    const encryption = rec0.readUInt16BE(12);
    if (encryption !== 0 || (compression !== COMPRESSION_NONE && compression !== COMPRESSION_PALMDOC) || textRecordCount === 0) return EMPTY;

    const headerLength = rec0.length >= 24 ? rec0.readUInt32BE(20) : 0;
    const extraFlags =
      headerLength >= MIN_HEADER_LENGTH_FOR_EXTRA_FLAGS && rec0.length >= EXTRA_FLAGS_OFFSET + 2 ? rec0.readUInt16BE(EXTRA_FLAGS_OFFSET) : 0;
    const encoding = rec0.length >= 32 ? rec0.readUInt32BE(28) : 0;

    const lastText = Math.min(textRecordCount, recordOffsets.length - 1);
    const front = range(1, Math.min(FRONT_RECORDS, lastText));
    const back = lastText > FRONT_RECORDS ? range(Math.max(FRONT_RECORDS + 1, lastText - BACK_RECORDS + 1), lastText) : [];

    for (const window of [front, back]) {
      const chunks = window
        .map((index) => decodeTextRecord(file, recordOffsets, index, compression, extraFlags))
        .filter((c): c is Buffer => c !== null);
      if (chunks.length === 0) continue;
      const markup = Buffer.concat(chunks).toString(encoding === ENCODING_UTF8 ? 'utf8' : 'latin1');
      const found = findLabeledIsbn(htmlToPlainText(markup));
      if (found.isbn10 || found.isbn13) return found;
    }
    return EMPTY;
  } catch {
    return EMPTY;
  }
}

function range(first: number, last: number): number[] {
  const indexes: number[] = [];
  for (let index = first; index <= last; index++) indexes.push(index);
  return indexes;
}
