import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSources, validateLiteralQuotes } from '../lib/caseSources';
import { extractCase, draftInChapters, validatePlan, validateExtraction } from '../lib/legalWorkflow';
import { candidateModels, assertCompleteResponse } from '../lib/geminiPolicy';
import { readGeminiStream } from '../lib/geminiClient';

test('splitting preserves every character, including long paragraphs and more than five parts', () => {
  const text = 'Primeira linha\n' + 'á'.repeat(999) + '\nÚltimo pedido';
  const chunks = splitSources([{ name: 'autos.pdf', text }], 100);
  assert.ok(chunks.length > 5);
  assert.equal(chunks.map(c => c.text).join(''), text);
  assert.ok(chunks.every(c => c.text.length <= 100));
});

const validExtraction = JSON.stringify(Object.fromEntries([...['numero_processo', 'reclamante', 'reclamada', 'vt', 'materia_principal', 'alegacoes_inicial', 'pedidos_inicial', 'alegacoes_contestacao', 'pedidos_contestacao', 'provas_produzidas'].map(key => [key, '']), ['jurisprudencia', {trt4: '', tst: '', stf: ''}], ['prazos_processuais', []]]));

test('invalid extraction cannot masquerade as an analyzed case', () => {
  assert.throws(() => validateExtraction({}), /estrutura inválida/);
});

test('extraction processes the sixth file and aborts if any part fails', async () => {
  const files = Array.from({ length: 6 }, (_, i) => ({ name: `${i}.pdf`, text: `Pedido ${i}` }));
  let requests = 0;
  await extractCase(files, async () => { requests++; return validExtraction; }, JSON.parse, () => {});
  assert.equal(requests, 7); // all six sources plus consolidation
  requests = 0;
  await assert.rejects(() => extractCase(files, async () => {
    if (++requests === 3) throw new Error('Falha na parte 3');
    return validExtraction;
  }, JSON.parse, () => {}), /parte 3/);
  assert.equal(requests, 3);
});

test('a chapter plan cannot invent a source or omit any part', () => {
  const chunks = splitSources([{ name: 'a', text: 'a' }, { name: 'b', text: 'b' }]);
  const chapter = { title: 'TEMA', scope: 'Analisar prova', sources: ['F1P1'] };
  assert.throws(() => validatePlan({ chapters: [chapter, chapter, chapter] }, chunks), /sem vinculação/);
  assert.throws(() => validatePlan({ chapters: [chapter, chapter, { ...chapter, sources: ['F9P1'] }] }, chunks), /inválidas/);
});

test('literal witness quotations preserve errors and reject paraphrases', () => {
  const chunks = splitSources([{ name: 'ata', text: 'que nois chegava cedo\n e saia tarde' }]);
  assert.doesNotThrow(() => validateLiteralQuotes('*"que nois chegava cedo e saia tarde"*', chunks));
  assert.throws(() => validateLiteralQuotes('*"que nós chegávamos cedo"*', chunks), /literalmente/);
});

function stream(data: string, cut = 1) {
  const bytes = new TextEncoder().encode(data);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += cut) controller.enqueue(bytes.slice(i, i + cut));
    controller.close();
  } });
}

test('SSE preserves accented characters and a final marker split across reads', async () => {
  assert.equal(await readGeminiStream(stream('data: {"text":"sentença e perícia"}\n\ndata: [DONE]')), 'sentença e perícia');
});

test('SSE rejects interrupted, invalid, empty or failed responses', async () => {
  await assert.rejects(() => readGeminiStream(stream('data: {"text":"parcial"}\n\n')), /interrompida/);
  await assert.rejects(() => readGeminiStream(stream('data: {bad}\n\n')), SyntaxError);
  await assert.rejects(() => readGeminiStream(stream('data: [DONE]\n\n')), /sem retornar texto/);
  await assert.rejects(() => readGeminiStream(stream('data: {"error":"MAX_TOKENS"}\n\n')), /MAX_TOKENS/);
});

test('no automatic model downgrade and no successful truncated response', () => {
  assert.deepEqual(candidateModels(), ['gemini-3.1-pro-preview']);
  assert.deepEqual(candidateModels('pro', undefined, 'pro, backup'), ['pro', 'backup']);
  assert.throws(() => assertCompleteResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), /limite/);
  assert.throws(() => assertCompleteResponse({ promptFeedback: { blockReason: 'SAFETY' } }), /bloqueou/);
});

test('drafting uses original sources per chapter and audits before completion', async () => {
  let calls = 0;
  const chapters = ['RELATÓRIO', 'JORNADA', 'DISPOSITIVO'].map(title => ({ title, scope: 'Confrontar pedido e defesa', sources: ['F1P1'] }));
  const result = await draftInChapters({
    files: [{ name: 'autos.pdf', text: 'Prova literal do processo' }], instructions: 'Analisar jornada', systemInstruction: '',
    parse: JSON.parse, progress: () => {}, onDraft: () => {},
    generate: async options => {
      calls++;
      if (calls === 1) return 'Inventário';
      if (calls === 2) return JSON.stringify({ chapters });
      if (calls === 6) return '{"complete":true,"issues":[]}';
      assert.match(options.contents, /Prova literal do processo/);
      return `Capítulo ${calls - 2}`;
    },
  });
  assert.equal(calls, 6);
  assert.match(result, /Capítulo 3/);
});

test('audit failure leaves partial text visible without returning a completed draft', async () => {
  let calls = 0;
  let visible = '';
  const chapter = { title: 'TEMA', scope: 'Examinar prova', sources: ['F1P1'] };
  await assert.rejects(() => draftInChapters({ files: [{ name: 'autos', text: 'provas' }], instructions: '', systemInstruction: '',
    parse: JSON.parse, progress: () => {}, onDraft: text => { visible = text; },
    generate: async () => {
      calls++;
      if (calls === 1) return 'Inventário';
      if (calls === 2) return JSON.stringify({ chapters: [chapter, chapter, chapter] });
      if (calls === 6) return '{"complete":false,"issues":["Pedido sem julgamento"]}';
      return 'Capítulo parcial';
    },
  }), /Pedido sem julgamento/);
  assert.match(visible, /Capítulo parcial/);
});
