// Recognize SSE line boundaries without revisiting an accumulated prefix.
// A CR ends a line immediately; a following LF belongs to that same ending,
// even when it arrives in another chunk. Consumers retain raw ending bytes
// independently of their content, UTF-8, terminal and size policies.
export class SseLineScanner {
  #skipLf = false;

  *scan(chunk) {
    const isText = typeof chunk === "string";
    const cr = isText ? "\r" : 13;
    const lf = isText ? "\n" : 10;
    const slice = (start, end) => chunk.slice(start, end);
    let start = 0;
    if (this.#skipLf && chunk.length) {
      this.#skipLf = false;
      if (chunk[0] === lf) {
        yield { content: slice(0, 0), ending: slice(0, 1), endLine: false };
        start = 1;
      }
    }
    let nextCr = chunk.indexOf(cr, start);
    let nextLf = chunk.indexOf(lf, start);
    while (nextCr !== -1 || nextLf !== -1) {
      const index = nextCr === -1 ? nextLf : nextLf === -1 ? nextCr : Math.min(nextCr, nextLf);
      let end = index + 1;
      if (index === nextCr) {
        if (nextLf === end) end += 1;
        else if (end === chunk.length) this.#skipLf = true;
      }
      yield { content: slice(start, index), ending: slice(index, end), endLine: true };
      start = end;
      // Cache both next positions. Searching for an absent CR again after
      // every LF would rescan a long LF-only chunk quadratically.
      if (nextCr !== -1 && nextCr < start) nextCr = chunk.indexOf(cr, start);
      if (nextLf !== -1 && nextLf < start) nextLf = chunk.indexOf(lf, start);
    }
    if (start < chunk.length) {
      yield { content: slice(start), ending: slice(0, 0), endLine: false };
    }
  }
}

// Holding consumers need complete raw frames as well as incremental framing.
// Geometric parts cap fragment bookkeeping; captured bytes are copied once
// and assembled once. Bounds and final-EOF policy belong to each consumer.
export class SseFrameBuffer {
  #lines = new SseLineScanner();
  #parts = [];
  #tailBytes = 0;
  #nextPartBytes = 1024;
  #pendingBytes = 0;
  #lineHasContent = false;
  #atStreamStart = true;

  get pendingBytes() { return this.#pendingBytes; }
  get atStreamStart() { return this.#atStreamStart; }

  *write(chunk) {
    let capturedUntil = 0;
    for (const { content, ending, endLine } of this.#lines.scan(chunk)) {
      const end = (ending.length ? ending.byteOffset + ending.length
        : content.byteOffset + content.length) - chunk.byteOffset;
      // Complete bare-CR events immediately. If the CR was really the first
      // half of a split CRLF, attach its remaining raw byte to that frame's
      // emission/hold instead of treating it as an unfinished next event.
      if (!endLine && !content.length && ending.length && !this.#pendingBytes) {
        capturedUntil = end;
        yield { bytes: ending, atStreamStart: false, continuation: true };
        continue;
      }
      if (content.length) this.#lineHasContent = true;
      if (!endLine) continue;
      const blank = !this.#lineHasContent;
      this.#lineHasContent = false;
      if (blank) {
        const atStreamStart = this.#atStreamStart;
        this.#atStreamStart = false;
        let bytes;
        if (this.#pendingBytes) {
          this.#append(chunk.subarray(capturedUntil, end));
          bytes = this.take();
        } else {
          // A complete frame in this chunk needs no staging copy. Only an
          // unfinished suffix is captured across transform callbacks.
          bytes = chunk.subarray(capturedUntil, end);
        }
        capturedUntil = end;
        yield { bytes, atStreamStart, continuation: false };
      }
    }
    if (capturedUntil < chunk.length) this.#append(chunk.subarray(capturedUntil));
  }

  take() {
    const parts = this.#parts.map((part, index) => index === this.#parts.length - 1
      ? part.subarray(0, this.#tailBytes) : part);
    const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, this.#pendingBytes);
    this.#parts = [];
    this.#tailBytes = 0;
    this.#nextPartBytes = 1024;
    this.#pendingBytes = 0;
    return bytes;
  }

  #append(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      let tail = this.#parts.at(-1);
      if (!tail || this.#tailBytes === tail.length) {
        tail = Buffer.allocUnsafe(this.#nextPartBytes);
        this.#nextPartBytes = Math.min(64 * 1024, this.#nextPartBytes * 2);
        this.#parts.push(tail);
        this.#tailBytes = 0;
      }
      const count = Math.min(tail.length - this.#tailBytes, bytes.length - offset);
      bytes.copy(tail, this.#tailBytes, offset, offset + count);
      this.#tailBytes += count;
      this.#pendingBytes += count;
      offset += count;
    }
  }
}

export function sseFrameText(bytes, atStreamStart) {
  const text = bytes.toString("utf8");
  return atStreamStart && text.startsWith("\uFEFF") ? text.slice(1) : text;
}
