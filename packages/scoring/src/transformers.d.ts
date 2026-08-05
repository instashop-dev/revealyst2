/**
 * Ambient types for the OPTIONAL @xenova/transformers peer dependency.
 *
 * Only the surface used by OnnxScoringAdapter is declared. The package is
 * resolved at runtime through a dynamic import and is not required to be
 * installed — when absent, the adapter falls back to rule-based scoring.
 */
declare module "@xenova/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: { quantized?: boolean; revision?: string },
  ): Promise<unknown>;
}
