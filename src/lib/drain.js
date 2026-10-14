/**
 * Resolves once everything already written to stdout and stderr has left the
 * process. On macOS a write to a pipe is asynchronous, so exiting straight
 * after a large write dropped everything past the pipe's buffer (64 KiB or
 * less): `muhkoo kv ls vfs/ | wc -l` lost keys and still exited 0. An empty
 * write's callback runs after every write queued before it. It also runs when
 * the reader has gone away (`| head`), and so does the `error` listener, so
 * this never waits on a closed pipe and a closed pipe does not crash the exit.
 *
 * The `error` listener must not set off Node's listener-leak warning. A ZK
 * login leaves the prover's worker threads alive, one per core, and Node pipes
 * each one's stdout and stderr into the process's own: one `error` listener
 * each, added without a warning because Node raises the limit around the pipe.
 * On a 14-core Mac this listener was the 15th, past the default limit of 10,
 * and `muhkoo login` ended with the warning printed twice. So the limit is
 * raised as Node raises it, only while the listener is added, and only as far
 * as it must be: by one is not enough when the count is already past it. The
 * listener goes again once the write has gone through. After a failed write on
 * a stream that was live before the write it stays: that stream emits its
 * `error` only after the write's callback, and with no listener the error
 * would go unhandled. It comes off when that `error` arrives. A stream already
 * destroyed before the write emits no `error` for it, so there the listener
 * goes with the callback.
 */
export const drained = (streams = [process.stdout, process.stderr]) =>
  Promise.all(
    streams.map(
      (stream) =>
        new Promise((resolve) => {
          const onError = () => resolve();
          const live = !stream.destroyed;
          withRoomFor(stream, "error", () => stream.once("error", onError));
          stream.write("", (err) => {
            if (!err || !live) stream.removeListener("error", onError);
            resolve();
          });
        }),
    ),
  );

/**
 * Run `add`, which adds one `event` listener to `emitter`, with the limit
 * raised just enough not to warn. The limit is put back as it was found, as
 * Node's own pipe puts it back: a stream with no limit of its own, such as
 * process.stdout, goes on following `EventEmitter.defaultMaxListeners` rather
 * than being pinned at its value.
 */
function withRoomFor(emitter, event, add) {
  const max = emitter.getMaxListeners();
  const needed = emitter.listenerCount(event) + 1;
  // 0 means no limit; Infinity, or a limit already high enough, needs nothing.
  if (max === 0 || max >= needed) return add();
  const own = emitter._maxListeners;   // undefined: none of its own
  emitter.setMaxListeners(needed);
  try {
    return add();
  } finally {
    emitter._maxListeners = own;
  }
}
