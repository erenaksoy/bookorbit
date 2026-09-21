import { execFile } from 'child_process';
import { promisify } from 'util';

import { findIsbnInText, pickBestIsbn } from './isbn-detect';

const execFileAsync = promisify(execFile);

const FRONT_PAGES = 10;
const BACK_PAGES = 5;
const PDFTOTEXT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const PDFTOTEXT_TIMEOUT_MS = 15_000;

interface IsbnResult {
  isbn10: string | null;
  isbn13: string | null;
}

const EMPTY: IsbnResult = { isbn10: null, isbn13: null };

async function extractPageText(absolutePath: string, firstPage: number, lastPage: number): Promise<string> {
  const { stdout } = await execFileAsync('pdftotext', ['-q', '-enc', 'UTF-8', '-f', String(firstPage), '-l', String(lastPage), absolutePath, '-'], {
    maxBuffer: PDFTOTEXT_MAX_BUFFER_BYTES,
    timeout: PDFTOTEXT_TIMEOUT_MS,
  });
  return stdout;
}

/**
 * The page ranges worth reading: the whole book when it is short, otherwise the front matter first and
 * the back matter second, since the copyright page and the colophon are where an ISBN is printed. An
 * unknown page count reads the front only, because a range past the end of the file is an error.
 */
export function isbnScanRanges(pageCount: number | null): Array<[number, number]> {
  if (pageCount === null || pageCount < 1) return [[1, FRONT_PAGES]];
  if (pageCount <= FRONT_PAGES + BACK_PAGES) return [[1, pageCount]];
  return [
    [1, FRONT_PAGES],
    [pageCount - BACK_PAGES + 1, pageCount],
  ];
}

/**
 * Fallback ISBN detection for PDFs whose XMP metadata carries no ISBN, which is most PDFs that were
 * scanned or converted rather than exported from a publisher's tool. Reads a bounded window of pages
 * for a labeled, checksum-valid ISBN, the same rules and windows the EPUB fallback uses. Never throws:
 * an encrypted file, a missing `pdftotext`, a timeout or a page range past the end all yield no ISBN,
 * so the metadata path is unaffected.
 *
 * It reads the text layer only. A PDF that is nothing but page images has no text to read.
 */
export async function scanPdfForIsbn(absolutePath: string, pageCount: number | null): Promise<IsbnResult> {
  for (const [first, last] of isbnScanRanges(pageCount)) {
    try {
      const hits = findIsbnInText(await extractPageText(absolutePath, first, last));
      if (hits.some((hit) => hit.labeled)) return pickBestIsbn(hits);
    } catch {
      continue;
    }
  }
  return EMPTY;
}
