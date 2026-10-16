import type { components } from "./api";

export type { components, operations, paths } from "./api";

/** A named schema from the API's OpenAPI document, e.g. `ApiSchema<"ReadinessResponse">`. */
export type ApiSchema<Name extends keyof components["schemas"]> = components["schemas"][Name];
