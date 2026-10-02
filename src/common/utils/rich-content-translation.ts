export interface DocumentTemplate {
  type: 'doc';
  content: any[];
}

export interface ExtractedTranslationData {
  segments: Record<string, string>;
  template: DocumentTemplate | null;
}

/**
 * Extracts translatable text segments from a Tiptap JSON document while preserving
 * math equations (LaTeX), images, formatting marks, and document layout.
 */
export function extractTranslatableSegments(docOrText: any): ExtractedTranslationData {
  if (!docOrText) {
    return { segments: {}, template: null };
  }

  let doc = docOrText;
  if (typeof doc === 'string') {
    try {
      const parsed = JSON.parse(doc);
      if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
        doc = parsed;
      } else {
        // Plain string fallback
        return {
          segments: { text_0: doc },
          template: null,
        };
      }
    } catch {
      return {
        segments: { text_0: doc },
        template: null,
      };
    }
  }

  if (typeof doc !== 'object' || doc.type !== 'doc' || !Array.isArray(doc.content)) {
    return { segments: {}, template: null };
  }

  const segments: Record<string, string> = {};
  let segmentCounter = 0;

  const processNode = (node: any, path: string): any => {
    if (!node) return null;

    if (node.type === 'text' && typeof node.text === 'string' && node.text.trim().length > 0) {
      const segId = `seg_${segmentCounter++}`;
      segments[segId] = node.text;
      return {
        ...node,
        text: `{{${segId}}}`,
      };
    }

    // Preserve math and images untouched
    if (node.type === 'inlineMath' || node.type === 'blockMath' || node.type === 'image') {
      return { ...node };
    }

    // Recursively process child nodes
    if (node.content && Array.isArray(node.content)) {
      return {
        ...node,
        content: node.content.map((child: any, idx: number) =>
          processNode(child, `${path}.${idx}`),
        ),
      };
    }

    return { ...node };
  };

  const template: DocumentTemplate = {
    type: 'doc',
    content: doc.content.map((child: any, idx: number) => processNode(child, `${idx}`)),
  };

  return { segments, template };
}

/**
 * Reconstructs the translated Tiptap document by replacing segment placeholders with translated text.
 */
export function reconstructTranslatedDocument(
  template: DocumentTemplate | null,
  translatedSegments: Record<string, string>,
  fallbackPlainText?: string,
): any {
  if (!template) {
    // If no template was created (legacy plain text), return translated text or join segments
    if (translatedSegments && Object.keys(translatedSegments).length > 0) {
      return Object.values(translatedSegments).join(' ');
    }
    return fallbackPlainText || '';
  }

  const replaceInNode = (node: any): any => {
    if (!node) return null;

    if (node.type === 'text' && typeof node.text === 'string') {
      let replacedText = node.text;
      for (const [segId, translatedText] of Object.entries(translatedSegments)) {
        const placeholder = `{{${segId}}}`;
        if (replacedText.includes(placeholder)) {
          replacedText = replacedText.replace(placeholder, translatedText || '');
        }
      }
      return {
        ...node,
        text: replacedText,
      };
    }

    if (node.content && Array.isArray(node.content)) {
      return {
        ...node,
        content: node.content.map(replaceInNode),
      };
    }

    return { ...node };
  };

  return {
    type: 'doc',
    content: template.content.map(replaceInNode),
  };
}
