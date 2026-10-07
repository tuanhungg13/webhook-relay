-- GET /v1/endpoints without customer_id: newest first within one app. Without this index the
-- query walks endpoints_pkey backwards and skips other apps' rows (measured: 5073 buffers vs 13).
CREATE INDEX endpoints_by_app ON endpoints (app_id, id DESC) WHERE deleted_at IS NULL;
