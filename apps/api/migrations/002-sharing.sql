ALTER TABLE circle_memberships ADD COLUMN sharing_version uuid NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  registered_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (user_id, installation_id),
  UNIQUE (user_id, id)
);

CREATE TABLE tracking_sessions (
  id uuid PRIMARY KEY,
  circle_id uuid NOT NULL,
  user_id text NOT NULL,
  device_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz CHECK (ended_at >= started_at),
  FOREIGN KEY (circle_id, user_id) REFERENCES circle_memberships (circle_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, device_id) REFERENCES devices (user_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX tracking_sessions_active_member ON tracking_sessions (circle_id, user_id) WHERE ended_at IS NULL;
CREATE INDEX tracking_sessions_by_membership ON tracking_sessions (circle_id, user_id);
CREATE INDEX tracking_sessions_by_device ON tracking_sessions (device_id);
