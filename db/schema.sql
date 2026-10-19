CREATE TABLE IF NOT EXISTS slots (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  capacity    integer NOT NULL CHECK (capacity >= 0)
);

CREATE TABLE IF NOT EXISTS sessions (
  id           serial PRIMARY KEY,
  slot_code    text NOT NULL REFERENCES slots(code),
  session_date date NOT NULL,
  UNIQUE (slot_code, session_date)
);

CREATE TABLE IF NOT EXISTS members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                 text NOT NULL UNIQUE,
  plan                text NOT NULL,
  amount_pence        integer NOT NULL,
  payment_day         integer NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  parent_name         text NOT NULL,
  email               text NOT NULL,
  phone               text NOT NULL,
  child_name          text NOT NULL,
  child_dob           date NOT NULL,
  emergency_name      text NOT NULL,
  emergency_phone     text NOT NULL,
  medical             text NOT NULL DEFAULT '',
  terms_agreed        boolean NOT NULL,
  photo_consent       boolean NOT NULL,
  gc_billing_request  text UNIQUE,
  gc_mandate          text,
  gc_subscription     text,
  first_charge_date   date,
  last_payment_status text,
  notes               text NOT NULL DEFAULT '',
  hold_expires        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  confirmed_at        timestamptz
);

CREATE TABLE IF NOT EXISTS member_slots (
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  slot_code text NOT NULL REFERENCES slots(code),
  PRIMARY KEY (member_id, slot_code)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id          text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS members_status_idx ON members (status);
CREATE INDEX IF NOT EXISTS members_subscription_idx ON members (gc_subscription);
CREATE INDEX IF NOT EXISTS members_mandate_idx ON members (gc_mandate);
