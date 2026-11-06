export type SourceFile = { name: string; text: string };
export type SourceChunk = { id: string; name: string; text: string; pageContext?: string };

// Bound every request, including a single very long paragraph. Never discard a tail.
export function splitSources(files: SourceFile[], maxChars = 60000): SourceChunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 100) throw new Error('Limite de parte inválido.');
  const result: SourceChunk[] = [];
  files.forEach((file, fileIndex) => {
    if (!file.text.trim()) throw new Error(`O arquivo ${file.name} não contém texto legível.`);
    let start = 0;
    let part = 1;
    while (start < file.text.length) {
      let end = Math.min(start + maxChars, file.text.length);
      if (end < file.text.length) {
        const boundary = file.text.lastIndexOf('\n', end);
        if (boundary > start + maxChars / 2) end = boundary + 1;
      }
      const markerStart = file.text.lastIndexOf('[ARQUIVO:', start);
      const markerEnd = markerStart >= 0 ? file.text.indexOf('\n', markerStart) : -1;
      const pageContext = markerEnd >= 0 && markerEnd < start ? file.text.slice(markerStart, markerEnd) : undefined;
      result.push({ id: `F${fileIndex + 1}P${part++}`, name: file.name, text: file.text.slice(start, end), pageContext });
      start = end;
    }
  });
  return result;
}

export function sourceText(chunks: SourceChunk[]): string {
  return chunks.map(c => `--- FONTE ${c.id}: ${c.name} ---\n${c.pageContext ? `Continuação da página: ${c.pageContext}\n` : ''}${c.text}`).join('\n\n');
}

export function validateLiteralQuotes(text: string, sources: SourceChunk[]): void {
  const normalize = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
  const originals = normalize(sources.map(s => s.text).join('\n'));
  // Every italicized quoted passage must be present in the original extracted text.
  for (const match of text.matchAll(/\*+["“]([^"”]+)["”]\*+/g)) {
    if (!originals.includes(normalize(match[1]))) {
      throw new Error('Uma transcrição entre aspas e em itálico não foi localizada literalmente nas fontes. A minuta precisa ser revista; ela não foi salva.');
    }
  }
}
