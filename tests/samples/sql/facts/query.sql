SELECT u.id, o.name
FROM users u
JOIN organizations o ON o.id = u.organization_id;
