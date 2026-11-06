export const DEFAULT_MODEL = 'gemini-3.1-pro-preview';

// Only operator-configured fallbacks; never silently downgrade a legal draft to Lite.
export function candidateModels(requested?: string, configured?: string, fallback = ''): string[] {
  return [...new Set([requested || configured || DEFAULT_MODEL, ...fallback.split(',')].map(s => s.trim()).filter(Boolean))];
}

export function assertCompleteResponse(response: any, final = false): void {
  const reason = response.candidates?.[0]?.finishReason;
  if (reason && reason !== 'STOP') {
    throw new Error(reason === 'MAX_TOKENS'
      ? 'A resposta atingiu o limite de saída da IA. A etapa foi interrompida; não será tratada como completa.'
      : `A IA interrompeu a resposta (${reason}). A etapa não foi concluída.`);
  }
  if (final && reason !== 'STOP') throw new Error('A IA não confirmou a conclusão da resposta. A etapa não foi concluída.');
  if (response.promptFeedback?.blockReason) throw new Error('A IA bloqueou esta solicitação. Nenhuma análise completa foi produzida.');
}

export function errorStatus(error: any): number {
  const value = Number(error?.status || error?.statusCode || error?.code);
  return [400, 401, 403, 404, 413, 429, 500, 502, 503, 504].includes(value) ? value : 503;
}
