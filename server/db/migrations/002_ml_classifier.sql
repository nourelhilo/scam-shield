-- ScamShield's own ML classifier replaces the external AI integration.
-- Records, per saved scan, whether the model ran and which model version produced the result.
-- Additive and nullable: scans saved before this migration keep NULL here.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS ml_status text;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS model_version text;
