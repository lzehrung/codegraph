import { aHelper, AClass, A_CONST } from '@acme/pkg-a';

export function bUseA() {
  return aHelper() + A_CONST;
}

export function bMakeA() {
  return new AClass(2);
}


