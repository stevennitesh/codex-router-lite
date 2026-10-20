// Shared DOM values only; browser operations and runtime orchestration stay in
// their respective test harnesses.
export const messageId = index => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
export const domText = value => ({ nodeType: 3, textContent: value });

export function domElement(tag, attributes = {}, ...children) {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), childNodes: children, children: children.filter(child => child.nodeType === 1),
    getAttribute: name => attributes[name] ?? null,
    setAttribute: (name, value) => { attributes[name] = value; },
    matches(selector) {
      return selector.split(/\s*,\s*/u).some(part => {
        const parts = part.trim().split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/u);
        if (parts.length > 1) {
          const last = parts.pop();
          return this.matches(last) && Boolean(this.parentElement?.closest(parts.join(" ")));
        }
        const requiredTag = part.match(/^[A-Za-z][A-Za-z0-9-]*/u)?.[0];
        const requiredAttributes = Array.from(part.matchAll(/\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/gu));
        return Boolean(requiredTag || requiredAttributes.length) && (!requiredTag || requiredTag.toUpperCase() === this.tagName)
          && requiredAttributes.every(match => match[2] === undefined ? attributes[match[1]] !== undefined
            : match[2] === "^=" ? attributes[match[1]]?.startsWith(match[3]) : attributes[match[1]] === match[3]);
      });
    },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; },
    classList: { contains: name => (attributes.class ?? "").split(/\s+/).includes(name) },
    get textContent() { return this.childNodes.map(child => child.textContent).join(""); },
    querySelectorAll(selector) {
      const found = [];
      const visit = candidate => {
        if (candidate.nodeType !== 1) return;
        if (selector === "code" ? candidate.tagName === "CODE"
          : selector === ".cm-content[data-language]" ? candidate.classList.contains("cm-content") && candidate.getAttribute("data-language") !== null
            : candidate.matches(selector)) found.push(candidate);
        candidate.childNodes.forEach(visit);
      };
      this.childNodes.forEach(visit);
      return found;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; } };
  for (const child of node.children) child.parentElement = node;
  return node;
}

export function replyElement(value, id, attributes = {}) {
  const element = typeof value === "string"
    ? domElement("div", { "data-markdown-text-style": "assistant-message", ...attributes }, domText(value)) : value;
  domElement("div", { "data-chatgpt-selection-message-id": id }, element);
  return element;
}
