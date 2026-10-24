export interface StoreOptions { active: boolean } // @def StoreOptions @coverage StoreOptions complete
export const initialCount = 3; // @def initialCount @coverage initialCount complete
export function createStore(value: number) { return { value }; } // @def createStore @coverage createStore complete
export function scale(value: number) { return value * 2; } // @def scale @coverage scale complete
