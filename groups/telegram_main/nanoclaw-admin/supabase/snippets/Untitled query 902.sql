CREATE SUBSCRIPTION realtime_sync_sub
CONNECTION 'host=db.rxmfasiudxmrqaxavvwn.supabase.co port=5432 dbname=postgres user=postgres password=NlqR1rEUeGQWHHxx sslmode=require'
PUBLICATION realtime_sync_pub
WITH (
  copy_data = false,
  create_slot = true,
  enabled = true
);

CREATE SUBSCRIPTION realtime_sync_sub
CONNECTION 'host=db.rxmfasiudxmrqaxavvwn.supabase.co port=5432 dbname=postgres user=postgres password=NlqR1rEUeGQWHHxx sslmode=require'
PUBLICATION realtime_sync_pub
WITH (
  copy_data = false,
  create_slot = true,
  enabled = true
);

SELECT
  subname,
  subenabled,
  subslotname,
  subsynccommit,
  subpublications
FROM pg_subscription;


DROP SUBSCRIPTION realtime_sync_sub;