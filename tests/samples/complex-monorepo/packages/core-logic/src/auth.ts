import { User } from "@complex/shared-types";

export function login(username: string): User {
  const config: App.GlobalConfig = { apiUrl: "http://api.local", timeout: 5000 };
  console.log("Login with config:", config);
  return { id: "1", name: username };
}
