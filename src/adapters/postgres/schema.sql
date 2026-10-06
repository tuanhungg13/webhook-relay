--
-- PostgreSQL database dump
--

\restrict webhookrelay

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: attempt_error; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.attempt_error AS ENUM (
    'timeout',
    'connection_refused',
    'dns',
    'tls',
    'ssrf_blocked',
    'circuit_open'
);


--
-- Name: delivery_failed_reason; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.delivery_failed_reason AS ENUM (
    'exhausted',
    'endpoint_deleted',
    'endpoint_disabled'
);


--
-- Name: delivery_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.delivery_status AS ENUM (
    'pending',
    'in_flight',
    'succeeded',
    'failed'
);


--
-- Name: endpoint_disabled_reason; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.endpoint_disabled_reason AS ENUM (
    'manual',
    'auto_failing'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid NOT NULL,
    app_id uuid NOT NULL,
    key_hash bytea NOT NULL,
    prefix text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: apps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apps (
    id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT apps_name_check CHECK ((name <> ''::text))
);


--
-- Name: attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attempts (
    id uuid NOT NULL,
    delivery_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    started_at timestamp with time zone NOT NULL,
    duration_ms integer NOT NULL,
    http_status integer,
    response_snippet text,
    error public.attempt_error,
    CONSTRAINT attempts_attempt_number_check CHECK ((attempt_number >= 1)),
    CONSTRAINT attempts_duration_ms_check CHECK ((duration_ms >= 0)),
    CONSTRAINT attempts_http_status_check CHECK (((http_status >= 100) AND (http_status <= 599))),
    CONSTRAINT attempts_http_status_xor_error CHECK (((http_status IS NULL) <> (error IS NULL)))
);


--
-- Name: deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deliveries (
    id uuid NOT NULL,
    event_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    status public.delivery_status NOT NULL,
    failed_reason public.delivery_failed_reason,
    attempt_count integer NOT NULL,
    next_attempt_at timestamp with time zone NOT NULL,
    lease_until timestamp with time zone,
    lease_token uuid,
    gate_blocked_count integer NOT NULL,
    traceparent text,
    last_error text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT deliveries_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT deliveries_failed_reason_iff_failed CHECK (((status = 'failed'::public.delivery_status) = (failed_reason IS NOT NULL))),
    CONSTRAINT deliveries_gate_blocked_count_check CHECK ((gate_blocked_count >= 0)),
    CONSTRAINT deliveries_lease_token_iff_in_flight CHECK (((status = 'in_flight'::public.delivery_status) = (lease_token IS NOT NULL))),
    CONSTRAINT deliveries_lease_until_iff_lease_token CHECK (((lease_token IS NULL) = (lease_until IS NULL)))
);


--
-- Name: endpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.endpoints (
    id uuid NOT NULL,
    app_id uuid NOT NULL,
    customer_id text NOT NULL,
    url text NOT NULL,
    event_types text[] NOT NULL,
    secret text NOT NULL,
    previous_secret text,
    previous_secret_expires_at timestamp with time zone,
    rate_limit_rps integer NOT NULL,
    max_concurrency integer NOT NULL,
    first_failure_at timestamp with time zone,
    disabled_at timestamp with time zone,
    disabled_reason public.endpoint_disabled_reason,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT endpoints_disabled_reason_iff_disabled CHECK (((disabled_at IS NULL) = (disabled_reason IS NULL))),
    CONSTRAINT endpoints_event_types_check CHECK ((cardinality(event_types) >= 1)),
    CONSTRAINT endpoints_max_concurrency_check CHECK (((max_concurrency >= 1) AND (max_concurrency <= 100))),
    CONSTRAINT endpoints_previous_secret_has_expiry CHECK (((previous_secret IS NULL) = (previous_secret_expires_at IS NULL))),
    CONSTRAINT endpoints_rate_limit_rps_check CHECK (((rate_limit_rps >= 1) AND (rate_limit_rps <= 1000)))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid NOT NULL,
    app_id uuid NOT NULL,
    customer_id text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    dispatched_at timestamp with time zone,
    requeued_at timestamp with time zone
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    app_id uuid NOT NULL,
    key text NOT NULL,
    event_id uuid NOT NULL,
    request_hash bytea NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT idempotency_keys_key_check CHECK (((char_length(key) >= 1) AND (char_length(key) <= 255)))
);


--
-- Name: outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox (
    id bigint NOT NULL,
    event_id uuid NOT NULL,
    traceparent text,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.outbox ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: apps apps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_pkey PRIMARY KEY (id);


--
-- Name: attempts attempts_delivery_id_attempt_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempts
    ADD CONSTRAINT attempts_delivery_id_attempt_number_key UNIQUE (delivery_id, attempt_number);


--
-- Name: attempts attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempts
    ADD CONSTRAINT attempts_pkey PRIMARY KEY (id);


--
-- Name: deliveries deliveries_event_id_endpoint_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_event_id_endpoint_id_key UNIQUE (event_id, endpoint_id);


--
-- Name: deliveries deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (id);


--
-- Name: endpoints endpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.endpoints
    ADD CONSTRAINT endpoints_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (app_id, key);


--
-- Name: outbox outbox_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_event_id_key UNIQUE (event_id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: api_keys_by_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_by_app ON public.api_keys USING btree (app_id);


--
-- Name: deliveries_by_endpoint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliveries_by_endpoint ON public.deliveries USING btree (endpoint_id, status, created_at DESC, id DESC);


--
-- Name: deliveries_in_flight_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliveries_in_flight_lease ON public.deliveries USING btree (lease_until) WHERE (status = 'in_flight'::public.delivery_status);


--
-- Name: deliveries_pending_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliveries_pending_due ON public.deliveries USING btree (next_attempt_at) WHERE (status = 'pending'::public.delivery_status);


--
-- Name: endpoints_by_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX endpoints_by_customer ON public.endpoints USING btree (app_id, customer_id) WHERE (deleted_at IS NULL);


--
-- Name: events_by_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_by_created ON public.events USING btree (created_at);


--
-- Name: events_by_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_by_customer ON public.events USING btree (app_id, customer_id, created_at DESC, id DESC);


--
-- Name: events_undispatched; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_undispatched ON public.events USING btree (created_at) WHERE (dispatched_at IS NULL);


--
-- Name: idempotency_keys_by_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_keys_by_created ON public.idempotency_keys USING btree (created_at);


--
-- Name: idempotency_keys_by_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_keys_by_event ON public.idempotency_keys USING btree (event_id);


--
-- Name: api_keys api_keys_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id);


--
-- Name: attempts attempts_delivery_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempts
    ADD CONSTRAINT attempts_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.deliveries(id);


--
-- Name: deliveries deliveries_endpoint_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_endpoint_id_fkey FOREIGN KEY (endpoint_id) REFERENCES public.endpoints(id);


--
-- Name: deliveries deliveries_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id);


--
-- Name: endpoints endpoints_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.endpoints
    ADD CONSTRAINT endpoints_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id);


--
-- Name: events events_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id);


--
-- Name: idempotency_keys idempotency_keys_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id);


--
-- Name: idempotency_keys idempotency_keys_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: outbox outbox_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict webhookrelay

