import { dispatchRequest } from "./routes.js";

export interface Request {
  path: string;
}

export function serveRequest(request: Request): string {
  return dispatchRequest(request);
}
