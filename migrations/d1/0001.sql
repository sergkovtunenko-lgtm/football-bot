CREATE TABLE IF NOT EXISTS bot_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  commit_id TEXT NOT NULL
);
INSERT OR IGNORE INTO bot_revision VALUES (1, 0, 'initial');
CREATE TABLE IF NOT EXISTS bot_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS bot_scope ON bot_records(kind, scope);
CREATE INDEX IF NOT EXISTS bot_status ON bot_records(kind, status);
