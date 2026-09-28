export class Store {
  constructor(readonly filePath: string) {}
  metadata(): number {
    return 1;
  }
  replace(metadata: number): number {
    return metadata + this.metadata();
  }
  close(): void {}
}

export type SessionStore = {
  delete(id: string): void;
};

export function createSessionStore(): SessionStore {
  return {
    delete(id: string): void {
      void id;
    },
  };
}
