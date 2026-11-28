/**
 * Tracks the latest validation generation for each document URI.
 *
 * Validations can overlap after a configuration change: an older run may
 * finish after a newer run and otherwise publish stale diagnostics. Generation
 * numbers come from one process-wide sequence so closing and reopening a URI
 * cannot make an old generation current again. Call {@link next} before
 * starting work and check {@link isCurrent} before publishing the result.
 */
export class DocumentGenerations {
  private readonly generations = new Map<string, number>();
  private sequence = 0;

  next(uri: string): number {
    const generation = ++this.sequence;
    this.generations.set(uri, generation);
    return generation;
  }

  isCurrent(uri: string, generation: number): boolean {
    return this.generations.get(uri) === generation;
  }

  delete(uri: string): void {
    this.generations.delete(uri);
  }
}
