// This creates a circular dependency via the barrel file
import { login } from "./index";

export function autoLogin() {
  return login("system");
}
