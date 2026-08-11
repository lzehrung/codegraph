CREATE TABLE source_users (id integer);
GO
BEGIN
  INSERT INTO audit_users (id) SELECT id FROM source_users;
  SELECT id FROM source_users;
END;
GO
SELECT id FROM audit_users;
