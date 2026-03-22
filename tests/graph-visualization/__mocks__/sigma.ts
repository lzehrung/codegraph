/**
 * Minimal Sigma mock for tests that import graph-builder.js.
 * graph-builder.js does not use Sigma, but the alias must resolve.
 */
export default class SigmaMock {
  constructor() {}
  on() {}
  off() {}
  refresh() {}
  kill() {}
  getCamera() {
    return { animate() {}, animatedReset() {} };
  }
  getNodeDisplayData() {
    return null;
  }
}
