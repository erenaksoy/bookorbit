/**
 * ISBNs for tests, with the check digit computed rather than typed. A test that reads an ISBN out of
 * text is only meaningful when the number passes the checksum, and a hand-written number that is off by
 * one digit would fail the same way a wrong-checksum case is meant to, so these are built from a body.
 */

/** The ISBN-13 check digit for the first twelve digits. */
export function isbn13From(body: string): string {
  const sum = [...body].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return body + String((10 - (sum % 10)) % 10);
}

/** The ISBN-10 check digit for the first nine digits. */
export function isbn10From(body: string): string {
  const sum = [...body].reduce((total, digit, index) => total + Number(digit) * (index + 1), 0);
  const check = sum % 11;
  return body + (check === 10 ? 'X' : String(check));
}

/** The printed form, `978-0-306-40615-7`, which is how a copyright page usually shows it. */
export function hyphenated(isbn: string): string {
  return isbn.length === 13
    ? `${isbn.slice(0, 3)}-${isbn.slice(3, 4)}-${isbn.slice(4, 7)}-${isbn.slice(7, 12)}-${isbn.slice(12)}`
    : `${isbn.slice(0, 1)}-${isbn.slice(1, 4)}-${isbn.slice(4, 9)}-${isbn.slice(9)}`;
}

/** The same number with its last digit changed, so it no longer passes the checksum. */
export function withBadChecksum(isbn: string): string {
  const last = isbn.at(-1) === '0' ? '1' : '0';
  return isbn.slice(0, -1) + last;
}

export const ISBN_13 = isbn13From('978030640615');
export const ISBN_13_OTHER = isbn13From('978163576626');
export const ISBN_10 = isbn10From('030640615');
