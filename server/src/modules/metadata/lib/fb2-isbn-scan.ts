import { findLabeledIsbn } from './isbn-detect';

const FRONT_CHARS = 1024 * 1024;
const BACK_CHARS = 256 * 1024;

const EMPTY = { isbn10: null, isbn13: null };

/**
 * Fallback ISBN detection for FB2 files whose `publish-info` carries none. Reads the front of the book
 * text first and then the back, where a copyright page or a colophon prints it, taking an ISBN that is
 * labeled as one. The base64 `<binary>` images sit at the end of the file and would fill the back
 * window with noise, so they are dropped first. Never throws.
 */
export function scanFb2TextForIsbn(xml: string): { isbn10: string | null; isbn13: string | null } {
  try {
    const text = xml
      .replace(/<binary\b[^>]*>[\s\S]*?<\/binary>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ');

    const front = findLabeledIsbn(text.slice(0, FRONT_CHARS));
    if (front.isbn10 || front.isbn13) return front;
    return text.length > FRONT_CHARS ? findLabeledIsbn(text.slice(-BACK_CHARS)) : EMPTY;
  } catch {
    return EMPTY;
  }
}
