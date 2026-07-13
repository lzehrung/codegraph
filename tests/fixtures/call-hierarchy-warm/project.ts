export function leaf(value: number): number {
  return value + 1;
}

export function left(value: number): number {
  return leaf(value) + leaf(value + 1);
}

export function right(value: number): number {
  return leaf(value) + 2;
}

export function branch(value: number): number {
  return left(value) + right(value);
}

export function root(value: number): number {
  return branch(value) + left(value);
}
