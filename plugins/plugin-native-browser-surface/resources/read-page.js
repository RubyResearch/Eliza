/** Reads visible page text through a bundled native operation, not caller-supplied JavaScript. Native hosts wrap this function before invoking it with a CSS selector; page text remains untrusted data. */
function readPage(selector) {
  try {
    if (document.readyState === "loading") {
      return { error: "The native page is still loading." };
    }
    const root = document.querySelector(selector || "body");
    if (!root) return { error: "No element matches the requested selector." };
    const excluded =
      "script,style,template,noscript,input,textarea,select,[hidden],[aria-hidden=true]";
    const visible = (element) => {
      if (element.closest(excluded)) return false;
      for (
        let ancestor = element;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.opacity === "0"
        )
          return false;
      }
      return element.getClientRects().length > 0;
    };
    if (!visible(root))
      return {
        error: "The requested element is not readable visible page text.",
      };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement || !visible(node.parentElement)) continue;
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (!text) continue;
      parts.push(text);
    }
    return {
      url: location.href,
      title: document.title,
      text: parts.join("\n"),
      truncated: false,
    };
  } catch (error) {
    // error-policy:J1 Native transport reports an explicit read failure, never partial text.
    return {
      error:
        error instanceof Error ? error.message : "Native page read failed.",
    };
  }
}
