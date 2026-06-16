/** Shared structural types used across services. */

/** Deterministic id generator: `idGen('seat') -> 'seat_1'`. */
export type IdGen = (prefix?: string) => string;
