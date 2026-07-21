CREATE TABLE IF NOT EXISTS settings (
  key Utf8 NOT NULL,
  value Utf8 NOT NULL,
  updated_at Timestamp NOT NULL,
  PRIMARY KEY (key)
);
-- statement-break
CREATE TABLE IF NOT EXISTS players (
  telegram_user_id Utf8 NOT NULL,
  display_name Utf8 NOT NULL,
  username Utf8,
  updated_at Timestamp NOT NULL,
  PRIMARY KEY (telegram_user_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS sessions (
  session_id Utf8 NOT NULL,
  status Utf8 NOT NULL,
  next_queue_position Uint64 NOT NULL,
  next_win_ordinal Uint64 NOT NULL,
  registration_message_id Utf8,
  score_message_id Utf8,
  created_at Timestamp NOT NULL,
  closed_at Timestamp,
  finished_at Timestamp,
  PRIMARY KEY (session_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS participants (
  session_id Utf8 NOT NULL,
  participant_id Utf8 NOT NULL,
  owner_user_id Utf8 NOT NULL,
  telegram_user_id Utf8,
  display_name Utf8 NOT NULL,
  kind Utf8 NOT NULL,
  guest_number Uint8,
  queue_position Uint64 NOT NULL,
  roster_status Utf8 NOT NULL,
  PRIMARY KEY (session_id, participant_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS teams (
  session_id Utf8 NOT NULL,
  team_number Uint8 NOT NULL,
  PRIMARY KEY (session_id, team_number)
);
-- statement-break
CREATE TABLE IF NOT EXISTS team_members (
  session_id Utf8 NOT NULL,
  team_number Uint8 NOT NULL,
  participant_id Utf8 NOT NULL,
  role Utf8 NOT NULL,
  PRIMARY KEY (session_id, team_number, participant_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS win_events (
  session_id Utf8 NOT NULL,
  ordinal Uint64 NOT NULL,
  team_number Uint8 NOT NULL,
  admin_user_id Utf8 NOT NULL,
  created_at Timestamp NOT NULL,
  reversed_at Timestamp,
  PRIMARY KEY (session_id, ordinal)
);
-- statement-break
CREATE TABLE IF NOT EXISTS win_awards (
  session_id Utf8 NOT NULL,
  win_ordinal Uint64 NOT NULL,
  telegram_user_id Utf8 NOT NULL,
  display_name Utf8 NOT NULL,
  PRIMARY KEY (session_id, win_ordinal, telegram_user_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id Utf8 NOT NULL,
  processed_at Timestamp NOT NULL,
  PRIMARY KEY (update_id)
) WITH (TTL = Interval("P90D") ON processed_at);
-- statement-break
CREATE TABLE IF NOT EXISTS scheduled_actions (
  action_key Utf8 NOT NULL,
  session_id Utf8 NOT NULL,
  kind Utf8 NOT NULL,
  executed_at Timestamp NOT NULL,
  PRIMARY KEY (action_key)
);
-- statement-break
CREATE TABLE IF NOT EXISTS outbox (
  effect_id Utf8 NOT NULL,
  kind Utf8 NOT NULL,
  payload_json Utf8 NOT NULL,
  status Utf8 NOT NULL,
  attempts Uint32 NOT NULL,
  next_attempt_at Timestamp NOT NULL,
  lease_id Utf8,
  lease_until Timestamp,
  created_at Timestamp NOT NULL,
  sent_at Timestamp,
  failed_at Timestamp,
  last_error Utf8,
  PRIMARY KEY (effect_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS schema_migrations (
  version Uint32 NOT NULL,
  applied_at Timestamp NOT NULL,
  PRIMARY KEY (version)
);
