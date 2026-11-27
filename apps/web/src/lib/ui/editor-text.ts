// Keeping the editor's text byte for byte. CodeMirror splits a document into
// lines on any of \r\n, \r and \n and joins them back with one separator, which
// would silently rewrite line endings. Choosing the separator from the text
// avoids that: a note that uses CRLF throughout keeps CRLF (and new lines get
// CRLF too); anything else uses \n, and a stray \r stays in the text as an
// ordinary character instead of being turned into a line break.

import { EditorState, type Extension } from '@codemirror/state';

/** The line separator that reproduces `text` exactly. */
export function lineSeparatorFor(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return '\n';
  const lf = (text.match(/\n/g) ?? []).length;
  const cr = (text.match(/\r/g) ?? []).length;
  return crlf === lf && crlf === cr ? '\r\n' : '\n';
}

/** The CodeMirror facet that keeps `text`'s line endings. */
export function lineSeparatorExtension(text: string): Extension {
  return EditorState.lineSeparator.of(lineSeparatorFor(text));
}

/** An editor state for `text` whose `stateText` is `text` exactly. */
export function exactState(text: string, extensions: Extension[] = []): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [lineSeparatorExtension(text), ...extensions],
  });
}

/** The editor's text exactly, joined with the state's own line separator (`doc.toString()` always uses \n). */
export function stateText(state: EditorState): string {
  return state.sliceDoc();
}
