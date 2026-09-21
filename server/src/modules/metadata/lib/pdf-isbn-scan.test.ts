import { execFileSync } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock };
});

import { hyphenated, ISBN_10, ISBN_13, withBadChecksum } from '../../../common/test-utils/isbn-fixtures';
import { isbnScanRanges, scanPdfForIsbn } from './pdf-isbn-scan';

const ISBN_13_HUMAN = hyphenated(ISBN_13);

/** promisify(execFile) reads `stdout` off the second callback argument, as the real one does. */
function replyWith(byRange: Record<string, string | Error>) {
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, callback: (error: Error | null, result?: { stdout: string }) => void) => {
      const range = `${args[args.indexOf('-f') + 1]}-${args[args.indexOf('-l') + 1]}`;
      const reply = byRange[range] ?? '';
      if (reply instanceof Error) callback(reply);
      else callback(null, { stdout: reply });
    },
  );
}

describe('isbnScanRanges', () => {
  it('reads the whole of a short book', () => {
    expect(isbnScanRanges(15)).toEqual([[1, 15]]);
    expect(isbnScanRanges(1)).toEqual([[1, 1]]);
  });

  it('reads the front ten pages, then the last five, of a longer one', () => {
    expect(isbnScanRanges(16)).toEqual([
      [1, 10],
      [12, 16],
    ]);
    expect(isbnScanRanges(300)).toEqual([
      [1, 10],
      [296, 300],
    ]);
  });

  it('reads only the front when the page count is unknown, since a range past the end is an error', () => {
    expect(isbnScanRanges(null)).toEqual([[1, 10]]);
    expect(isbnScanRanges(0)).toEqual([[1, 10]]);
  });
});

describe('scanPdfForIsbn', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('asks pdftotext for one range of pages as UTF-8 text on stdout', async () => {
    replyWith({});

    await scanPdfForIsbn('/books/a.pdf', 5);

    expect(execFileMock).toHaveBeenCalledWith(
      'pdftotext',
      ['-q', '-enc', 'UTF-8', '-f', '1', '-l', '5', '/books/a.pdf', '-'],
      expect.objectContaining({ maxBuffer: expect.any(Number), timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('recovers a labeled ISBN from the front matter without reading the back', async () => {
    replyWith({ '1-10': `Copyright page\nISBN: ${ISBN_13_HUMAN}\n`, '296-300': `ISBN ${ISBN_10}` });

    await expect(scanPdfForIsbn('/books/a.pdf', 300)).resolves.toEqual({ isbn10: null, isbn13: ISBN_13 });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the back matter when the front has none', async () => {
    replyWith({ '1-10': 'Title page only', '296-300': `Colophon\nISBN ${ISBN_13_HUMAN}` });

    await expect(scanPdfForIsbn('/books/a.pdf', 300)).resolves.toEqual({ isbn10: null, isbn13: ISBN_13 });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('keeps an ISBN-10 when that is all the page prints', async () => {
    replyWith({ '1-15': `ISBN-10: ${ISBN_10}` });

    await expect(scanPdfForIsbn('/books/a.pdf', 15)).resolves.toEqual({ isbn10: ISBN_10, isbn13: null });
  });

  it('ignores a valid number that nothing labels as an ISBN', async () => {
    replyWith({ '1-15': `Printed 2024\n${ISBN_13_HUMAN}\n` });

    await expect(scanPdfForIsbn('/books/a.pdf', 15)).resolves.toEqual({ isbn10: null, isbn13: null });
  });

  it('ignores a labeled number whose checksum is wrong', async () => {
    replyWith({ '1-15': `ISBN ${hyphenated(withBadChecksum(ISBN_13))}` });

    await expect(scanPdfForIsbn('/books/a.pdf', 15)).resolves.toEqual({ isbn10: null, isbn13: null });
  });

  it('never throws: a failed pdftotext on one range does not stop the next', async () => {
    replyWith({ '1-10': new Error('Command failed: incorrect password'), '296-300': `ISBN ${ISBN_13_HUMAN}` });

    await expect(scanPdfForIsbn('/books/locked.pdf', 300)).resolves.toEqual({ isbn10: null, isbn13: ISBN_13 });
  });

  it('returns nothing when every range fails, for example when pdftotext is not installed', async () => {
    replyWith({ '1-10': new Error('spawn pdftotext ENOENT'), '296-300': new Error('spawn pdftotext ENOENT') });

    await expect(scanPdfForIsbn('/books/a.pdf', 300)).resolves.toEqual({ isbn10: null, isbn13: null });
  });
});

/** The real binary on a real file, where poppler is installed (it always is in the Docker image). */
const hasPdftotext = (() => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPdftotext)('scanPdfForIsbn with the real pdftotext', () => {
  let dir: string;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    execFileMock.mockImplementation(actual.execFile);
    dir = await mkdtemp(join(tmpdir(), 'pdf-isbn-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makePdf(name: string, pages: Record<number, string>, total: number): Promise<string> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= total; n++) {
      const page = doc.addPage([400, 400]);
      page.drawText(pages[n] ?? `Page ${n}`, { x: 20, y: 200, size: 12, font });
    }
    const path = join(dir, name);
    await writeFile(path, await doc.save());
    return path;
  }

  it('finds the ISBN printed on the copyright page', async () => {
    const path = await makePdf('front.pdf', { 3: `Copyright 2021  ISBN ${ISBN_13_HUMAN}` }, 40);

    await expect(scanPdfForIsbn(path, 40)).resolves.toEqual({ isbn10: null, isbn13: ISBN_13 });
  });

  it('finds an ISBN printed only on the last pages', async () => {
    const path = await makePdf('back.pdf', { 39: `Colophon  ISBN ${ISBN_13_HUMAN}` }, 40);

    await expect(scanPdfForIsbn(path, 40)).resolves.toEqual({ isbn10: null, isbn13: ISBN_13 });
  });

  it('does not read the middle of the book', async () => {
    const path = await makePdf('middle.pdf', { 20: `ISBN ${ISBN_13_HUMAN}` }, 40);

    await expect(scanPdfForIsbn(path, 40)).resolves.toEqual({ isbn10: null, isbn13: null });
  });

  it('copes with a page count larger than the file, which pdftotext rejects', async () => {
    const path = await makePdf('short.pdf', { 2: `ISBN ${ISBN_13_HUMAN}` }, 3);

    await expect(scanPdfForIsbn(path, 300)).resolves.toEqual({ isbn10: null, isbn13: ISBN_13 });
  });
});
