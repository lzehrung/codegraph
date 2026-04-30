import React from "react";
import { login as shadowedLogin } from "@complex/shadowed";
import type { User } from "@complex/shared-types";

// This 'React' should resolve to packages/shared-types/src/index.ts due to shadowing
export const UserProfile: React.FC<{ user: User }> = ({ user }) => {
  return <div>{user.name}</div>;
};
