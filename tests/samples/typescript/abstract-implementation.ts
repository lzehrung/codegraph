export abstract class AbstractJob {
  abstract execute(): void;
}

export class ConcreteJob extends AbstractJob {
  execute(): void {}
}
