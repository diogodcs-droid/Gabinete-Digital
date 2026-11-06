// SSE may split a UTF-8 character, JSON object or final marker across network reads.
export async function readGeminiStream(body: ReadableStream<Uint8Array>, onText?: (text: string) => void): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let completed = false;
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { completed = true; return; }
    if (!data) return;
    const parsed = JSON.parse(data);
    if (parsed.error) throw new Error(parsed.error);
    if (typeof parsed.text === 'string') { text += parsed.text; onText?.(text); }
  };
  try {
    while (!completed) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consume(line.replace(/\r$/, ''));
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer.trim());
    if (!completed) throw new Error('A conexão foi interrompida antes de concluir a resposta. O texto parcial não foi salvo como concluído.');
    if (!text.trim()) throw new Error('A IA concluiu sem retornar texto. Tente novamente.');
    return text;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
