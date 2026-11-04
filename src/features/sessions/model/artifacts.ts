import type { SessionArtifact } from "./index";

/** Pins keep their own order; file edits only reorder the unpinned remainder. */
export function orderSessionArtifacts(
  artifacts: readonly SessionArtifact[],
  pinnedPaths: readonly string[],
): (SessionArtifact & { pinned?: true })[] {
  const pins = new Set(pinnedPaths);
  const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  return [
    ...pinnedPaths.flatMap((path) => {
      const artifact = byPath.get(path);
      return artifact ? [{ ...artifact, pinned: true as const }] : [];
    }),
    ...artifacts
      .filter(({ path }) => !pins.has(path))
      .sort((left, right) => right.updatedAt - left.updatedAt),
  ];
}
