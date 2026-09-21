import { ZipArchive } from 'archiver';

/** A minimal, valid metadata provider plugin: one module with no imports. */
export function samplePluginSource(overrides: { type?: string; extra?: string } = {}): string {
  const type = overrides.type ?? 'acme-books';
  return `export default {
  apiVersion: 1,
  version: '1.0.0',
  type: '${type}',
  label: 'Acme Books',
  description: 'Books from the Acme catalogue',
  mediaKinds: ['ebook'],
  ${overrides.extra ?? ''}
  async search(query, host) {
    return [{ providerId: '42', title: query.title ?? 'Untitled', authors: ['Ann Author'], publishedDate: '2020-05-04', isbn13: '9780306406157' }];
  },
};
`;
}

/** Builds a zip in memory, stored rather than deflated so entry sizes are predictable. */
export async function buildZip(files: Record<string, string | Buffer>): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  for (const [name, content] of Object.entries(files)) archive.append(content, { name });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

/**
 * Builds a stored zip byte by byte, so an entry can carry any name at all. `archiver` cleans names
 * such as `../x` on the way in, which is exactly what a hostile archive would not do.
 */
export function buildRawZip(entries: Array<{ name: string; data: string | Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + data.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
