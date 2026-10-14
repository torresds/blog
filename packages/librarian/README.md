# Librarian

Librarian is a framework-agnostic TypeScript library for managing localized articles, revision history, bibliography, and publication state. Markdown is the canonical article content.

It provides application services for editing content, importing BibTeX, resolving compilation inputs, recording compiled results, and finding published articles. PostgreSQL persistence is available through the `@torresds/librarian/postgres` entry point.

## Example

Apply the Librarian database migrations, then create a PostgreSQL-backed instance:

```ts
import { createPostgresLibrarian } from '@torresds/librarian/postgres';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const { librarian, close } = createPostgresLibrarian({ connectionString });

try {
  const article = await librarian.discovery.getPublishedArticle({
    locale: 'en-US',
    slug: 'example-article',
  });

  console.log(article.title, article.html);
} finally {
  await close();
}
```

## Limitations

- Requires PostgreSQL for persistence; applications own database configuration and migrations.
- Supports the `pt-BR` and `en-US` locales.
- Does not provide HTTP routes, authentication, or Markdown compilation.
- BibTeX import is offline, and uncommon BibTeX fields may need review.
- Public discovery covers published article lookup, listing, and tag filtering; full-text search is not included.
