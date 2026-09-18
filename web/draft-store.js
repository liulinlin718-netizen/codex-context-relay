/** Serialize saves and coalesce intermediate edits without reporting stale saves
 * as current. Failed writes remain pending until retry or another edit. */
export function createDraftStore({save, onStatus = () => {}}) {
  let latest, revision = 0, savedRevision = 0, inFlight;
  const pending = () => savedRevision !== revision;
  async function drain() {
    while (pending()) {
      const currentRevision = revision;
      const snapshot = latest;
      onStatus('saving');
      try { await save(snapshot); }
      catch (error) { onStatus('error', error); return; }
      savedRevision = currentRevision;
    }
    onStatus('saved');
  }
  function flush() {
    if (!inFlight && pending()) inFlight = drain().finally(() => { inFlight = null; });
    return inFlight || Promise.resolve();
  }
  return {
    update(snapshot) { latest = structuredClone(snapshot); revision++; return flush(); },
    flush,
    pending,
  };
}
