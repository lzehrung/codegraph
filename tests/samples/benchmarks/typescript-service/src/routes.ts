import { getHealth } from "./handlers/health.js";

export interface RoutedRequest {
  path: string;
}

export function dispatchRequest(request: RoutedRequest): string {
  if (request.path === "/health") {
    return getHealth();
  }

  return "not found";
}
