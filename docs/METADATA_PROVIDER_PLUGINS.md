# Metadata provider plugins

A metadata provider plugin adds a source to BookOrbit's metadata search, without changing BookOrbit
itself. It exists for sources that do not belong in the main project, such as a regional bookstore or a
catalogue in one language. BookOrbit ships no plugin of its own.

## Trust model

**A plugin runs inside the BookOrbit server process with that process's full reach**, including the
database, the library and the encryption keys. That is the same trade the indexer plugins make, and it is
why:

- Only a **superuser** can install, switch or remove a plugin. This is enforced on the server.
- Installing is a two-step review. The upload is first read in a separate child process with none of the
  server's environment, and the settings page shows what the plugin declares and its full source. The same
  file is then sent again to install, so the bytes that were reviewed are the bytes that land.
- Every install, switch and removal is written to the audit log.
- A new plugin starts **switched off**, like a built-in scraper.

Reading the plugin in a child process is not a sandbox: evaluating a module runs its top-level code. Only
install a plugin from an author you trust, and read its source first.

## Installing

**Settings > Metadata > Providers > Provider plugins > Install plugin.** Choose a `.zip` archive with
`index.mjs` at its root (one wrapping folder is fine), or a bare `.mjs` file.

The plugin loads at once, without a restart, and again at every boot from
`<APP_DATA_PATH>/plugins/metadata-providers/<type>/`. Then switch it on and add it to a field rule under
**Settings > Metadata > Field Rules**: a provider that no rule mentions contributes nothing, like a
built-in one.

Limits: 1 MiB upload, 512 KiB per file, 2 MiB unzipped, 64 files. Sizes are counted as bytes are inflated,
not read from the archive header, and any path that would leave the plugin's folder is rejected.

## Writing a plugin

A plugin is an ES module whose default export follows the `MetadataProviderPlugin` contract in
`@bookorbit/plugin-api`. That package has no runtime code, so a plugin gets types without depending on
BookOrbit's internals.

```js
// index.mjs
export default {
  apiVersion: 1,
  type: "acme-books", // becomes the provider key "plugin:acme-books"
  label: "Acme Books",
  mediaKinds: ["ebook"], // optional: omit to be asked about every kind

  async search(query, host, signal) {
    const response = await host.fetch(
      `https://books.acme.test/search?q=${encodeURIComponent(query.title ?? "")}`,
    );
    if (response.status === 429)
      throw host.fail("throttled", "rate limited", 60);
    if (!response.ok) throw host.fail("error", `HTTP ${response.status}`);

    const { items } = await response.json();
    return items.slice(0, query.limit).map((item) => ({
      providerId: String(item.id),
      title: item.title,
      authors: item.authors,
      isbn13: item.isbn,
      publishedDate: item.published, // "YYYY-MM-DD", or just a year
      coverUrl: item.cover,
    }));
  },
};
```

Required: `apiVersion` (must be `1`), `type` (a slug, `^[a-z0-9][a-z0-9-]{0,29}$`, equal to the folder name),
`label` (1 to 60 characters) and `search`. Optional: `version` (semantic version), `description`,
`mediaKinds` (`ebook`, `audiobook`, `comic`) and `timeoutMs` (1000 to 60000, default 15000). A plugin that
breaks these rules is listed on the settings page with the reason instead of silently missing.

`search` receives:

- **`query`**: `{ title?, author?, isbn?, seriesName?, mediaKind, limit }`, already normalised. `isbn` is
  digits only.
- **`host.fetch(url, init?)`**: the only supported way to reach the network. It refuses private addresses,
  checks every redirect hop, drops credentials when a redirect changes origin, and bounds response size and
  time. Pass `redirect: 'manual'` to receive a 3xx yourself.
- **`host.fail(kind, message, retryAfterSeconds?)`**: builds the error to throw. `throttled` puts the
  provider in a cooldown; the other kinds are `timeout`, `unreachable` and `error`. It is a function, not an
  exported class, because a plugin holds its own copy of any class and `instanceof` would not survive.
- **`host.sleep(ms)`** to pace requests, and **`host.logger`**.
- **`signal`**, aborted on timeout or cancellation. Check it between requests.

It returns an array of candidates. `providerId` and `title` are required, everything else is optional. A
candidate without a usable id or title is dropped and the rest are kept, and individual fields BookOrbit
does not believe (an invalid ISBN, a `javascript:` URL) are discarded rather than failing the row. A
`providerId` over 255 characters is rejected, never truncated.

Ship the plugin as **one bundled file**. Node caches modules by URL, and BookOrbit can only bust that cache
for `index.mjs`, so a module it imports keeps serving old code after a replace, until a restart.

## Not supported yet

- **Stored ids and refresh by id.** A candidate's `providerId` is not saved on the book, so a later refresh
  searches again. Community ratings from a plugin are not accepted.
- **Per-plugin settings**, such as an API key. A plugin must work without configuration.
- **Signed updates.** Replace a plugin by installing the new archive over it.
- **A sandbox.**
