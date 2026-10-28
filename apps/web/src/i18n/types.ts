export type Widen<T> = T extends (...args: infer A) => string ? (...args: A) => string : string;
/** An area's vi dictionary: every key of its en one, with the same call signatures. */
export type DictOf<T> = { [K in keyof T]: Widen<T[K]> };
