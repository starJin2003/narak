-- Apply once, in order, only after explicit approval for the target database.
-- Direct PostgreSQL connection only. This migration does not enable the Data API.
BEGIN;

CREATE SCHEMA narak;
REVOKE ALL ON SCHEMA narak FROM PUBLIC;

CREATE TABLE narak.knowledge_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_key text NOT NULL UNIQUE CHECK (case_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  context_summary text NOT NULL CHECK (length(btrim(context_summary)) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'emerging' CHECK (status IN ('emerging', 'verified', 'rejected', 'archived')),
  market text NOT NULL DEFAULT 'KR' CHECK (market = 'KR'),
  event_start_date date,
  event_end_date date,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  reviewed_at timestamptz,
  reviewed_by text CHECK (length(btrim(reviewed_by)) BETWEEN 1 AND 200),
  review_method text CHECK (review_method = 'human_review'),
  review_rationale text CHECK (length(btrim(review_rationale)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (event_end_date IS NULL OR (event_start_date IS NOT NULL AND event_end_date >= event_start_date)),
  CHECK (last_seen_at >= first_seen_at),
  CONSTRAINT verified_requires_review CHECK (status <> 'verified' OR (
    reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_method IS NOT NULL AND review_rationale IS NOT NULL
  ))
);

CREATE TABLE narak.knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Supply the publisher's canonical URL. Do not strip meaningful path/query data.
  canonical_url text NOT NULL UNIQUE CHECK (
    canonical_url = btrim(canonical_url)
    AND canonical_url ~ '^https?://[^/@?#[:space:]]+/[^#[:space:]]*$'
    AND split_part(canonical_url, '/', 3) = lower(split_part(canonical_url, '/', 3))
    AND length(canonical_url) <= 8192
  ),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 1000),
  publisher text CHECK (length(btrim(publisher)) BETWEEN 1 AND 300),
  language_code text NOT NULL CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  published_on date,
  discovered_at timestamptz NOT NULL,
  discovery_method text NOT NULL CHECK (discovery_method IN ('manual', 'meta_web_search')),
  discovered_by text NOT NULL CHECK (length(btrim(discovered_by)) BETWEEN 1 AND 200),
  provenance_note text NOT NULL CHECK (length(btrim(provenance_note)) BETWEEN 1 AND 2000),
  provider_response_id text,
  storage_rights text NOT NULL DEFAULT 'metadata_only' CHECK (storage_rights IN ('metadata_only', 'excerpt_permitted')),
  rights_basis text,
  rights_reviewed_by text,
  rights_reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (storage_rights = 'metadata_only' OR (
    length(btrim(rights_basis)) > 0 AND rights_basis IS NOT NULL
    AND length(btrim(rights_reviewed_by)) > 0 AND rights_reviewed_by IS NOT NULL
    AND rights_reviewed_at IS NOT NULL
  ))
);

CREATE TABLE narak.case_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES narak.knowledge_cases(id) ON DELETE RESTRICT,
  evidence_key text NOT NULL CHECK (evidence_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  source_id uuid NOT NULL REFERENCES narak.knowledge_sources(id) ON DELETE RESTRICT,
  assertion_kind text NOT NULL CHECK (assertion_kind IN ('reported_fact', 'reported_interpretation', 'rebuttal', 'correction', 'model_inference')),
  -- A concise paraphrase or original analysis, never a full copied article.
  assertion_text text NOT NULL CHECK (length(btrim(assertion_text)) BETWEEN 1 AND 4000),
  attribution text NOT NULL CHECK (length(btrim(attribution)) BETWEEN 1 AND 500),
  model_id text CHECK (length(btrim(model_id)) BETWEEN 1 AND 200),
  source_locator text CHECK (length(btrim(source_locator)) BETWEEN 1 AND 1000),
  source_excerpt text CHECK (length(btrim(source_excerpt)) BETWEEN 1 AND 1000),
  related_evidence_id uuid,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, evidence_key),
  UNIQUE (case_id, id),
  FOREIGN KEY (case_id, related_evidence_id) REFERENCES narak.case_evidence(case_id, id) ON DELETE RESTRICT,
  CHECK (related_evidence_id IS DISTINCT FROM id),
  CHECK (assertion_kind <> 'correction' OR related_evidence_id IS NOT NULL),
  CHECK ((assertion_kind = 'model_inference') = (model_id IS NOT NULL))
);

CREATE TABLE narak.case_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES narak.knowledge_cases(id) ON DELETE RESTRICT,
  trigger_key text NOT NULL CHECK (trigger_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  evidence_id uuid NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('copy', 'imagery', 'publication_date')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  match_text text CHECK (length(btrim(match_text)) BETWEEN 1 AND 1000),
  publication_start_date date,
  publication_end_date date,
  valid_from date,
  valid_until date,
  inference_origin text NOT NULL CHECK (inference_origin IN ('human_review', 'model_inference')),
  model_id text CHECK (length(btrim(model_id)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, trigger_key),
  FOREIGN KEY (case_id, evidence_id) REFERENCES narak.case_evidence(case_id, id) ON DELETE RESTRICT,
  CHECK (valid_until IS NULL OR (valid_from IS NOT NULL AND valid_until >= valid_from)),
  CHECK (
    (trigger_kind = 'publication_date' AND publication_start_date IS NOT NULL
      AND publication_end_date IS NOT NULL AND publication_end_date >= publication_start_date)
    OR (trigger_kind IN ('copy', 'imagery') AND match_text IS NOT NULL
      AND publication_start_date IS NULL AND publication_end_date IS NULL)
  ),
  CHECK ((inference_origin = 'model_inference') = (model_id IS NOT NULL))
);

CREATE TABLE narak.case_status_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES narak.knowledge_cases(id) ON DELETE RESTRICT,
  from_status text CHECK (from_status IN ('emerging', 'verified', 'rejected', 'archived')),
  to_status text NOT NULL CHECK (to_status IN ('emerging', 'verified', 'rejected', 'archived')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz,
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  review_method text NOT NULL CHECK (review_method IN ('registration', 'human_review')),
  rationale text NOT NULL CHECK (length(btrim(rationale)) > 0),
  CHECK (from_status IS DISTINCT FROM to_status),
  CHECK ((from_status IS NULL AND to_status = 'emerging' AND review_method = 'registration')
    OR (from_status IS NOT NULL AND review_method = 'human_review' AND reviewed_at IS NOT NULL))
);

CREATE FUNCTION narak.guard_case_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'emerging' OR NEW.reviewed_at IS NOT NULL OR NEW.reviewed_by IS NOT NULL
      OR NEW.review_method IS NOT NULL OR NEW.review_rationale IS NOT NULL THEN
      RAISE EXCEPTION 'New cases must start emerging without review metadata' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.case_key, NEW.market, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.case_key, OLD.market, OLD.created_at) THEN
      RAISE EXCEPTION 'Case identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.reviewed_at IS NULL OR NEW.reviewed_by IS NULL OR NEW.review_method IS DISTINCT FROM 'human_review'
        OR NEW.review_rationale IS NULL OR NEW.reviewed_at > clock_timestamp()
        OR (OLD.reviewed_at IS NOT NULL AND NEW.reviewed_at <= OLD.reviewed_at) THEN
        RAISE EXCEPTION 'Status changes require fresh explicit human review metadata' USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'verified' AND NOT EXISTS (
        SELECT 1 FROM narak.case_evidence WHERE case_id = NEW.id AND assertion_kind = 'reported_fact'
      ) THEN
        RAISE EXCEPTION 'Verification requires source-linked reported facts' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.status = 'verified' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Reopen the verified case before changing its reviewed content' USING ERRCODE = '23514';
    ELSIF ROW(NEW.reviewed_at, NEW.reviewed_by, NEW.review_method, NEW.review_rationale)
      IS DISTINCT FROM ROW(OLD.reviewed_at, OLD.reviewed_by, OLD.review_method, OLD.review_rationale) THEN
      RAISE EXCEPTION 'Review metadata changes require a status transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION narak.record_case_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO narak.case_status_events (case_id, to_status, actor, review_method, rationale)
      VALUES (NEW.id, NEW.status, session_user, 'registration', 'Registered as emerging; not verified.');
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO narak.case_status_events (case_id, from_status, to_status, reviewed_at, actor, review_method, rationale)
      VALUES (NEW.id, OLD.status, NEW.status, NEW.reviewed_at, NEW.reviewed_by, NEW.review_method, NEW.review_rationale);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION narak.guard_status_events() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR pg_trigger_depth() <> 2 THEN
    RAISE EXCEPTION 'Status events are append-only and generated by case transitions' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION narak.guard_case_material() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  parent_id uuid;
  parent_status text;
  source_rights text;
BEGIN
  IF TG_OP = 'DELETE' THEN parent_id := OLD.case_id; ELSE parent_id := NEW.case_id; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.case_id <> OLD.case_id OR NEW.id <> OLD.id) THEN
    RAISE EXCEPTION 'Material identity and case are immutable' USING ERRCODE = '23514';
  END IF;
  -- Serialize material edits with promotion, preventing an unreviewed snapshot.
  SELECT status INTO parent_status FROM narak.knowledge_cases WHERE id = parent_id FOR UPDATE;
  IF parent_status = 'verified' THEN
    RAISE EXCEPTION 'Reopen the verified case before changing its material' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'case_evidence' AND TG_OP <> 'DELETE' THEN
    SELECT storage_rights INTO source_rights FROM narak.knowledge_sources WHERE id = NEW.source_id FOR SHARE;
    IF NEW.source_excerpt IS NOT NULL AND source_rights IS DISTINCT FROM 'excerpt_permitted' THEN
      RAISE EXCEPTION 'Source excerpts require documented storage permission' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION narak.guard_source_changes() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'Source identity is immutable' USING ERRCODE = '23514';
  END IF;
  PERFORM c.id FROM narak.knowledge_cases c JOIN narak.case_evidence e ON e.case_id = c.id
    WHERE e.source_id = OLD.id AND c.status = 'verified' FOR UPDATE OF c;
  IF FOUND THEN
    RAISE EXCEPTION 'Reopen related verified cases before changing their source' USING ERRCODE = '23514';
  END IF;
  IF NEW.storage_rights = 'metadata_only' AND EXISTS (
    SELECT 1 FROM narak.case_evidence WHERE source_id = OLD.id AND source_excerpt IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Remove stored excerpts before revoking their permission' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER case_status_guard BEFORE INSERT OR UPDATE ON narak.knowledge_cases
  FOR EACH ROW EXECUTE FUNCTION narak.guard_case_status();
CREATE TRIGGER case_status_log AFTER INSERT OR UPDATE ON narak.knowledge_cases
  FOR EACH ROW EXECUTE FUNCTION narak.record_case_status();
CREATE TRIGGER status_event_guard BEFORE INSERT OR UPDATE OR DELETE ON narak.case_status_events
  FOR EACH ROW EXECUTE FUNCTION narak.guard_status_events();
CREATE TRIGGER status_event_truncate_guard BEFORE TRUNCATE ON narak.case_status_events
  FOR EACH STATEMENT EXECUTE FUNCTION narak.guard_status_events();
CREATE TRIGGER evidence_material_guard BEFORE INSERT OR UPDATE OR DELETE ON narak.case_evidence
  FOR EACH ROW EXECUTE FUNCTION narak.guard_case_material();
CREATE TRIGGER trigger_material_guard BEFORE INSERT OR UPDATE OR DELETE ON narak.case_triggers
  FOR EACH ROW EXECUTE FUNCTION narak.guard_case_material();
CREATE TRIGGER source_change_guard BEFORE UPDATE ON narak.knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION narak.guard_source_changes();

CREATE INDEX cases_status_seen_idx ON narak.knowledge_cases (market, status, last_seen_at DESC, id);
CREATE INDEX evidence_source_idx ON narak.case_evidence (source_id);
CREATE INDEX evidence_related_idx ON narak.case_evidence (case_id, related_evidence_id);
CREATE INDEX triggers_evidence_idx ON narak.case_triggers (case_id, evidence_id);
CREATE INDEX status_events_case_idx ON narak.case_status_events (case_id, id);

COMMENT ON TABLE narak.knowledge_cases IS 'Case lifecycle and human review metadata; evidence assertions belong in case_evidence.';
COMMENT ON TABLE narak.knowledge_sources IS 'Bibliographic metadata and provenance only by default. No full article storage.';
COMMENT ON TABLE narak.case_evidence IS 'Source-linked paraphrases, reported interpretations, rebuttals, corrections, and explicitly labeled model inference.';
COMMENT ON TABLE narak.case_triggers IS 'Contextual relevance hypotheses linked to evidence in the same case; never proof of intent.';
COMMENT ON TABLE narak.case_status_events IS 'Append-only ordinary-DML audit trail. Database owners can alter DDL and must remain trusted.';

REVOKE ALL ON ALL TABLES IN SCHEMA narak FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA narak FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA narak FROM PUBLIC;

COMMIT;
