export function extractPlainText(docOrText: any): string {
  if (!docOrText) return '';
  if (typeof docOrText === 'string') {
    try {
      const parsed = JSON.parse(docOrText);
      if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
        return extractPlainText(parsed);
      }
    } catch {
      return docOrText;
    }
    return docOrText;
  }

  if (typeof docOrText !== 'object' || docOrText.type !== 'doc' || !Array.isArray(docOrText.content)) {
    return '';
  }

  const walk = (node: any): string => {
    if (!node) return '';
    if (node.type === 'text' && node.text) {
      return node.text;
    }
    if (node.type === 'inlineMath' && node.attrs?.latex) {
      return `$${node.attrs.latex}$`;
    }
    if (node.type === 'blockMath' && node.attrs?.latex) {
      return `$$${node.attrs.latex}$$`;
    }
    if (node.type === 'image') {
      return node.attrs?.alt ? `[Image: ${node.attrs.alt}]` : '[Image]';
    }
    if (node.content && Array.isArray(node.content)) {
      const inner = node.content.map(walk).join('');
      if (
        node.type === 'paragraph' ||
        node.type === 'heading' ||
        node.type === 'listItem'
      ) {
        return inner + '\n';
      }
      return inner;
    }
    return '';
  };

  return docOrText.content.map(walk).join('').trim();
}
