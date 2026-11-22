CREATE TABLE circles (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE circle_memberships (
  circle_id uuid NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (circle_id, user_id)
);

CREATE UNIQUE INDEX circle_single_owner ON circle_memberships (circle_id) WHERE role = 'owner';
CREATE INDEX circle_memberships_by_user ON circle_memberships (user_id);

CREATE TABLE circle_invites (
  token_hash text PRIMARY KEY,
  circle_id uuid NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz
);
