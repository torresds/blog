exports.up = (pgm) => pgm.sql(`
ALTER TABLE post_revisions
    DROP CONSTRAINT post_revisions_title_nonempty_check,
    ADD CONSTRAINT post_revisions_title_nonempty_check CHECK (title ~ '[^[:space:]]'),
    DROP CONSTRAINT post_revisions_slug_nonempty_check,
    ADD CONSTRAINT post_revisions_slug_nonempty_check CHECK (slug ~ '[^[:space:]]');

ALTER TABLE tags
    DROP CONSTRAINT tags_slug_canonical_check,
    ADD CONSTRAINT tags_slug_canonical_check
        CHECK (slug COLLATE "C" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

CREATE FUNCTION reject_tag_slug_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.slug IS DISTINCT FROM OLD.slug THEN
        RAISE EXCEPTION 'tag slugs are immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tags_slug_immutable
BEFORE UPDATE OF slug ON tags
FOR EACH ROW EXECUTE FUNCTION reject_tag_slug_change();

ALTER TABLE article_artifacts
    DROP CONSTRAINT article_artifacts_compiler_fingerprint_check,
    ADD CONSTRAINT article_artifacts_compiler_fingerprint_check
        CHECK (compiler_fingerprint ~ '[^[:space:]]'),
    DROP CONSTRAINT article_artifacts_dependency_fingerprint_check,
    ADD CONSTRAINT article_artifacts_dependency_fingerprint_check
        CHECK (dependency_fingerprint ~ '[^[:space:]]');
`);

exports.down = (pgm) => pgm.sql(`
ALTER TABLE article_artifacts
    DROP CONSTRAINT article_artifacts_compiler_fingerprint_check,
    ADD CONSTRAINT article_artifacts_compiler_fingerprint_check
        CHECK (length(btrim(compiler_fingerprint)) > 0),
    DROP CONSTRAINT article_artifacts_dependency_fingerprint_check,
    ADD CONSTRAINT article_artifacts_dependency_fingerprint_check
        CHECK (length(btrim(dependency_fingerprint)) > 0);

DROP TRIGGER tags_slug_immutable ON tags;
DROP FUNCTION reject_tag_slug_change();

ALTER TABLE tags
    DROP CONSTRAINT tags_slug_canonical_check,
    ADD CONSTRAINT tags_slug_canonical_check
        CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE post_revisions
    DROP CONSTRAINT post_revisions_title_nonempty_check,
    ADD CONSTRAINT post_revisions_title_nonempty_check CHECK (length(btrim(title)) > 0),
    DROP CONSTRAINT post_revisions_slug_nonempty_check,
    ADD CONSTRAINT post_revisions_slug_nonempty_check CHECK (length(btrim(slug)) > 0);
`);
