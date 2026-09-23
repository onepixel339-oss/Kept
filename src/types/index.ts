/**
 * Shared types — cross-cutting contracts used across the whole app.
 *
 * Domain types that belong to one module conceptually still live here
 * while the module system is young; they are documented with their
 * owning module. When a module grows a real public API, its types move
 * behind that API.
 */

export * from "./memory";
export * from "./memory-version";
export * from "./entity";
export * from "./relation";
export * from "./source";
export * from "./api";
export * from "./processing";
export * from "./query";
export * from "./conversation";
