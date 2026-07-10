import { formatRequest } from "./transport.js";

export function sendRequest(resource: string): string {
  return formatRequest(resource);
}
