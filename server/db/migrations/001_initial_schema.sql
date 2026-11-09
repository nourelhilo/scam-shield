-- ScamShield initial schema.
-- Privacy rule: raw submitted messages are NEVER stored. Saved scans keep only the
-- input type, a content length, the risk result, and indicator metadata (no evidence snippets).

CREATE TABLE users (
  id                 uuid PRIMARY KEY,
  email              text NOT NULL,
  email_normalized   text NOT NULL UNIQUE,
  password_hash      text NOT NULL,
  display_name       text,
  role               text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  email_verified_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Opaque session tokens. Only a SHA-256 hash of the token is stored.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  user_agent    text
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

-- Single-use tokens for email verification and password reset (hash stored, never the token).
CREATE TABLE user_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_tokens_user_purpose_idx ON user_tokens(user_id, purpose);

-- Opt-in scan history. Ownership enforced by user_id; deleting a user deletes their scans.
CREATE TABLE scans (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_type       text NOT NULL CHECK (input_type IN ('text', 'url', 'email', 'image')),
  content_length   integer NOT NULL CHECK (content_length >= 0),
  language         text NOT NULL,
  risk_level       text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'unknown')),
  indicators       jsonb NOT NULL DEFAULT '[]'::jsonb,
  explanation      text NOT NULL,
  recommendations  jsonb NOT NULL DEFAULT '[]'::jsonb,
  analysis_method  text NOT NULL,
  ai_status        text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scans_user_created_idx ON scans(user_id, created_at DESC);
CREATE INDEX scans_user_risk_idx ON scans(user_id, risk_level);

-- User feedback about an analysis. Not treated as ground truth; reviewed by admins.
CREATE TABLE feedback (
  id           uuid PRIMARY KEY,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  scan_id      uuid REFERENCES scans(id) ON DELETE SET NULL,
  analysis_id  text,
  feedback_type text NOT NULL CHECK (feedback_type IN ('false_positive', 'missed_scam', 'unclear_explanation', 'other')),
  reported_risk_level text CHECK (reported_risk_level IN ('low', 'medium', 'high', 'unknown')),
  comment      text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_status_created_idx ON feedback(status, created_at DESC);
CREATE INDEX feedback_user_idx ON feedback(user_id);

CREATE TABLE articles (
  id            uuid PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  title         text NOT NULL,
  category      text NOT NULL CHECK (category IN ('phishing', 'fake_shopping', 'sms_scams', 'email_fraud', 'account_impersonation', 'payment_safety')),
  language      text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar')),
  summary       text NOT NULL,
  body          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at  timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX articles_status_category_idx ON articles(status, category);

-- Admin audit log. Actor is kept as SET NULL so the log survives account deletion.
CREATE TABLE audit_logs (
  id           uuid PRIMARY KEY,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);

-- Anonymous aggregate counters (no user id, no content) for admin metrics.
-- Covers guest scans too, without persisting them.
CREATE TABLE analysis_daily_stats (
  day              date NOT NULL,
  input_type       text NOT NULL,
  risk_level       text NOT NULL,
  analysis_method  text NOT NULL,
  count            integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, input_type, risk_level, analysis_method)
);
