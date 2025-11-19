import type { Config } from "./types";

interface User {
  id: string;
  name: string;
}

enum Role {
  Admin,
  User,
}

type UserId = string;

class Service {
  constructor(private id: UserId) {}

  getRole(user: User): Role {
    return Role.User;
  }
}

function helper(x: number): number {
  return x * 2;
}

