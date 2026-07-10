export interface AccountRow {
  id: number;
  email: string;
  status: string;
}

export const listActiveAccountsQuery = `
  SELECT id, email, status
  FROM accounts
  WHERE status = 'active'
`;
