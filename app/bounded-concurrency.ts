/** Run asynchronous work in input order while limiting simultaneous calls. */
export async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!values.length) return [];
  const concurrency = Math.max(1, Math.min(values.length, Math.floor(limit) || 1));
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
