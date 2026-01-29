import React from 'react';
import type { User } from '@complex/shared-types';

export const UserProfile: React.FC<{ user: User }> = ({ user }) => {
  return <div>{user.name}</div>;
};
