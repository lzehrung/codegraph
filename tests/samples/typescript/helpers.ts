import { format } from "date-fns";

export function helperFunction(): string {
  return "Helper function from helpers module";
}

export function anotherHelper(): number {
  return 123;
}

export function formatHelperDate(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

export interface HelperInterface {
  name: string;
  value: number;
}
