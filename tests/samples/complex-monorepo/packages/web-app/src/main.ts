import { login } from '@complex/core-logic';
import type { User } from '@complex/shared-types';

async function startApp() {
  const user: User = login('admin');
  console.log('User logged in:', user);

  // Dynamic import
  const { log } = await import('./plugins/logger');
  log('App started');
}

startApp();
