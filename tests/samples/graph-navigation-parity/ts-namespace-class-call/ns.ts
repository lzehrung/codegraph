namespace N {
  export class C {}
  export function f(): number { return 1; }
}
export function use(): unknown {
  const bad = (N as any).C;
  return [N.f(), new N.C(), bad];
}
export function invalid(): unknown {
  // @ts-expect-error classes need new
  return N.C();
}
