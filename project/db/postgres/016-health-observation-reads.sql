ALTER TABLE activity_observations ADD COLUMN __sequence BIGSERIAL UNIQUE;
CREATE TABLE health_observation_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES activity_observations(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  PRIMARY KEY(user_id,observation_id)
);
CREATE INDEX health_reads_observation ON health_observation_reads(observation_id);
