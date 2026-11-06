import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { candidateModels, assertCompleteResponse, errorStatus } from './lib/geminiPolicy';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to determine if an error is transient (e.g. 503 UNAVAILABLE, 429 rate limit, network timeout)
function isTransientError(err: any): boolean {
  if (!err) return false;
  const status = err.status || err.code || err.statusCode;
  if (status === 503 || status === 429 || status === 500 || status === 502 || status === 504) {
    return true;
  }
  const str = (typeof err === 'string' ? err : (err.message || JSON.stringify(err))).toLowerCase();
  return (
    str.includes('503') ||
    str.includes('unavailable') ||
    str.includes('high demand') ||
    str.includes('429') ||
    str.includes('resource_exhausted') ||
    str.includes('rate limit') ||
    str.includes('quota') ||
    str.includes('econnreset') ||
    str.includes('etimedout') ||
    str.includes('fetch failed') ||
    str.includes('overloaded')
  );
}

// Recursively unpacks nested JSON error strings from Google GenAI SDK
function extractCleanErrorMessage(err: any): string {
  if (!err) return 'Erro desconhecido na comunicação com a IA.';

  let currentMsg = typeof err === 'string' ? err : (err.message || String(err));

  // Try parsing nested JSON up to 3 times
  for (let i = 0; i < 3; i++) {
    try {
      const trimmed = currentMsg.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        const parsed = JSON.parse(trimmed);
        if (parsed.error?.message) {
          currentMsg = parsed.error.message;
        } else if (parsed.message) {
          currentMsg = parsed.message;
        } else if (typeof parsed.error === 'string') {
          currentMsg = parsed.error;
        } else {
          break;
        }
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  // Provide user-friendly Portuguese translations for well-known Google API errors
  const lower = currentMsg.toLowerCase();
  if (lower.includes('503') || lower.includes('high demand') || lower.includes('unavailable')) {
    return 'O modelo de inteligência artificial do Google está com alta demanda temporária (Erro 503 - Capacidade em pico). Por favor, aguarde alguns segundos e tente novamente.';
  }
  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return 'Limite temporário de requisições por minuto atingido (Erro 429). Por favor, aguarde um momento e tente novamente.';
  }

  return currentMsg;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Support large document analysis payloads
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ extended: true, limit: '100mb' }));

  const apiKey = process.env.GEMINI_API_KEY || '';
  const ai = apiKey ? new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  }) : null;

  const modelLimits = new Map<string, number>();
  async function checkContext(model: string, contents: any, systemInstruction?: string) {
    if (!modelLimits.has(model)) {
      const metadata = await ai.models.get({ model });
      modelLimits.set(model, metadata.inputTokenLimit || 1000000);
    }
    const count = await ai.models.countTokens({ model, contents, config: { systemInstruction } });
    if (typeof count.totalTokens !== 'number') throw new Error('Não foi possível verificar o tamanho dos autos. Tente novamente.');
    if (count.totalTokens > modelLimits.get(model)! - 32768) {
      const error = new Error('Esta etapa excede o contexto do modelo. Divida a matéria ou os documentos; nenhum trecho foi cortado automaticamente.');
      (error as any).status = 413;
      throw error;
    }
  }

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', hasApiKey: !!process.env.GEMINI_API_KEY });
  });

  // Generate content (non-streaming, structured JSON or text)
  app.post('/api/gemini/generate', async (req, res) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(400).json({
          error: 'Chave do Gemini (GEMINI_API_KEY) ausente ou não configurada no servidor. Configure-a no painel Settings > Secrets.',
        });
      }

      const { contents, systemInstruction, temperature, responseMimeType, model } = req.body;
      const initialModel = model || process.env.GEMINI_MODEL;

      // Build model priority queue starting with requested model, followed by the rest of the cascade
      const models = candidateModels(initialModel, process.env.GEMINI_MODEL, process.env.GEMINI_FALLBACK_MODELS);

      let lastError: any = null;
      let responseText = '';

      modelLoop: for (const candidateModel of models) {
        // Retry each model up to 2 times on transient errors with backoff
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            console.log(`[Gemini Generate] Requesting model: ${candidateModel} (attempt ${attempt})`);
            await checkContext(candidateModel, contents, systemInstruction);
            const response = await ai.models.generateContent({
              model: candidateModel,
              contents,
              config: {
                systemInstruction,
                temperature: temperature ?? 0.1,
                responseMimeType,
                maxOutputTokens: 32768,
              },
            });
            assertCompleteResponse(response, true);
            responseText = response.text || '';
            if (!responseText.trim()) throw new Error('A IA não retornou texto. A etapa não foi concluída.');
            lastError = null;
            break modelLoop; // Success!
          } catch (err: any) {
            lastError = err;
            console.warn(`[Gemini Generate] Model ${candidateModel} attempt ${attempt} failed:`, err?.message || err);
            if (!isTransientError(err) && errorStatus(err) !== 404) {
              return res.status(errorStatus(err)).json({ error: extractCleanErrorMessage(err) });
            }
            if (isTransientError(err) && attempt < 2) {
              const backoff = 1000 * attempt + Math.floor(Math.random() * 500);
              console.log(`[Gemini Generate] Retrying ${candidateModel} in ${backoff}ms...`);
              await sleep(backoff);
            } else {
              // Move to next candidate model
              break;
            }
          }
        }
      }

      if (lastError && !responseText) {
        const cleanMsg = extractCleanErrorMessage(lastError);
        return res.status(errorStatus(lastError)).json({ error: cleanMsg });
      }

      res.json({ text: responseText });
    } catch (error: any) {
      console.error('Error in /api/gemini/generate:', error);
      const cleanMsg = extractCleanErrorMessage(error);
      res.status(500).json({ error: cleanMsg });
    }
  });

  // Streaming endpoint for drafts and analyses with resilient fallback
  app.post('/api/gemini/stream', async (req, res) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(400).json({
          error: 'Chave do Gemini (GEMINI_API_KEY) ausente ou não configurada no servidor. Configure-a no painel Settings > Secrets.',
        });
      }

      const { contents, systemInstruction, temperature, model } = req.body;
      const initialModel = model || process.env.GEMINI_MODEL;

      // Build model priority queue starting with requested model
      const models = candidateModels(initialModel, process.env.GEMINI_MODEL, process.env.GEMINI_FALLBACK_MODELS);

      let streamIterator: AsyncIterator<any> | null = null;
      let firstChunk: any = null;
      let lastError: any = null;

      // Find a working model and fetch the first chunk BEFORE sending SSE headers to the client
      modelLoop: for (const candidateModel of models) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            console.log(`[Gemini Stream] Attempting model: ${candidateModel} (attempt ${attempt})`);
            await checkContext(candidateModel, contents, systemInstruction);
            const streamResponse = await ai.models.generateContentStream({
              model: candidateModel,
              contents,
              config: {
                systemInstruction,
                temperature: temperature ?? 0.1,
                maxOutputTokens: 32768,
              },
            });

            // Peak the first chunk to ensure stream connection is healthy and not 503
            const iterator = streamResponse[Symbol.asyncIterator]();
            const firstResult = await iterator.next();
            
            streamIterator = iterator;
            firstChunk = firstResult;
            lastError = null;
            console.log(`[Gemini Stream] Model ${candidateModel} connected successfully.`);
            break modelLoop; // Model is working!
          } catch (err: any) {
            lastError = err;
            console.warn(`[Gemini Stream] Model ${candidateModel} attempt ${attempt} failed:`, err?.message || err);
            if (!isTransientError(err) && errorStatus(err) !== 404) {
              return res.status(errorStatus(err)).json({ error: extractCleanErrorMessage(err) });
            }
            if (isTransientError(err) && attempt < 2) {
              const backoff = 1000 * attempt + Math.floor(Math.random() * 500);
              console.log(`[Gemini Stream] Retrying ${candidateModel} in ${backoff}ms...`);
              await sleep(backoff);
            } else {
              break; // Try next model in candidateModels
            }
          }
        }
      }

      // If all candidate models failed before stream started, return standard JSON error
      if (!streamIterator || !firstChunk) {
        const cleanMsg = extractCleanErrorMessage(lastError);
        return res.status(errorStatus(lastError)).json({ error: cleanMsg });
      }

      // Headers are only sent now that we verified stream works!
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      let emittedText = false;
      let lastFinishReason: string | undefined;
      // Emit the first chunk if present
      if (!firstChunk.done) {
        assertCompleteResponse(firstChunk.value);
        lastFinishReason = firstChunk.value?.candidates?.[0]?.finishReason;
      }
      if (!firstChunk.done && firstChunk.value?.text) {
        emittedText = true;
        res.write(`data: ${JSON.stringify({ text: firstChunk.value.text })}\n\n`);
      }

      // Continue reading remaining chunks
      if (!firstChunk.done) {
        while (true) {
          const { done, value } = await streamIterator.next();
          if (done) break;
          assertCompleteResponse(value);
          lastFinishReason = value?.candidates?.[0]?.finishReason || lastFinishReason;
          if (value?.text) {
            emittedText = true;
            res.write(`data: ${JSON.stringify({ text: value.text })}\n\n`);
          }
        }
      }

      if (!emittedText || lastFinishReason !== 'STOP') throw new Error('A IA não concluiu a resposta. O texto parcial não foi salvo como concluído.');
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error: any) {
      console.error('Error during streaming in /api/gemini/stream:', error);
      const cleanMsg = extractCleanErrorMessage(error);
      if (!res.headersSent) {
        res.status(503).json({ error: cleanMsg });
      } else {
        res.write(`data: ${JSON.stringify({ error: cleanMsg })}\n\n`);
        res.end();
      }
    }
  });

  // Vite integration
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

