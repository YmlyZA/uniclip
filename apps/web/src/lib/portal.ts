/**
 * Svelte action that relocates an element to document.body. A modal nested
 * inside a positioned/filtered ancestor (a `sticky` rail, a `backdrop-blur`
 * bar) is trapped in that ancestor's stacking context, so its z-index is only
 * compared against the ancestor's siblings — not the whole page. Teleporting it
 * to body puts it back at the document-root stacking context, where `z-50`
 * actually sits above everything. Svelte still owns the node (bindings/events
 * keep working); destroy removes it when the modal unmounts.
 */
export function portal(node: HTMLElement) {
  if (typeof document === "undefined") return; // no-op under SSR/prerender
  document.body.appendChild(node);
  return {
    destroy() {
      node.parentNode?.removeChild(node);
    },
  };
}
