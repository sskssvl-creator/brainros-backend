export const ALLOWED_NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'image',
  'inlineMath',
  'blockMath',
  'hardBreak',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
]);

export const ALLOWED_MARKS = new Set([
  'bold',
  'italic',
  'underline',
  'strike',
  'subscript',
  'superscript',
  'code',
]);

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export function validateRichContent(doc: any): ValidationResult {
  const errors: string[] = [];

  if (!doc) {
    return { isValid: true, errors: [] };
  }

  // If string, test if it's JSON or plaintext
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      // Plain text is considered valid
      return { isValid: true, errors: [] };
    }
  }

  if (typeof doc !== 'object' || doc === null) {
    return { isValid: false, errors: ['Content must be an object or string'] };
  }

  if (doc.type !== 'doc') {
    return { isValid: false, errors: ['Root node type must be "doc"'] };
  }

  if (!Array.isArray(doc.content)) {
    return { isValid: false, errors: ['Document content must be an array'] };
  }

  function validateNode(node: any, path: string) {
    if (!node || typeof node !== 'object') {
      errors.push(`Invalid node at ${path}`);
      return;
    }

    if (!node.type || !ALLOWED_NODE_TYPES.has(node.type)) {
      errors.push(`Disallowed or unknown node type "${node.type}" at ${path}`);
      return;
    }

    // Validate marks if present
    if (node.marks) {
      if (!Array.isArray(node.marks)) {
        errors.push(`Marks at ${path} must be an array`);
      } else {
        node.marks.forEach((mark: any, mIdx: number) => {
          if (!mark || typeof mark !== 'object' || !ALLOWED_MARKS.has(mark.type)) {
            errors.push(`Disallowed mark "${mark?.type}" at ${path}.marks[${mIdx}]`);
          }
        });
      }
    }

    // Validate math nodes
    if (node.type === 'inlineMath' || node.type === 'blockMath') {
      const latex = node.attrs?.latex;
      if (typeof latex !== 'string') {
        errors.push(`Math node at ${path} must have a string latex attribute`);
      } else if (latex.length > 5000) {
        errors.push(`LaTeX expression at ${path} exceeds 5000 characters limit`);
      }
    }

    // Validate image nodes
    if (node.type === 'image') {
      const src = node.attrs?.src;
      if (!src || typeof src !== 'string') {
        errors.push(`Image node at ${path} missing src attribute`);
      } else if (
        !src.startsWith('http://') &&
        !src.startsWith('https://') &&
        !src.startsWith('data:image/')
      ) {
        errors.push(`Image src at ${path} must be a valid HTTP(S) URL or data URI`);
      }
    }

    // Recursively validate child nodes
    if (node.content) {
      if (!Array.isArray(node.content)) {
        errors.push(`Node content at ${path} must be an array`);
      } else {
        node.content.forEach((child: any, cIdx: number) => {
          validateNode(child, `${path}.content[${cIdx}]`);
        });
      }
    }
  }

  doc.content.forEach((child: any, idx: number) => {
    validateNode(child, `doc.content[${idx}]`);
  });

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export function extractImagesFromDoc(doc: any): any[] {
  if (!doc) return [];
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return [];
    }
  }
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return [];
  const images: any[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (node.type === 'image') {
      images.push(node);
    }
    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
    }
  };
  doc.content.forEach(walk);
  return images;
}

export function buildTranslatedRichDoc(baseDoc: any, translatedText?: string | null): any {
  const images = extractImagesFromDoc(baseDoc);
  if (!translatedText && images.length === 0) return null;

  const cleanedText = (translatedText || '')
    .replace(/\[Image(?::\s*[^\]]*)?\]/gi, '')
    .trim();

  if (images.length === 0) {
    if (!cleanedText) return null;
    const paragraphs = cleanedText.split(/\r?\n/);
    return {
      type: 'doc',
      content: paragraphs.map((p) => ({
        type: 'paragraph',
        content: p ? [{ type: 'text', text: p }] : [],
      })),
    };
  }

  const contentNodes: any[] = [];
  if (cleanedText) {
    const paragraphs = cleanedText.split(/\r?\n/);
    paragraphs.forEach((p) => {
      if (p.trim()) {
        contentNodes.push({
          type: 'paragraph',
          content: [{ type: 'text', text: p }],
        });
      }
    });
  }

  images.forEach((img) => {
    contentNodes.push(img);
  });

  if (contentNodes.length === 0) {
    return null;
  }

  return {
    type: 'doc',
    content: contentNodes,
  };
}

