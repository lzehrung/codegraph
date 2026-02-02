// Module A - part of circular re-export chain
export { fromB } from "./moduleB";
export const fromA = () => "A";
