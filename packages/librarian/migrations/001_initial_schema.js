const schema = String.raw`
CREATE TABLE posts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE post_locales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id uuid NOT NULL REFERENCES posts(id),
    locale text NOT NULL,
    head_revision_id uuid,
    head_revision_number integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT post_locales_post_locale_key UNIQUE (post_id, locale),
    CONSTRAINT post_locales_supported_locale_check
        CHECK (locale IN ('pt-BR', 'en-US')),
    CONSTRAINT post_locales_head_revision_number_check
        CHECK (head_revision_number >= 0),
    CONSTRAINT post_locales_head_pair_check CHECK (
        (head_revision_id IS NULL AND head_revision_number = 0)
        OR (head_revision_id IS NOT NULL AND head_revision_number > 0)
    )
);

CREATE TABLE post_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    post_locale_id uuid NOT NULL REFERENCES post_locales(id),
    revision_number integer NOT NULL,
    parent_revision_id uuid,
    title text NOT NULL,
    subtitle text,
    slug text NOT NULL,
    markdown text NOT NULL,
    excerpt text,
    seo jsonb NOT NULL DEFAULT '{}'::jsonb,
    presentation jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT post_revisions_locale_number_key
        UNIQUE (post_locale_id, revision_number),
    CONSTRAINT post_revisions_locale_id_key UNIQUE (post_locale_id, id),
    CONSTRAINT post_revisions_positive_number_check CHECK (revision_number > 0),
    CONSTRAINT post_revisions_title_nonempty_check CHECK (length(btrim(title)) > 0),
    CONSTRAINT post_revisions_slug_nonempty_check CHECK (length(btrim(slug)) > 0),
    CONSTRAINT post_revisions_seo_object_check CHECK (jsonb_typeof(seo) = 'object'),
    CONSTRAINT post_revisions_presentation_object_check
        CHECK (jsonb_typeof(presentation) = 'object'),
    CONSTRAINT post_revisions_parent_same_locale_fk
        FOREIGN KEY (post_locale_id, parent_revision_id)
        REFERENCES post_revisions(post_locale_id, id)
        DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE post_locales
    ADD CONSTRAINT post_locales_head_revision_fk
    FOREIGN KEY (id, head_revision_id)
    REFERENCES post_revisions(post_locale_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION enforce_post_revision_parent_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_number integer;
BEGIN
    IF NEW.revision_number = 1 THEN
        IF NEW.parent_revision_id IS NOT NULL THEN
            RAISE EXCEPTION 'revision 1 must not have a parent'
                USING ERRCODE = '23514', CONSTRAINT = 'post_revisions_parent_sequence_check';
        END IF;
        RETURN NULL;
    END IF;

    IF NEW.parent_revision_id IS NULL THEN
        RAISE EXCEPTION 'revision % must reference revision % as its parent',
            NEW.revision_number, NEW.revision_number - 1
            USING ERRCODE = '23514', CONSTRAINT = 'post_revisions_parent_sequence_check';
    END IF;

    SELECT revision_number INTO parent_number
    FROM post_revisions
    WHERE post_locale_id = NEW.post_locale_id
      AND id = NEW.parent_revision_id;

    IF parent_number IS DISTINCT FROM NEW.revision_number - 1 THEN
        RAISE EXCEPTION 'revision % parent must be the immediately preceding revision',
            NEW.revision_number
            USING ERRCODE = '23514', CONSTRAINT = 'post_revisions_parent_sequence_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER post_revisions_parent_sequence_trigger
AFTER INSERT ON post_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_post_revision_parent_sequence();

CREATE TABLE tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tags_slug_canonical_check
        CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE TABLE post_revision_tags (
    post_revision_id uuid NOT NULL REFERENCES post_revisions(id),
    tag_id uuid NOT NULL REFERENCES tags(id),
    PRIMARY KEY (post_revision_id, tag_id)
);

CREATE INDEX post_revision_tags_tag_id_idx ON post_revision_tags(tag_id);

CREATE TABLE "references" (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    citation_key text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reference_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_id uuid NOT NULL REFERENCES "references"(id),
    revision_number integer NOT NULL,
    csl_json jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reference_revisions_reference_number_key
        UNIQUE (reference_id, revision_number),
    CONSTRAINT reference_revisions_reference_id_key UNIQUE (reference_id, id),
    CONSTRAINT reference_revisions_positive_number_check CHECK (revision_number > 0),
    CONSTRAINT reference_revisions_csl_object_check CHECK (jsonb_typeof(csl_json) = 'object')
);

CREATE TABLE article_artifacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    post_locale_id uuid NOT NULL,
    post_revision_id uuid NOT NULL,
    compiler_fingerprint text NOT NULL,
    dependency_fingerprint text NOT NULL,
    html text NOT NULL,
    toc jsonb NOT NULL DEFAULT '[]'::jsonb,
    asset_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT article_artifacts_locale_revision_fk
        FOREIGN KEY (post_locale_id, post_revision_id)
        REFERENCES post_revisions(post_locale_id, id),
    CONSTRAINT article_artifacts_locale_id_key UNIQUE (post_locale_id, id),
    CONSTRAINT article_artifacts_locale_revision_id_key
        UNIQUE (post_locale_id, post_revision_id, id),
    CONSTRAINT article_artifacts_compiler_fingerprint_check
        CHECK (length(btrim(compiler_fingerprint)) > 0),
    CONSTRAINT article_artifacts_dependency_fingerprint_check
        CHECK (length(btrim(dependency_fingerprint)) > 0),
    CONSTRAINT article_artifacts_toc_array_check CHECK (jsonb_typeof(toc) = 'array'),
    CONSTRAINT article_artifacts_manifest_array_check
        CHECK (jsonb_typeof(asset_manifest) = 'array')
);

CREATE INDEX article_artifacts_post_locale_created_at_idx
    ON article_artifacts(post_locale_id, created_at DESC);
CREATE INDEX article_artifacts_post_revision_id_idx
    ON article_artifacts(post_revision_id);

CREATE TABLE artifact_reference_revisions (
    artifact_id uuid NOT NULL REFERENCES article_artifacts(id),
    reference_id uuid NOT NULL,
    reference_revision_id uuid NOT NULL,
    PRIMARY KEY (artifact_id, reference_id),
    CONSTRAINT artifact_reference_revisions_exact_revision_fk
        FOREIGN KEY (reference_id, reference_revision_id)
        REFERENCES reference_revisions(reference_id, id)
);

CREATE INDEX artifact_reference_revisions_reference_revision_idx
    ON artifact_reference_revisions(reference_id, reference_revision_id);

CREATE TABLE post_publications (
    post_locale_id uuid PRIMARY KEY REFERENCES post_locales(id),
    post_revision_id uuid,
    artifact_id uuid,
    version bigint NOT NULL DEFAULT 0,
    published_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT post_publications_nonnegative_version_check CHECK (version >= 0),
    CONSTRAINT post_publications_pointer_pair_check CHECK (
        (post_revision_id IS NULL AND artifact_id IS NULL)
        OR (post_revision_id IS NOT NULL AND artifact_id IS NOT NULL)
    ),
    CONSTRAINT post_publications_revision_locale_fk
        FOREIGN KEY (post_locale_id, post_revision_id)
        REFERENCES post_revisions(post_locale_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT post_publications_artifact_revision_fk
        FOREIGN KEY (post_locale_id, post_revision_id, artifact_id)
        REFERENCES article_artifacts(post_locale_id, post_revision_id, id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE publication_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    post_locale_id uuid NOT NULL REFERENCES post_locales(id),
    event_type text NOT NULL,
    post_revision_id uuid,
    artifact_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT publication_events_type_check
        CHECK (event_type IN ('publish', 'unpublish', 'rollback')),
    CONSTRAINT publication_events_pointer_pair_check CHECK (
        (post_revision_id IS NULL AND artifact_id IS NULL)
        OR (post_revision_id IS NOT NULL AND artifact_id IS NOT NULL)
    ),
    CONSTRAINT publication_events_revision_locale_fk
        FOREIGN KEY (post_locale_id, post_revision_id)
        REFERENCES post_revisions(post_locale_id, id),
    CONSTRAINT publication_events_artifact_revision_fk
        FOREIGN KEY (post_locale_id, post_revision_id, artifact_id)
        REFERENCES article_artifacts(post_locale_id, post_revision_id, id)
);

CREATE INDEX publication_events_post_locale_created_at_idx
    ON publication_events(post_locale_id, created_at DESC);

CREATE FUNCTION reject_immutable_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'table % is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER post_revisions_immutable
BEFORE UPDATE OR DELETE ON post_revisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
CREATE TRIGGER post_revision_tags_immutable
BEFORE UPDATE OR DELETE ON post_revision_tags
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
CREATE TRIGGER reference_revisions_immutable
BEFORE UPDATE OR DELETE ON reference_revisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
CREATE TRIGGER article_artifacts_immutable
BEFORE UPDATE OR DELETE ON article_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
CREATE TRIGGER artifact_reference_revisions_immutable
BEFORE UPDATE OR DELETE ON artifact_reference_revisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
CREATE TRIGGER publication_events_immutable
BEFORE UPDATE OR DELETE ON publication_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
`;

exports.up = (pgm) => pgm.sql(schema);

exports.down = (pgm) => pgm.sql(`
DROP TABLE publication_events;
DROP TABLE post_publications;
DROP TABLE artifact_reference_revisions;
DROP TABLE article_artifacts;
DROP TABLE reference_revisions;
DROP TABLE "references";
DROP TABLE post_revision_tags;
DROP TABLE tags;
ALTER TABLE post_locales DROP CONSTRAINT post_locales_head_revision_fk;
DROP TABLE post_revisions;
DROP TABLE post_locales;
DROP TABLE posts;
DROP FUNCTION reject_immutable_row_mutation();
DROP FUNCTION enforce_post_revision_parent_sequence();
`);
