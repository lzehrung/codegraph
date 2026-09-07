type SigmaNodeReducer = (node: string, data: Record<string, unknown>) => Record<string, unknown>;

type SigmaMockSettings = {
  nodeReducer?: SigmaNodeReducer;
};

type SigmaMockEventHandler = (payload: Record<string, unknown>) => void;

export const sigmaInstances: SigmaMock[] = [];

export default class SigmaMock {
  readonly settings: SigmaMockSettings;
  private readonly eventHandlers = new Map<string, SigmaMockEventHandler>();

  constructor(_graph?: unknown, _container?: unknown, settings: SigmaMockSettings = {}) {
    this.settings = settings;
    sigmaInstances.push(this);
  }

  on(event: string, handler: SigmaMockEventHandler) {
    this.eventHandlers.set(event, handler);
  }

  off(event: string) {
    this.eventHandlers.delete(event);
  }

  emit(event: string, payload: Record<string, unknown>) {
    this.eventHandlers.get(event)?.(payload);
  }

  refresh() {}
  kill() {}
  getCamera() {
    return { animate() {}, animatedReset() {} };
  }
  getNodeDisplayData() {
    return null;
  }
}
