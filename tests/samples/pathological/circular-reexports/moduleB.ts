// Module B - part of circular re-export chain
export { fromC } from "./moduleC";
export const fromB = () => "B";
