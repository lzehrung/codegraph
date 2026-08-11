SELECT *
FROM (
  WITH first_user_ids AS (
    SELECT id FROM accounts
  ),
  second_user_ids AS (
    SELECT id FROM users
  )
  SELECT first_user_ids.id
  FROM first_user_ids
  JOIN second_user_ids ON second_user_ids.id = first_user_ids.id
) nested_ctes;
