exports.up = (pgm) => pgm.sql(`
ALTER TABLE publication_events
    ADD COLUMN previous_version bigint,
    ADD COLUMN new_version bigint,
    ADD COLUMN previous_revision_id uuid,
    ADD COLUMN previous_artifact_id uuid,
    ADD CONSTRAINT publication_events_versions_nonnegative_check CHECK (
        (previous_version IS NULL OR previous_version >= 0)
        AND (new_version IS NULL OR new_version > 0)
    ),
    ADD CONSTRAINT publication_events_previous_pair_check CHECK (
        (previous_revision_id IS NULL AND previous_artifact_id IS NULL)
        OR (previous_revision_id IS NOT NULL AND previous_artifact_id IS NOT NULL)
    ),
    ADD CONSTRAINT publication_events_new_pair_fk FOREIGN KEY (post_locale_id, post_revision_id, artifact_id)
        REFERENCES article_artifacts(post_locale_id, post_revision_id, id),
    ADD CONSTRAINT publication_events_previous_pair_fk FOREIGN KEY (post_locale_id, previous_revision_id, previous_artifact_id)
        REFERENCES article_artifacts(post_locale_id, post_revision_id, id),
    ADD CONSTRAINT publication_events_complete_transition_check CHECK (
        new_version IS NULL OR (
            (event_type = 'publish' AND post_revision_id IS NOT NULL AND artifact_id IS NOT NULL)
            OR (event_type = 'unpublish' AND post_revision_id IS NULL AND artifact_id IS NULL
                AND previous_revision_id IS NOT NULL AND previous_artifact_id IS NOT NULL)
            OR (event_type = 'rollback' AND post_revision_id IS NOT NULL AND artifact_id IS NOT NULL
                AND previous_revision_id IS NOT NULL AND previous_artifact_id IS NOT NULL)
        )
    );
`);

exports.down = (pgm) => pgm.sql(`
ALTER TABLE publication_events
    DROP CONSTRAINT publication_events_complete_transition_check,
    DROP CONSTRAINT publication_events_previous_pair_fk,
    DROP CONSTRAINT publication_events_new_pair_fk,
    DROP CONSTRAINT publication_events_previous_pair_check,
    DROP CONSTRAINT publication_events_versions_nonnegative_check,
    DROP COLUMN previous_artifact_id,
    DROP COLUMN previous_revision_id,
    DROP COLUMN new_version,
    DROP COLUMN previous_version;
`);
