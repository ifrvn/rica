BEGIN;

CREATE INDEX newbi_replies_character_created_idx ON public.newbi_replies(character_id, created_at, id);
CREATE INDEX newbi_replies_character_status_created_idx ON public.newbi_replies(character_id, status, created_at, id);

COMMIT;
