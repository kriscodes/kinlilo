ALTER TABLE tracking_sessions ADD UNIQUE (id, circle_id, user_id, device_id);

CREATE TABLE location_points (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  circle_id uuid NOT NULL,
  user_id text NOT NULL,
  device_id uuid NOT NULL,
  event_id uuid NOT NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m double precision NOT NULL CHECK (accuracy_m >= 0 AND accuracy_m < 'Infinity'::double precision),
  UNIQUE (device_id, event_id),
  UNIQUE (circle_id, user_id, captured_at, id),
  FOREIGN KEY (session_id, circle_id, user_id, device_id)
    REFERENCES tracking_sessions (id, circle_id, user_id, device_id) ON DELETE CASCADE
);

CREATE INDEX location_points_by_session ON location_points (session_id);

CREATE TABLE latest_locations (
  circle_id uuid NOT NULL,
  user_id text NOT NULL,
  captured_at timestamptz NOT NULL,
  point_id uuid NOT NULL,
  PRIMARY KEY (circle_id, user_id),
  FOREIGN KEY (circle_id, user_id, captured_at, point_id)
    REFERENCES location_points (circle_id, user_id, captured_at, id) ON DELETE CASCADE
);
