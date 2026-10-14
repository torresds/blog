exports.up = (pgm) => pgm.sql(`
CREATE TABLE published_articles (
    post_locale_id uuid PRIMARY KEY REFERENCES post_locales(id),
    locale text NOT NULL CHECK (locale IN ('pt-BR', 'en-US')),
    slug text NOT NULL,
    revision_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    title text NOT NULL,
    excerpt text,
    seo jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(seo) = 'object'),
    tags text[] NOT NULL DEFAULT '{}',
    published_at timestamptz NOT NULL,
    route_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(route_metadata) = 'object'),
    CONSTRAINT published_articles_locale_slug_key UNIQUE (locale, slug),
    CONSTRAINT published_articles_revision_fk FOREIGN KEY (post_locale_id, revision_id)
        REFERENCES post_revisions(post_locale_id, id),
    CONSTRAINT published_articles_artifact_fk FOREIGN KEY (post_locale_id, revision_id, artifact_id)
        REFERENCES article_artifacts(post_locale_id, post_revision_id, id)
);
CREATE INDEX published_articles_locale_published_at_idx ON published_articles(locale, published_at DESC, post_locale_id);
CREATE INDEX published_articles_tags_gin_idx ON published_articles USING gin(tags);

INSERT INTO published_articles (
    post_locale_id, locale, slug, revision_id, artifact_id, title, excerpt, seo, tags, published_at, route_metadata
)
SELECT locale.id, locale.locale, revision.slug, revision.id, artifact.id, revision.title, revision.excerpt,
       revision.seo,
       COALESCE(ARRAY(
           SELECT tag.slug FROM post_revision_tags association
           JOIN tags tag ON tag.id = association.tag_id
           WHERE association.post_revision_id = revision.id ORDER BY tag.slug
       ), '{}'::text[]), publication.published_at,
       jsonb_build_object('postId', locale.post_id)
FROM post_publications publication
JOIN post_locales locale ON locale.id = publication.post_locale_id
JOIN post_revisions revision ON revision.id = publication.post_revision_id
JOIN article_artifacts artifact ON artifact.id = publication.artifact_id
    AND artifact.post_locale_id = publication.post_locale_id
    AND artifact.post_revision_id = publication.post_revision_id
WHERE publication.post_revision_id IS NOT NULL AND publication.artifact_id IS NOT NULL
  AND publication.published_at IS NOT NULL AND artifact.finalized = true AND revision.finalized = true;
`);

exports.down = (pgm) => pgm.sql(`DROP TABLE published_articles;`);
