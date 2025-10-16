import defA, { aHelper } from '@acme/pkg-a';
import { localUtil } from '@local/util';

export function consumer() {
  return defA() + aHelper() + localUtil();
}


