// Keep all mutations serialized, but allow only one pending repair. Native
// events raised by a repair must not build an unbounded queue of identical jobs.
export function createEventQueue(initial = Promise.resolve()) {
  let tail = initial.catch(() => {});
  const pending = new Map();
  return (operation, key) => {
    if (key && pending.has(key)) return pending.get(key);
    const result = tail.then(() => {
      if (key) pending.delete(key);
      return operation();
    });
    if (key) pending.set(key, result);
    tail = result.catch(() => {});
    return result;
  };
}
