/**
 * Public surface of the time module. Other modules import from here only.
 *
 * In one line: code owns the clock, zones and date maths; the model only ever
 * sees resolved, absolute, labelled dates.
 */
export * from "./types";
export * from "./clock";
export * from "./context";
export * from "./zone";
export * from "./pipeline";
export * from "./policy";
export * from "./adapters";
export { refersToPast, maskEntities, hasTimeCue } from "./cues";
export type { AnchorLookup, TemporalResolver } from "./resolvers/base";
export type { LlmTimeFallback, LlmTimeGuess } from "./resolvers/llm";
