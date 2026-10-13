exports.up = (pgm) => pgm.sql(`
ALTER TABLE post_revisions
    ADD COLUMN finalized boolean NOT NULL DEFAULT false;
ALTER TABLE article_artifacts
    ADD COLUMN finalized boolean NOT NULL DEFAULT false;

UPDATE post_revisions SET finalized = true;
UPDATE article_artifacts SET finalized = true;

CREATE FUNCTION protect_snapshot_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'table % is append-only; DELETE is not allowed', TG_TABLE_NAME
            USING ERRCODE = '55000';
    END IF;

    IF OLD.finalized
       OR NOT NEW.finalized
       OR (to_jsonb(NEW) - 'finalized') IS DISTINCT FROM (to_jsonb(OLD) - 'finalized') THEN
        RAISE EXCEPTION 'snapshot rows are immutable except for one-time finalization'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER post_revisions_immutable ON post_revisions;
CREATE TRIGGER post_revisions_snapshot_guard
BEFORE UPDATE OR DELETE ON post_revisions
FOR EACH ROW EXECUTE FUNCTION protect_snapshot_parent();

DROP TRIGGER article_artifacts_immutable ON article_artifacts;
CREATE TRIGGER article_artifacts_snapshot_guard
BEFORE UPDATE OR DELETE ON article_artifacts
FOR EACH ROW EXECUTE FUNCTION protect_snapshot_parent();

CREATE FUNCTION guard_snapshot_association_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_finalized boolean;
BEGIN
    IF TG_TABLE_NAME = 'post_revision_tags' THEN
        SELECT finalized INTO parent_finalized
        FROM post_revisions WHERE id = NEW.post_revision_id FOR UPDATE;
    ELSE
        SELECT finalized INTO parent_finalized
        FROM article_artifacts WHERE id = NEW.artifact_id FOR UPDATE;
    END IF;

    IF FOUND AND parent_finalized THEN
        RAISE EXCEPTION 'snapshot associations are finalized'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER post_revision_tags_insert_guard
BEFORE INSERT ON post_revision_tags
FOR EACH ROW EXECUTE FUNCTION guard_snapshot_association_insert();
CREATE TRIGGER artifact_reference_revisions_insert_guard
BEFORE INSERT ON artifact_reference_revisions
FOR EACH ROW EXECUTE FUNCTION guard_snapshot_association_insert();

CREATE FUNCTION require_snapshot_finalized_at_commit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    is_finalized boolean;
BEGIN
    IF TG_TABLE_NAME = 'post_revisions' THEN
        SELECT finalized INTO is_finalized FROM post_revisions WHERE id = NEW.id;
    ELSE
        SELECT finalized INTO is_finalized FROM article_artifacts WHERE id = NEW.id;
    END IF;

    IF is_finalized IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'snapshot must be finalized before transaction commit'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER post_revisions_must_finalize
AFTER INSERT OR UPDATE ON post_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_snapshot_finalized_at_commit();
CREATE CONSTRAINT TRIGGER article_artifacts_must_finalize
AFTER INSERT OR UPDATE ON article_artifacts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_snapshot_finalized_at_commit();
`);

exports.down = (pgm) => pgm.sql(`
DROP TRIGGER article_artifacts_must_finalize ON article_artifacts;
DROP TRIGGER post_revisions_must_finalize ON post_revisions;
DROP FUNCTION require_snapshot_finalized_at_commit();
DROP TRIGGER artifact_reference_revisions_insert_guard ON artifact_reference_revisions;
DROP TRIGGER post_revision_tags_insert_guard ON post_revision_tags;
DROP FUNCTION guard_snapshot_association_insert();
DROP TRIGGER article_artifacts_snapshot_guard ON article_artifacts;
CREATE TRIGGER article_artifacts_immutable
BEFORE UPDATE OR DELETE ON article_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
DROP TRIGGER post_revisions_snapshot_guard ON post_revisions;
CREATE TRIGGER post_revisions_immutable
BEFORE UPDATE OR DELETE ON post_revisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
DROP FUNCTION protect_snapshot_parent();
ALTER TABLE article_artifacts DROP COLUMN finalized;
ALTER TABLE post_revisions DROP COLUMN finalized;
`);
