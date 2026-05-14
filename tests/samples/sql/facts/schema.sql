CREATE TABLE users (
  id integer primary key,
  organization_id integer REFERENCES organizations(id)
);

CREATE VIEW active_users AS
SELECT id, organization_id
FROM users
WHERE active = true;

CREATE INDEX users_org_idx ON users (organization_id);
