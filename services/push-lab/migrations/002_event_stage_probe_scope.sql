ALTER TABLE deliveries
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'test' CHECK (scope IN ('test', 'deployment_probe'));

ALTER TABLE events
  ADD COLUMN stage_intent TEXT;

INSERT INTO schema_meta(version, applied_at)
VALUES (2, unixepoch());
