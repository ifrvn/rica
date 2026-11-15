BEGIN;

LOCK TABLE public.management_memberships IN ACCESS EXCLUSIVE MODE;

-- Preserve existing administrators without elevating any other member.
DELETE FROM public.management_memberships WHERE role <> 'ADMIN';

ALTER TABLE public.management_memberships
    DROP CONSTRAINT management_memberships_pkey,
    DROP COLUMN role,
    ADD CONSTRAINT management_memberships_pkey PRIMARY KEY (character_id, issuer, subject);

DROP TYPE public."ManagementRole";

COMMIT;
