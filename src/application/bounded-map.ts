/** Trim insertion order only; owners retain expiry, refresh and cleanup semantics. */
export function trimOldestEntries<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}
