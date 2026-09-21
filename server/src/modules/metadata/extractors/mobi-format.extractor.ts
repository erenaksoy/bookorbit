import { extractMobiCover, parseMobiFile } from '../lib/mobi-parser';
import { splitMetadataIsbn } from '../../../common/text-match/isbn-normalize';
import { parsePublishedDateKey, parsePublishedYear, publishedYearFromDateKey } from '../../../common/utils/published-date.utils';
import type { FormatExtractor, ParsedBookData } from './format-extractor.interface';

// The parser only scans the book text when the header carries no ISBN, so the two never mix.
function contentIsbn(found: { isbn10: string | null; isbn13: string | null } | undefined): { isbn10?: string; isbn13?: string } {
  return {
    ...(found?.isbn10 ? { isbn10: found.isbn10 } : {}),
    ...(found?.isbn13 ? { isbn13: found.isbn13 } : {}),
  };
}

export class MobiFormatExtractor implements FormatExtractor {
  async extract(absolutePath: string): Promise<ParsedBookData | null> {
    const [mobi, cover] = await Promise.all([parseMobiFile(absolutePath), extractMobiCover(absolutePath).catch(() => null)]);
    if (!mobi) return null;

    const publishedDate = parsePublishedDateKey(mobi.publishedDate ?? undefined) ?? null;
    const publishedYear = publishedDate ? publishedYearFromDateKey(publishedDate) : (parsePublishedYear(mobi.publishedDate) ?? null);
    return {
      title: mobi.title,
      description: mobi.description,
      ...(mobi.isbn ? splitMetadataIsbn(mobi.isbn) : contentIsbn(mobi.contentIsbn)),
      publisher: mobi.publisher,
      publishedDate,
      publishedYear,
      language: mobi.language,
      authors: mobi.authors.map((name) => ({ name, sortName: null })),
      genres: mobi.tags,
      cover: cover ?? null,
    };
  }
}
