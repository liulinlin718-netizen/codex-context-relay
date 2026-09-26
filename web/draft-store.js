/** Serialize saves and coalesce intermediate edits without reporting stale saves
 * as current. Failed writes remain pending until retry or another edit. */
export function createDraftStore({save, onStatus = () => {}, copy=structuredClone}) {
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
    update(snapshot) { latest = copy(snapshot); revision++; return flush(); },
    flush,
    pending,
  };
}

// Excerpt snapshots are immutable in the selector. Copy their container, not
// the potentially multi-megabyte strings, on a question/background edit.
export function captureDraft({historyId=null,pack=null,question='',selectionCounter=0,excerptOrder}) {
  return {historyId,question,selectionCounter,excerptOrder:[...(excerptOrder||pack?.excerpts.map(x=>x.id)||[])],pack:pack?{...pack,question,
    excerpts:[...pack.excerpts],memory:pack.memory.map(m=>({...m,sourceExcerptIds:[...m.sourceExcerptIds]}))}:null};
}
export function draftChanges(previous,next) {
  if(!previous||previous.historyId!==next.historyId||Boolean(previous.pack)!==Boolean(next.pack))return null;
  if(next.pack){
    if(previous.pack.packId!==next.pack.packId||previous.pack.createdAt!==next.pack.createdAt||previous.pack.schemaVersion!==next.pack.schemaVersion)return null;
    const before=new Map(previous.pack.excerpts.map(x=>[x.id,x]));
    if(before.size!==next.pack.excerpts.length||next.pack.excerpts.some(x=>before.get(x.id)!==x))return null;
  }
  const changes={};
  if(previous.question!==next.question)changes.question=next.question;
  if(previous.selectionCounter!==next.selectionCounter)changes.selectionCounter=next.selectionCounter;
  if(next.pack){
    if(JSON.stringify(previous.pack.memory)!==JSON.stringify(next.pack.memory))changes.memory=next.pack.memory;
    if(previous.excerptOrder.some((id,i)=>id!==next.excerptOrder[i]))changes.excerptOrder=next.excerptOrder;
  }
  return changes;
}
