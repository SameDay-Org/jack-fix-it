export type AccentParts = { before: string; accent: string; after: string };

/**
 * Splits a headline at its `<accent>word</accent>` marker (the same marker the app's strings
 * use), so the page can color the word. A string without the marker is all `before`.
 */
export function accentParts(text: string): AccentParts {
  const match = /^([\s\S]*?)<accent>([\s\S]*?)<\/accent>([\s\S]*)$/.exec(text);
  if (!match) return { before: text, accent: "", after: "" };
  return { before: match[1], accent: match[2], after: match[3] };
}
