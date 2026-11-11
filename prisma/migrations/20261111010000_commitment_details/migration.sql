BEGIN;

ALTER TABLE public.simulation_commitments ADD COLUMN task text CHECK (task IS NULL OR char_length(btrim(task)) BETWEEN 1 AND 300);
GRANT UPDATE (title, task) ON public.simulation_commitments TO rica_admin_api;

CREATE TABLE public.commitment_collaborators (
  commitment_id uuid NOT NULL,
  character_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  account_id uuid NOT NULL,
  PRIMARY KEY (commitment_id, identity_id),
  CONSTRAINT commitment_collaborators_commitment_fkey
    FOREIGN KEY (character_id, commitment_id) REFERENCES public.simulation_commitments(character_id, id) ON DELETE RESTRICT,
  CONSTRAINT commitment_collaborators_account_fkey
    FOREIGN KEY (character_id, identity_id, account_id) REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE RESTRICT
);

GRANT SELECT, INSERT, DELETE ON public.commitment_collaborators TO rica_admin_api;

CREATE FUNCTION public.rica_available_commitment_receipts(target_character uuid, target_run uuid, after_receipt uuid, page_size integer)
RETURNS TABLE (id uuid, "runId" uuid, "identityId" uuid, "accountId" uuid, platform text,
  "contactId" uuid, "contactLabel" text, "receiptAt" timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT receipt.action_id, action.run_id, scope."identityId", scope."accountId", account.platform,
    scope."contactId", contact.display_label, receipt.created_at
  FROM public.simulation_receipts receipt
  JOIN public.action_proposals action ON (action.character_id, action.id) = (receipt.character_id, receipt.action_id)
  CROSS JOIN LATERAL public.rica_confirmed_commitment_scope(receipt.character_id, receipt.action_id) scope
  JOIN public.platform_accounts account ON (account.character_id, account.identity_id, account.id) =
    (receipt.character_id, scope."identityId", scope."accountId")
  LEFT JOIN public.contacts contact ON (contact.character_id, contact.identity_id, contact.account_id, contact.id) =
    (receipt.character_id, scope."identityId", scope."accountId", scope."contactId")
  WHERE receipt.character_id = target_character AND (target_run IS NULL OR action.run_id = target_run)
    AND NOT EXISTS (
      SELECT FROM public.simulation_commitments commitment
      WHERE (commitment.character_id, commitment.action_id) = (receipt.character_id, receipt.action_id)
    )
    AND (after_receipt IS NULL OR (receipt.created_at, receipt.action_id) < (
      SELECT cursor_row.created_at, cursor_row.action_id FROM public.simulation_receipts cursor_row
      WHERE (cursor_row.character_id, cursor_row.action_id) = (target_character, after_receipt)
    ))
  ORDER BY receipt.created_at DESC, receipt.action_id DESC
  LIMIT greatest(1, least(page_size, 101))
$fn$;

REVOKE ALL ON FUNCTION public.rica_available_commitment_receipts(uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_available_commitment_receipts(uuid, uuid, uuid, integer) TO rica_admin_api;

COMMIT;
