"use strict";

/**
 * Shorten `text` to at most `max` characters, cutting at a word boundary
 * when possible and appending an ellipsis.
 */
function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "...";
}

module.exports = { truncate };
