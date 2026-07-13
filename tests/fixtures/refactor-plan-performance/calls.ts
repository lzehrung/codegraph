export function target(): number {
  return 1;
}
export function directCaller(): number {
  return target();
}
export function levelTwo(): number {
  return directCaller();
}
export function levelOne(): number {
  return levelTwo();
}
export function callRoot(): number {
  return levelOne();
}
