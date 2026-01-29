import { User } from '@complex/shared-types';

export function login(username: string): User {
  return { id: '1', name: username };
}
