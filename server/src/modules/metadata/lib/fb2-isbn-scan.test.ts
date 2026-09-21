import { hyphenated, ISBN_10, ISBN_13, withBadChecksum } from '../../../common/test-utils/isbn-fixtures';
import { scanFb2TextForIsbn } from './fb2-isbn-scan';

const ISBN_13_HUMAN = hyphenated(ISBN_13);

const fb2 = (body: string, tail = '') => `<?xml version="1.0"?><FictionBook><description/><body>${body}</body>${tail}</FictionBook>`;

describe('scanFb2TextForIsbn', () => {
  it('recovers a labeled ISBN from the copyright section', () => {
    expect(scanFb2TextForIsbn(fb2(`<section><p>Copyright 2021</p><p>ISBN ${ISBN_13_HUMAN}</p></section>`))).toEqual({
      isbn10: null,
      isbn13: ISBN_13,
    });
  });

  it('keeps an ISBN-10', () => {
    expect(scanFb2TextForIsbn(fb2(`<p>ISBN ${hyphenated(ISBN_10)}</p>`))).toEqual({ isbn10: ISBN_10, isbn13: null });
  });

  it('ignores a number nothing labels as an ISBN, and one with a wrong checksum', () => {
    expect(scanFb2TextForIsbn(fb2(`<p>${ISBN_13_HUMAN}</p><p>ISBN ${hyphenated(withBadChecksum(ISBN_13))}</p>`))).toEqual({
      isbn10: null,
      isbn13: null,
    });
  });

  it('finds an ISBN printed at the very end of a long book', () => {
    const filler = '<p>' + 'word '.repeat(300_000) + '</p>';

    expect(scanFb2TextForIsbn(fb2(filler + `<p>ISBN ${ISBN_13_HUMAN}</p>`))).toEqual({ isbn10: null, isbn13: ISBN_13 });
  });

  it('does not let base64 image data crowd out the back of the book', () => {
    const image = `<binary id="cover.jpg" content-type="image/jpeg">${'QUJD'.repeat(200_000)}</binary>`;

    expect(scanFb2TextForIsbn(fb2(`<p>ISBN ${ISBN_13_HUMAN}</p>`, image))).toEqual({ isbn10: null, isbn13: ISBN_13 });
  });

  it('returns nothing for text without an ISBN', () => {
    expect(scanFb2TextForIsbn(fb2('<p>Just a story.</p>'))).toEqual({ isbn10: null, isbn13: null });
  });
});
