-- Slice 6: the sender reports other connection failures (ECONNRESET, bad HTTP status line...) as
-- `connection_error`. Only the ALTER TYPE lives here: Postgres refuses to use a new enum value in
-- the transaction that added it.
ALTER TYPE attempt_error ADD VALUE 'connection_error';
