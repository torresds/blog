exports.up = (pgm) => pgm.sql(`
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "references" r
        LEFT JOIN reference_revisions rr ON rr.reference_id = r.id
        WHERE rr.id IS NULL
    ) THEN
        RAISE EXCEPTION 'cannot backfill reference heads: a reference has no immutable revision';
    END IF;
END;
$$;

ALTER TABLE reference_revisions
    ADD CONSTRAINT reference_revisions_reference_number_id_key
    UNIQUE (reference_id, revision_number, id);
ALTER TABLE "references"
    ADD COLUMN head_revision_id uuid,
    ADD COLUMN head_revision_number integer NOT NULL DEFAULT 0;

WITH latest AS (
    SELECT DISTINCT ON (reference_id) reference_id, id, revision_number
    FROM reference_revisions
    ORDER BY reference_id, revision_number DESC, id
)
UPDATE "references" r
SET head_revision_id = latest.id, head_revision_number = latest.revision_number
FROM latest WHERE latest.reference_id = r.id;

ALTER TABLE "references"
    ADD CONSTRAINT references_head_pair_check CHECK (
        (head_revision_id IS NULL AND head_revision_number = 0)
        OR (head_revision_id IS NOT NULL AND head_revision_number > 0)
    ),
    ADD CONSTRAINT references_head_revision_exact_fk
        FOREIGN KEY (id, head_revision_number, head_revision_id)
        REFERENCES reference_revisions(reference_id, revision_number, id)
        DEFERRABLE INITIALLY DEFERRED;
`);

exports.down = (pgm) => pgm.sql(`
ALTER TABLE "references" DROP CONSTRAINT references_head_revision_exact_fk,
    DROP CONSTRAINT references_head_pair_check,
    DROP COLUMN head_revision_number,
    DROP COLUMN head_revision_id;
ALTER TABLE reference_revisions DROP CONSTRAINT reference_revisions_reference_number_id_key;
`);
