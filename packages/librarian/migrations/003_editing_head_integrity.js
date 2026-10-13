exports.up = (pgm) => pgm.sql(`
ALTER TABLE post_revisions
    ADD CONSTRAINT post_revisions_locale_number_id_key
        UNIQUE (post_locale_id, revision_number, id);

ALTER TABLE post_locales
    DROP CONSTRAINT post_locales_head_revision_fk,
    ADD CONSTRAINT post_locales_head_revision_exact_fk
        FOREIGN KEY (id, head_revision_number, head_revision_id)
        REFERENCES post_revisions(post_locale_id, revision_number, id)
        DEFERRABLE INITIALLY DEFERRED;
`);

exports.down = (pgm) => pgm.sql(`
ALTER TABLE post_locales
    DROP CONSTRAINT post_locales_head_revision_exact_fk,
    ADD CONSTRAINT post_locales_head_revision_fk
        FOREIGN KEY (id, head_revision_id)
        REFERENCES post_revisions(post_locale_id, id)
        DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE post_revisions
    DROP CONSTRAINT post_revisions_locale_number_id_key;
`);
