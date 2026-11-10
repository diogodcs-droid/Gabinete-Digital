/* ===== Interface e fluxo de trabalho ===== */
(function () {
  'use strict';

  const LIM = { PROMPT: 262144, DIRECT_MAX: 110000, CHUNK: 120000, NOTES_MAX: 100000, MAX_CHUNKS: 12 };
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const state = {
    files: [],
    flags: { sumarissimo: false, revelia: false, procedenteTotal: false, improcedenteTotal: false },
    tipo: 'standard',
    analysis: null, verif: {}, notes: '', analysisSig: '',
    deadlinesScan: [],
    draft: '', draftTipo: 'standard', truncated: false,
    check: null,
    parecer: '', parecerChecks: null,
    history: [],
    busy: false, ctls: new Set(),
    sample: null, downloads: null,
    corpusCache: { sig: '', nw: '', raw: '' },
    activeTab: 'inicial', deadlineFilter: 'todos', editing: false
  };

  /* ---------- utilidades de interface ---------- */
  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast ' + (kind || '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'err' ? 9000 : 4500);
  }
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  const fmtInt = (n) => n.toLocaleString('pt-BR');
  const fmtDateTime = (ts) => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  let uid = 0;

  function setTab(name) {
    state.activeTab = name;
    $$('.tab').forEach(b => { const on = b.dataset.tab === name; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    $$('.panel').forEach(p => { p.hidden = p.id !== 'tab-' + name; });
  }

  /* ---------- Claude (sample) ---------- */
  const ERR = {
    not_granted: 'O uso do Claude não foi autorizado neste artefato. Recarregue a página e permita quando o pedido aparecer.',
    rate_limited: 'Limite de uso atingido. Aguarde alguns minutos e tente de novo.',
    prompt_too_large: 'O conteúdo enviado passou do limite de tamanho. Envie menos arquivos ou rode a extração para criar o fichamento dos autos.',
    session_expired: 'A sessão expirou. Entre novamente no Claude.',
    sampling_disabled: 'O Claude não está disponível para esta conta ou organização.',
    refused: 'O Claude recusou este pedido. Reformule as diretrizes.',
    empty_completion: 'O Claude não devolveu texto. Tente de novo com menos conteúdo.',
    invalid_json: 'A resposta não veio em formato estruturado. Tente de novo.',
    upstream_error: 'Falha temporária de conexão com o Claude. Tente de novo.',
    cancelled: 'Operação interrompida.',
    invalid_request: 'Pedido inválido enviado ao Claude (erro do aplicativo).',
    tools_unavailable: 'Recurso indisponível neste ambiente.',
    capability_disabled: 'O Claude está desativado neste ambiente.',
    not_declared: 'O artefato não declara o uso do Claude.'
  };
  const errMsg = (e) => (e && e.code && ERR[e.code]) || (e && e.message) || 'Erro inesperado.';

  async function ask(input, opt) {
    opt = opt || {};
    if (!state.sample) { const e = new Error('Claude indisponível'); e.code = 'capability_disabled'; throw e; }
    const ctl = new AbortController();
    state.ctls.add(ctl);
    const o = { signal: ctl.signal, modelTier: opt.tier || 'default', cache: !!opt.cache };
    if (opt.onText) o.onText = opt.onText;
    const inp = input;
    try {
      if (opt.json) {
        try { return await state.sample.json(inp, o); }
        catch (e) {
          if (e && e.code === 'invalid_json' && e.text) { try { return parseJsonLoose(e.text); } catch (_) { /* segue */ } }
          throw e;
        }
      }
      return await state.sample(inp, o);
    } finally { state.ctls.delete(ctl); }
  }
  // executa tarefas em paralelo com limite de simultaneidade, preservando a ordem; falha rápido e cancela as demais
  async function mapPool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0, failed = null;
    async function worker() {
      while (!failed) {
        const i = next++;
        if (i >= items.length) return;
        try { out[i] = await fn(items[i], i); }
        catch (e) { failed = failed || e; stopNow(); return; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    if (failed) throw failed;
    return out;
  }

  function setBusy(on, label) {
    state.busy = on;
    const pr = $('#progress');
    pr.hidden = !on;
    if (on) { $('#progText').textContent = label || 'Trabalhando...'; $('#progBar').style.width = '0%'; $('#progBar').parentElement.classList.add('indet'); }
    ['btnGenerate', 'btnRefine', 'btnParecer', 'btnFix', 'btnContinue'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = on || !state.sample; });
  }
  function progress(text, pct) {
    $('#progText').textContent = text;
    const bar = $('#progBar');
    if (typeof pct === 'number') { bar.parentElement.classList.remove('indet'); bar.style.width = Math.max(2, Math.min(100, pct)) + '%'; }
  }
  const stopNow = () => { state.ctls.forEach(c => { try { c.abort(); } catch (e) { /* ignora */ } }); };

  /* ---------- Autos: leitura dos arquivos ---------- */
  function pdfWorkerSetup() {
    if (window.__pdfWorkerReady) return;
    const url = window.__PDF_WORKER_URL__ || 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    try {
      const blob = new Blob(['importScripts("' + url + '");'], { type: 'text/javascript' });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    } catch (e) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = url; }
    window.__pdfWorkerReady = true;
  }
  function textToBlocks(text, size) {
    size = size || 3500;
    const paras = String(text).replace(/\r/g, '').split(/\n+/).map(s => s.trim()).filter(Boolean);
    const blocks = [];
    let cur = '';
    for (const p of paras) {
      if (cur && cur.length + p.length + 1 > size) { blocks.push(cur); cur = ''; }
      cur = cur ? cur + '\n' + p : p;
    }
    if (cur) blocks.push(cur);
    return blocks.map((t, i) => ({ n: i + 1, text: t }));
  }
  async function readPdf(file, onProg) {
    if (!window.pdfjsLib) throw new Error('O leitor de PDF não carregou neste ambiente. Envie DOCX ou TXT, ou cole o texto.');
    pdfWorkerSetup();
    const data = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data }).promise;
    const N = pdf.numPages;
    const pages = new Array(N);
    let done = 0, next = 1;
    const readPage = async (i) => {
      const pg = await pdf.getPage(i);
      const tc = await pg.getTextContent();
      let t = tc.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('');
      t = t.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      pages[i - 1] = { n: i, text: t };
      if (pg.cleanup) pg.cleanup();
      done++;
      if (onProg && (done % 10 === 0 || done === N)) onProg(done, N);
    };
    const worker = async () => { while (next <= N) { const i = next++; await readPage(i); } };
    await Promise.all(Array.from({ length: Math.min(8, N) }, worker));
    return { kind: 'pdf', pages };
  }
  async function readDocx(file) {
    if (!window.mammoth) throw new Error('O leitor de DOCX não carregou neste ambiente. Envie PDF ou TXT, ou cole o texto.');
    const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { kind: 'texto', pages: textToBlocks(r.value) };
  }
  async function readTxt(file) {
    return { kind: 'texto', pages: textToBlocks(await file.text()) };
  }
  async function readAny(file, onProg) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'pdf' || file.type === 'application/pdf') return readPdf(file, onProg);
    if (ext === 'docx') return readDocx(file);
    if (ext === 'txt' || file.type === 'text/plain') return readTxt(file);
    throw new Error('Formato não suportado: ' + file.name + '. Use PDF, DOCX ou TXT.');
  }
  async function ingest(fileList) {
    for (const f of Array.from(fileList)) {
      const entry = { id: ++uid, name: f.name, kind: 'pdf', pages: [], chars: 0, emptyPages: 0, loading: true, prog: '' };
      state.files.push(entry);
      renderFiles();
      try {
        const r = await readAny(f, (i, n) => { entry.prog = `lendo página ${i} de ${n}`; renderFiles(); });
        entry.kind = r.kind; entry.pages = r.pages;
        entry.chars = r.pages.reduce((a, p) => a + p.text.length, 0);
        entry.emptyPages = r.pages.filter(p => !p.text.trim()).length;
        entry.loading = false;
      } catch (e) {
        state.files = state.files.filter(x => x.id !== entry.id);
        toast(`${f.name}: ${e.message || 'não foi possível ler o arquivo.'}`, 'err');
      }
      renderFiles();
    }
    onAutosChanged();
    autoExtract();
  }
  function autoExtract() {
    if (!state.sample || state.busy || state.files.some(f => f.loading) || !readyFiles().length) return;
    runExtraction();
  }
  function onAutosChanged() {
    state.corpusCache.sig = '';
    renderFiles(); renderResumo(); updateButtons();
  }
  const readyFiles = () => state.files.filter(f => !f.loading);
  const filesSig = () => readyFiles().map(f => f.name + ':' + f.chars).join('|');
  const autosSig = () => readyFiles().map(f => f.name + ':' + f.chars).join('|') + '#' + $('#diretrizes').value.length;
  function corpus() {
    const sig = autosSig();
    if (state.corpusCache.sig !== sig) {
      const raw = stripMarkers(autosText(readyFiles())) + '\n' + $('#diretrizes').value;
      state.corpusCache = { sig, raw, nw: nw(raw) };
    }
    return state.corpusCache;
  }
  function autosTotalChars() { return readyFiles().reduce((a, f) => a + f.chars, 0); }

  function renderFiles() {
    const box = $('#fileList');
    if (!state.files.length) { box.innerHTML = ''; return; }
    box.innerHTML = state.files.map(f => {
      const info = f.loading ? `<span class="muted">${esc(f.prog || 'lendo...')}</span>`
        : `<span class="muted">${f.kind === 'pdf' ? fmtInt(f.pages.length) + ' pág.' : fmtInt(f.pages.length) + ' bloco(s)'} · ${fmtInt(f.chars)} caracteres</span>`;
      const warn = (!f.loading && f.emptyPages) ? `<div class="file-warn">${f.emptyPages} página(s) sem texto. Pode ser PDF digitalizado; este aplicativo não faz OCR.</div>` : '';
      return `<li class="file"><div class="file-row"><span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span><button class="icon-btn" data-rm="${f.id}" aria-label="Remover ${esc(f.name)}">Remover</button></div>${info}${warn}</li>`;
    }).join('');
    const tot = autosTotalChars();
    const big = tot > LIM.DIRECT_MAX;
    $('#autosInfo').textContent = state.files.length
      ? `${fmtInt(tot)} caracteres no total. ${big ? 'Autos extensos: serão resumidos em fichamento com trechos literais antes de redigir.' : 'Cabem inteiros na redação da minuta.'}`
      : '';
  }

  /* ---------- Opções e diretrizes ---------- */
  function effectiveFlags() {
    const d = $('#diretrizes').value.toLowerCase();
    const f = state.flags;
    return {
      sumarissimo: f.sumarissimo || /sumar[ií]ssimo/.test(d),
      revelia: f.revelia || /revelia|revel da reclamada/.test(d),
      procedenteTotal: f.procedenteTotal || /(?<!im)proced[êe]ncia total|(?<!im)proced[êe]ncia de todos os pedidos|totalmente procedente|(?<!im)procedentes todos os pedidos/.test(d),
      improcedenteTotal: f.improcedenteTotal || /improced[êe]ncia total|totalmente improcedente|improced[êe]ncia de todos os pedidos|improcedentes todos os pedidos/.test(d)
    };
  }
  function saveDirectives() {
    const v = { diretrizes: $('#diretrizes').value, flags: state.flags, tipo: state.tipo, rigor: $('#rigor').value, extrairAntes: $('#optExtract').checked };
    lsSet('gd:diretrizes', v);
    $('#saveState').textContent = 'Salvo neste navegador';
  }
  function loadDirectives() {
    const v = lsGet('gd:diretrizes', null);
    if (!v) return;
    $('#diretrizes').value = v.diretrizes || '';
    state.flags = Object.assign(state.flags, v.flags || {});
    state.tipo = v.tipo === 'ed' ? 'ed' : 'standard';
    if (v.rigor) $('#rigor').value = v.rigor;
    if (typeof v.extrairAntes === 'boolean') $('#optExtract').checked = v.extrairAntes;
    $('#fSum').checked = !!state.flags.sumarissimo; $('#fRev').checked = !!state.flags.revelia;
    $('#fProc').checked = !!state.flags.procedenteTotal; $('#fImproc').checked = !!state.flags.improcedenteTotal;
    $$('input[name=tipo]').forEach(r => { r.checked = r.value === state.tipo; });
  }
  function updateButtons() {
    const has = readyFiles().length > 0 || $('#diretrizes').value.trim().length > 0;
    const ok = !!state.sample;
    $('#btnGenerate').disabled = state.busy || !ok || !has;
  }

  /* ---------- Montagem de prompts ---------- */
  function dossieTexto(an) {
    if (!an) return '(sem extração prévia)';
    const marco = marcoPrescricional(an.data_ajuizamento);
    const L = [];
    L.push(`Processo: ${an.numero_processo || 'não identificado'}`);
    L.push(`Reclamante: ${an.reclamante || 'não identificado'}`);
    L.push(`Reclamada: ${an.reclamada || 'não identificada'}`);
    L.push(`Vara do Trabalho: ${an.vt || 'não identificada'}`);
    L.push(`Matéria principal: ${an.materia_principal || 'não identificada'}`);
    L.push(`Rito segundo os autos: ${an.rito}`);
    L.push(`Revelia da reclamada: ${an.revelia === true ? 'sim' : an.revelia === false ? 'não' : 'não identificado'}`);
    L.push(`Ajuizamento: ${an.data_ajuizamento || 'não identificado'}${marco ? ` | marco da prescrição quinquenal (calculado pelo sistema): ${marco}` : ''}`);
    L.push(`Admissão: ${an.data_admissao || 'não identificada'} | Rescisão: ${an.data_rescisao || 'não identificada'}`);
    L.push(`Prescrição requerida por alguma parte: ${an.prescricao_requerida === true ? 'sim' : an.prescricao_requerida === false ? 'não' : 'não identificado'}`);
    if (an.pedidos_inicial) L.push(`\nPedidos da inicial:\n${an.pedidos_inicial}`);
    if (an.pedidos_contestacao) L.push(`\nPedidos/teses da contestação:\n${an.pedidos_contestacao}`);
    if (an.alertas && an.alertas.length) L.push(`\nAlertas da extração:\n${an.alertas.map(a => '- ' + a).join('\n')}`);
    return L.join('\n');
  }
  function optsPrompt(tipo) {
    const an = state.analysis;
    const fl = effectiveFlags();
    const marco = an ? marcoPrescricional(an.data_ajuizamento) : null;
    let aplicavel = null;
    if (an && marco) {
      const adm = parseBR(an.data_admissao), mar = parseBR(marco);
      if (an.prescricao_requerida === true) aplicavel = true;
      else if (adm && mar && cmpD(adm, mar) < 0) aplicavel = true;
      else if (an.prescricao_requerida === false && adm && mar) aplicavel = false;
    }
    return { tipo, sumarissimo: fl.sumarissimo, revelia: fl.revelia, procedenteTotal: fl.procedenteTotal, improcedenteTotal: fl.improcedenteTotal, marcoPrescricional: marco, dataAjuizamento: an && an.data_ajuizamento, prescricaoAplicavel: aplicavel };
  }
  const cmpD = (a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);

  // escolhe entre autos integrais e fichamento, respeitando o limite de 256 KiB
  function autosSection(otherBytes) {
    const files = readyFiles();
    if (!files.length) return { mode: 'nenhum', text: '=== AUTOS ===\n(nenhum arquivo de autos foi enviado; baseie-se apenas nas diretrizes e não invente fatos)' };
    const text = autosText(files);
    const avail = Math.floor(LIM.PROMPT * 0.94) - otherBytes - 3000;
    if (byteLen(text) <= avail) return { mode: 'integral', text: '=== AUTOS (texto integral) ===\n' + text };
    if (state.notes && !analysisStale() && byteLen(state.notes) <= avail) return { mode: 'fichamento', text: PARECER_FORMATO_FICHAMENTO + '\n\n=== FICHAMENTO DOS AUTOS ===\n' + state.notes };
    return { mode: 'insuficiente', text: '' };
  }
  function promptGeracao(tipo, extraBytes) {
    const sys = (tipo === 'ed' ? SYSTEM_INSTRUCTION_ED : SYSTEM_INSTRUCTION) + regrasAdicionais(optsPrompt(tipo));
    const dir = $('#diretrizes').value.trim();
    const head = `${sys}\n\n=== DIRETRIZES DO MAGISTRADO ===\n${dir || '(nenhuma diretriz específica; decida conforme os autos e a lei)'}\n\n=== DADOS EXTRAÍDOS PELO SISTEMA (apoio; confira com os autos; havendo divergência, prevalecem os autos) ===\n${dossieTexto(state.analysis)}\n\n`;
    const tail = `\n\n=== TAREFA ===\nRedija agora a minuta completa de ${tipo === 'ed' ? 'SENTENÇA DE EMBARGOS DE DECLARAÇÃO' : 'SENTENÇA'}, aplicando todas as regras acima. Responda apenas com o texto da minuta, terminando em "Nada mais.".`;
    const sec = autosSection(byteLen(head + tail) + (extraBytes || 0));
    return { head, tail, sec, full: sec.mode === 'insuficiente' ? null : head + sec.text + tail };
  }

  /* ---------- Extração dos dados ---------- */
  function promptExtracaoDireta(text) {
    return `${EXTRACAO_SPEC}\n\n${MARCADORES_AUTOS}\n\nREALIZE A EXTRAÇÃO ESTRUTURADA EXAUSTIVA E COMPLETA do processo a partir dos autos abaixo. Extraia minuciosamente todos os fatos, pedidos, defesas, provas com IDs e folhas, e prazos. Responda unicamente com o JSON.\n\n=== AUTOS ===\n${text}`;
  }
  function promptExtracaoNotas(notes) {
    return `${EXTRACAO_SPEC}\n\n${MARCADORES_AUTOS}\n\nOs autos eram extensos e foram resumidos nos FICHAMENTOS abaixo, que contêm âncoras [fl. | ID] e trechos literais. Trate-os como a fonte dos autos. REALIZE A EXTRAÇÃO ESTRUTURADA EXAUSTIVA E COMPLETA e responda unicamente com o JSON.\n\n=== FICHAMENTOS ===\n${notes}`;
  }
  async function reduceNotes(parts) {
    let round = 0;
    let cur = parts;
    while (cur.join('\n\n').length > LIM.NOTES_MAX && round < 3) {
      round++;
      const batches = [];
      let b = '';
      for (const p of cur) {
        if (b && b.length + p.length > 150000) { batches.push(b); b = ''; }
        b += (b ? '\n\n' : '') + p;
      }
      if (b) batches.push(b);
      if (batches.length === 1 && b.length <= LIM.NOTES_MAX) return b;
      const target = Math.floor(LIM.NOTES_MAX / batches.length);
      const out = await mapPool(batches, 3, async (bt, i) => {
        progress(`Condensando o fichamento (rodada ${round}, ${batches.length} parte(s) em paralelo)...`);
        const r = await ask(`Consolide os fichamentos abaixo em UM fichamento único de no máximo ${fmtInt(target)} caracteres. Elimine repetições, mas preserve TODAS as âncoras [fl. N | ID], datas, valores, pedidos, teses e os trechos literais entre aspas dos depoimentos, laudos e documentos-chave. Não interprete nem invente. Responda só com o fichamento.\n\n${bt}`, { tier: 'default', cache: true });
        return r.text;
      });
      cur = out;
    }
    return cur.join('\n\n');
  }

  async function runExtraction(onlyNotes) {
    const files = readyFiles();
    const dir = $('#diretrizes').value.trim();
    if (!files.length && !dir) { toast('Envie os autos ou escreva as diretrizes.', 'err'); return false; }
    setBusy(true, 'Lendo os autos...');
    try {
      const blocks = files.length ? allBlocks(files) : ['[[ARQUIVO: Diretrizes]]\n' + dir];
      const total = blocks.reduce((a, b) => a + b.length + 1, 0);
      let notes = '';
      let raw = null;
      const textAll = blocks.join('\n');
      const direto = promptExtracaoDireta(textAll);
      if (!onlyNotes && byteLen(direto) <= Math.floor(LIM.PROMPT * 0.9)) {
        progress('Extraindo os dados estruturados dos autos (uma única leitura)...');
        raw = await ask(direto, { tier: 'default', json: true, cache: true });
      } else {
        const chunks = chunkBlocks(blocks, LIM.CHUNK);
        const use = chunks.slice(0, LIM.MAX_CHUNKS);
        if (chunks.length > use.length) toast(`Os autos têm ${chunks.length} partes; apenas as ${use.length} primeiras serão processadas.`, 'warn');
        let feitos = 0;
        progress(`Fichando os autos em paralelo: ${use.length} parte(s)...`, 2);
        const parts = await mapPool(use, 3, async (ch, i) => {
          const r = await ask(`${FICHAMENTO_SPEC}\n\n${MARCADORES_AUTOS}\n\n=== PARTE ${i + 1} DE ${use.length} DOS AUTOS ===\n${ch}`, { tier: 'default', cache: true });
          feitos++; progress(`Fichando os autos: ${feitos} de ${use.length} partes prontas...`, (feitos / (use.length + 1)) * 100);
          return `### Parte ${i + 1} de ${use.length}\n${r.text}`;
        });
        notes = await reduceNotes(parts);
        if (!onlyNotes) {
          progress('Consolidando os dados estruturados...', 92);
          raw = await ask(promptExtracaoNotas(notes), { tier: 'default', json: true, cache: true });
        }
      }
      if (onlyNotes) {
        state.notes = notes;
        return true;
      }
      const an = normalizeAnalysis(raw);
      state.analysis = an; state.notes = notes; state.analysisSig = filesSig();
      const cp = corpus().raw;
      state.verif = {
        numero_processo: dadoNosAutos(an.numero_processo, cp), data_ajuizamento: dadoNosAutos(an.data_ajuizamento, cp),
        data_admissao: dadoNosAutos(an.data_admissao, cp), data_rescisao: dadoNosAutos(an.data_rescisao, cp),
        reclamante: dadoNosAutos(an.reclamante, cp), reclamada: dadoNosAutos(an.reclamada, cp)
      };
      state.deadlinesScan = extractDeadlinesFromText(cp);
      renderResumo(); renderPrazos();
      toast('Dados extraídos. Confira as abas Inicial, Pedidos, Defesa e Provas antes de gerar a minuta.', 'ok');
      return true;
    } catch (e) {
      toast(errMsg(e), e && e.code === 'cancelled' ? '' : 'err');
      return false;
    } finally {
      setBusy(false); updateButtons();
    }
  }
  const analysisStale = () => !state.analysis || state.analysisSig !== filesSig();

  /* ---------- Resumo ---------- */
  function chip(v) {
    if (v === true) return '<span class="chip ok" title="O valor aparece nos autos enviados">nos autos</span>';
    if (v === false) return '<span class="chip warn" title="O valor extraído não foi encontrado literalmente nos autos">conferir</span>';
    return '';
  }
  function renderResumo() {
    const an = state.analysis;
    const ids = ['inicialBody', 'pedidosBody', 'defesaBody', 'provasBody'];
    const put = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    if (!an) {
      const n = readyFiles().length;
      const vazio = `<div class="empty"><h3>Nenhum dado extraído ainda</h3><p>${n ? 'A extração começa sozinha quando a leitura dos arquivos termina. Cada dado é conferido contra o texto dos autos.' : 'Comece enviando os autos (PDF, DOCX ou TXT) ou colando o texto. A análise aparece aqui depois da extração.'}</p></div>`;
      ids.forEach(id => put(id, vazio));
      return;
    }
    const marco = marcoPrescricional(an.data_ajuizamento);
    const stale = analysisStale() ? '<div class="notice warn">Os autos mudaram depois da extração. Ela será refeita ao gerar a minuta.</div>' : '';
    const fl = effectiveFlags();
    const hints = [];
    if (an.rito === 'sumaríssimo' && !fl.sumarissimo) hints.push(['sumarissimo', 'Os autos indicam rito sumaríssimo.']);
    if (an.revelia === true && !fl.revelia) hints.push(['revelia', 'Os autos indicam revelia da reclamada.']);
    const hintHtml = hints.map(h => `<div class="notice info">${esc(h[1])} <button class="link-btn" data-flag="${h[0]}">Marcar opção</button></div>`).join('');
    const row = (k, v, c) => `<div class="kv"><dt>${k}</dt><dd>${v ? esc(v) : '<span class="muted">não identificado</span>'} ${c || ''}</dd></div>`;
    const sec = (titulo, texto) => `<h3 class="h-sec">${titulo}</h3><div class="rich">${mdToHtml(texto) || '<p class="muted">Nada identificado nesta seção.</p>'}</div>`;
    const als = an.alertas.slice();
    const ix = idIndex(readyFiles());
    if (ix.emptyPages) als.push(`${ix.emptyPages} página(s) dos autos sem texto legível (PDF digitalizado?). O conteúdo delas não foi lido.`);
    const alertHtml = als.length ? `<details class="det" open><summary>Alertas para conferência (${als.length})</summary><ul>${als.map(a => `<li>${esc(a)}</li>`).join('')}</ul></details>` : '';
    const juris = an.jurisprudencia;
    const jurisHtml = (juris.trt4 || juris.tst || juris.stf) ? `<details class="det"><summary>Jurisprudência sugerida (não verificada)</summary><div class="notice info">Sugestões geradas pelo Claude a partir do conhecimento do modelo, sem consulta a bases oficiais. Confira número e tese de cada precedente na fonte oficial antes de usar.</div><h4>TRT4</h4>${mdToHtml(juris.trt4) || '<p class="muted">Sem itens.</p>'}<h4>TST</h4>${mdToHtml(juris.tst) || '<p class="muted">Sem itens.</p>'}<h4>STF</h4>${mdToHtml(juris.stf) || '<p class="muted">Sem itens.</p>'}</details>` : '';
    put('inicialBody', `${stale}${hintHtml}
      <dl class="kvs">
        ${row('Processo', an.numero_processo, chip(state.verif.numero_processo))}
        ${row('Reclamante', an.reclamante, chip(state.verif.reclamante))}
        ${row('Reclamada', an.reclamada, chip(state.verif.reclamada))}
        ${row('Vara', an.vt)}
        ${row('Matéria', an.materia_principal)}
        ${row('Rito', an.rito)}
        ${row('Revelia', an.revelia === true ? 'Sim' : an.revelia === false ? 'Não' : '')}
        ${row('Ajuizamento', an.data_ajuizamento, chip(state.verif.data_ajuizamento))}
        ${row('Marco da prescrição quinquenal', marco ? marco + ' (calculado: 5 anos antes do ajuizamento)' : '')}
        ${row('Admissão', an.data_admissao, chip(state.verif.data_admissao))}
        ${row('Rescisão', an.data_rescisao, chip(state.verif.data_rescisao))}
        ${row('Prescrição requerida', an.prescricao_requerida === true ? 'Sim' : an.prescricao_requerida === false ? 'Não' : '')}
      </dl>
      ${alertHtml}
      ${sec('Alegações da petição inicial', an.alegacoes_inicial)}
      ${jurisHtml}`);
    put('pedidosBody', `${stale}${sec('Pedidos da inicial', an.pedidos_inicial)}${sec('Pedidos e requerimentos da defesa', an.pedidos_contestacao)}`);
    put('defesaBody', `${stale}${sec('Alegações da defesa', an.alegacoes_contestacao)}`);
    const semNovo = !an.provas_autor && !an.provas_reclamada && !an.analise_provas;
    put('provasBody', `${stale}${semNovo ? sec('Provas produzidas', an.provas_produzidas) : `${sec('Provas do autor (reclamante)', an.provas_autor)}${sec('Provas da reclamada', an.provas_reclamada)}${sec('Análise das provas', an.analise_provas)}`}
      <p class="muted small">A análise das provas é um apoio gerado a partir dos autos. Confira cada trecho nas folhas indicadas.</p>`);
  }

  /* ---------- Prazos ---------- */
  const TIPOS = {
    audiencia: ['Audiência', 'k-aud'], prazo: ['Prazo', 'k-prz'], prescricao: ['Prescrição', 'k-pre'],
    distribuicao: ['Ajuizamento', 'k-dis'], pericia: ['Perícia', 'k-per'], outro: ['Marco dos autos', 'k-out']
  };
  function allDeadlines() {
    const list = []; const seen = new Set();
    const push = (p) => { const k = (p.data + '::' + p.descricao.slice(0, 30)).toLowerCase(); if (!seen.has(k)) { seen.add(k); list.push(p); } };
    if (state.analysis) state.analysis.prazos_processuais.forEach(push);
    state.deadlinesScan.forEach(push);
    const peso = { urgente: 0, alerta: 1, informativo: 2, cumprido: 3 };
    return list.sort((a, b) => (peso[a.status] ?? 9) - (peso[b.status] ?? 9));
  }
  function renderPrazos() {
    const box = $('#prazosBody');
    if (!box) return;
    const all = allDeadlines();
    const counts = {};
    all.forEach(p => { counts[p.tipo] = (counts[p.tipo] || 0) + 1; });
    const shown = all.filter(p => state.deadlineFilter === 'todos' || p.tipo === state.deadlineFilter);
    if (!all.length) { box.innerHTML = `<div class="empty"><h3>Nenhum prazo ou data identificado</h3><p>Use "Procurar no texto dos autos" para varrer as datas e prazos, ou rode a extração de dados.</p></div>`; return; }
    const chips = ['todos', ...Object.keys(counts)].map(k => `<button class="seg-btn" aria-pressed="${state.deadlineFilter === k}" data-dl="${k}">${k === 'todos' ? 'Todos' : TIPOS[k][0]} (${k === 'todos' ? all.length : counts[k]})</button>`).join('');
    box.innerHTML = `<div class="seg">${chips}</div><ul class="dl">${shown.map((p, i) => {
      const t = TIPOS[p.tipo] || TIPOS.outro;
      return `<li class="dl-item"><div class="dl-top"><span class="dl-date ${t[1]}">${esc(p.data)}</span><span class="tag">${t[0]}</span>${p.status === 'urgente' ? '<span class="tag urg">Urgente</span>' : ''}<button class="link-btn" data-ins="${i}">Inserir nas diretrizes</button></div><p class="dl-desc">${esc(p.descricao)}</p>${p.contexto ? `<p class="dl-ctx">“${esc(p.contexto.trim())}”</p>` : (p.origem ? `<p class="dl-ctx">${esc(p.origem)}</p>` : '')}</li>`;
    }).join('')}</ul>`;
    box._shown = shown;
  }

  /* ---------- Minuta ---------- */
  let paintTimer = null;
  function paintDraft(text, tipo) {
    $('#paper').innerHTML = draftToHtml(text, tipo || state.draftTipo);
  }
  function showDraftUI() {
    const has = !!state.draft;
    $('#minutaEmpty').hidden = has || state.busy;
    $('#minutaWrap').hidden = !(has || state.busy);
    $('#minutaMeta').textContent = state.draftTipo === 'ed' ? 'Sentença de embargos de declaração' : 'Sentença';
    $('#truncNotice').hidden = !state.truncated;
    $('#paper').hidden = state.editing;
    $('#editor').hidden = !state.editing;
    $('#btnEdit').textContent = state.editing ? 'Concluir edição' : 'Editar texto';
    const dis = !has || state.busy;
    ['btnEdit', 'btnCopy', 'btnDocx'].forEach(id => { $('#' + id).disabled = dis; });
  }
  function streamPaint(text, tipo) {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(() => paintDraft(text, tipo), 120);
  }
  async function ensureAutosFit(tipo, extraBytes) {
    let p = promptGeracao(tipo, extraBytes);
    if (p.sec.mode === 'insuficiente') {
      if (!state.notes || analysisStale()) {
        progress('Os autos são extensos: criando o fichamento com trechos literais...');
        const ok = await runExtractionInner(true);
        if (!ok) return null;
        p = promptGeracao(tipo, extraBytes);
      }
      if (p.sec.mode === 'insuficiente') throw Object.assign(new Error('Mesmo resumidos, os autos e a minuta não cabem em um único envio. Remova arquivos menos relevantes.'), { code: 'prompt_too_large' });
    }
    return p;
  }
  // versão sem setBusy próprio (já estamos ocupados)
  async function runExtractionInner(onlyNotes) {
    state.busy = false;
    const was = $('#progress').hidden;
    const ok = await runExtraction(!!onlyNotes && !analysisStale());
    setBusy(true, $('#progText').textContent);
    $('#progress').hidden = was;
    return ok;
  }

  async function runGenerate() {
    const tipo = state.tipo;
    if (!readyFiles().length && !$('#diretrizes').value.trim()) { toast('Envie os autos ou escreva as diretrizes.', 'err'); return; }
    if (analysisStale() && $('#optExtract').checked) {
      const ok = await runExtraction();
      if (!ok) return;
    }
    setBusy(true, 'Preparando a redação da minuta...');
    state.editing = false; state.truncated = false;
    try {
      const p = await ensureAutosFit(tipo, 0);
      if (!p) return;
      if (p.sec.mode === 'fichamento') toast('Autos extensos: a minuta usa o fichamento com trechos literais, não o texto integral.', 'warn');
      state.draft = ''; state.draftTipo = tipo; setTab('minuta'); showDraftUI();
      $('#paper').innerHTML = '<p class="muted">O Claude está lendo os autos e pensando antes de escrever. Isso pode levar alguns minutos.</p>';
      progress('Redigindo a minuta (modelo de maior rigor pode pensar por alguns minutos antes de escrever)...');
      let partial = '';
      const res = await ask([{ role: 'user', content: p.full }], {
        tier: $('#rigor').value, onText: ({ text }) => { partial = text; progress('Redigindo a minuta... ' + fmtInt(text.length) + ' caracteres'); streamPaint(cleanDraft(text), tipo); }
      });
      state.truncated = !!res.truncated;
      finishDraft(res.text, tipo, 'gerada');
    } catch (e) {
      if (e && e.text) { state.draft = cleanDraft(e.text); state.truncated = true; finishDraft(state.draft, tipo, 'parcial', true); }
      toast(errMsg(e) + (e && e.text ? ' O texto parcial foi mantido.' : ''), e && e.code === 'cancelled' ? '' : 'err');
    } finally {
      setBusy(false); updateButtons(); showDraftUI();
    }
  }
  function finishDraft(text, tipo, origem, quiet) {
    state.draft = ensureSentencaHeading(cleanDraft(text), tipo);
    state.draftTipo = tipo;
    paintDraft(state.draft, tipo);
    $('#editor').value = state.draft;
    if (!/Nada mais\.\s*$/.test(state.draft)) state.truncated = true;
    runChecks();
    saveHistory(origem);
    if (!quiet) {
      const e = state.check ? state.check.items.filter(i => i.nivel === 'erro').length : 0;
      toast(e ? `Minuta pronta, com ${e} ponto(s) a corrigir na seção Conferência, abaixo da minuta.` : 'Minuta pronta. Confira os avisos na seção Conferência, abaixo da minuta.', e ? 'warn' : 'ok');
      
    }
  }
  async function runRefine() {
    const instr = $('#refineText').value.trim();
    if (!state.draft) return;
    if (!instr) { toast('Escreva o ajuste desejado.', 'err'); return; }
    setBusy(true, 'Reescrevendo a minuta...');
    state.editing = false;
    try {
      const tipo = state.draftTipo;
      const extra = byteLen(state.draft) + byteLen(instr) + 1500;
      const p = await ensureAutosFit(tipo, extra);
      if (!p) return;
      const turns = [
        { role: 'user', content: p.full },
        { role: 'assistant', content: state.draft },
        { role: 'user', content: `AJUSTE SOLICITADO PELO MAGISTRADO:\n${instr}\n\nReescreva a minuta COMPLETA aplicando o ajuste, de forma coerente em todo o texto, e preservando sem alteração o que não depender do ajuste. Mantenha todas as regras de formatação e os textos padrão. Se o ajuste pedir algo que contrarie os autos, mantenha a fidelidade aos autos e registre o alerta no formato [ALERTA DE INCONSISTÊNCIA: ...]. Responda apenas com a minuta, terminando em "Nada mais.".` }
      ];
      progress('Reescrevendo a minuta...');
      const res = await ask(turns, { tier: $('#rigor').value, onText: ({ text }) => { progress('Reescrevendo... ' + fmtInt(text.length) + ' caracteres'); streamPaint(cleanDraft(text), tipo); } });
      state.truncated = !!res.truncated;
      finishDraft(res.text, tipo, 'ajustada');
      $('#refineText').value = '';
    } catch (e) {
      paintDraft(state.draft);
      toast(errMsg(e), e && e.code === 'cancelled' ? '' : 'err');
    } finally { setBusy(false); updateButtons(); showDraftUI(); }
  }
  async function runContinue() {
    if (!state.draft) return;
    setBusy(true, 'Continuando a minuta...');
    try {
      const tipo = state.draftTipo;
      const p = await ensureAutosFit(tipo, byteLen(state.draft) + 1500);
      if (!p) return;
      const turns = [
        { role: 'user', content: p.full },
        { role: 'assistant', content: state.draft },
        { role: 'user', content: 'A minuta acima foi interrompida antes do fim. Continue EXATAMENTE de onde parou, sem repetir nada do que já foi escrito e sem comentários, até concluir o dispositivo e terminar em "Nada mais.".' }
      ];
      const base = state.draft;
      const res = await ask(turns, { tier: $('#rigor').value, onText: ({ text }) => { progress('Continuando... ' + fmtInt(text.length) + ' caracteres'); streamPaint(cleanDraft(base + '\n' + text), tipo); } });
      state.truncated = !!res.truncated;
      finishDraft(base + '\n' + res.text, tipo, 'continuada');
    } catch (e) { paintDraft(state.draft); toast(errMsg(e), e && e.code === 'cancelled' ? '' : 'err'); }
    finally { setBusy(false); updateButtons(); showDraftUI(); }
  }

  /* ---------- Conferência ---------- */
  function checkCtx(tipo) {
    const c = corpus();
    const an = state.analysis;
    return {
      tipo, flags: effectiveFlags(), analysis: an,
      autos: idIndex(readyFiles()),
      corpusNw: readyFiles().length ? c.nw : '', corpusRaw: c.raw,
      marcoPrescricional: an ? marcoPrescricional(an.data_ajuizamento) : null, dataAjuizamento: an && an.data_ajuizamento
    };
  }
  function runChecks() {
    if (!state.draft) { state.check = null; renderConf(); return; }
    const hasAutos = readyFiles().length > 0;
    const ctx = checkCtx(state.draftTipo);
    if (!hasAutos) { ctx.autos = null; ctx.corpusNw = ''; }
    state.check = checkDraft(state.draft, ctx);
    // dicas de coerência entre extração e opções
    const an = state.analysis; const fl = effectiveFlags();
    if (an && state.draftTipo !== 'ed') {
      if (an.rito === 'sumaríssimo' && !fl.sumarissimo) state.check.items.push({ nivel: 'aviso', regra: 'Rito', detalhe: 'Os autos indicam rito sumaríssimo, mas a opção não estava marcada ao gerar.' });
      if (an.revelia === true && !fl.revelia) state.check.items.push({ nivel: 'aviso', regra: 'Revelia', detalhe: 'Os autos indicam revelia da reclamada, mas a opção não estava marcada ao gerar.' });
      if (fl.procedenteTotal && fl.improcedenteTotal) state.check.items.push({ nivel: 'erro', regra: 'Opções', detalhe: 'As opções "procedência total" e "improcedência total" estão ambas marcadas.' });
    }
    if (!hasAutos) state.check.items.push({ nivel: 'aviso', regra: 'Autos', detalhe: 'Nenhum arquivo de autos foi enviado: IDs, folhas, citações e valores não puderam ser conferidos.' });
    renderConf();
  }
  const NIV = { erro: ['Corrigir', 'n-err'], aviso: ['Conferir', 'n-warn'], ok: ['Conforme', 'n-ok'] };
  function listChecks(items) {
    const ord = { erro: 0, aviso: 1, ok: 2 };
    return items.slice().sort((a, b) => ord[a.nivel] - ord[b.nivel]).map(i =>
      `<li class="chk ${NIV[i.nivel][1]}"><span class="chk-tag">${NIV[i.nivel][0]}</span><div><strong>${esc(i.regra)}</strong><p>${esc(i.detalhe)}</p></div></li>`).join('');
  }
  function renderConf() {
    const box = $('#confBody');
    const badge = $('#confCount');
    const ck = state.check;
    if (!ck) { box.innerHTML = '<div class="empty"><h3>Nada para conferir ainda</h3><p>Depois que a minuta for gerada, esta aba mostra a conferência automática: cabeçalho, estrutura, textos padrão, ordem dos tópicos, IDs, folhas, citações literais, valores e custas.</p></div>'; badge.textContent = ''; badge.className = 'count'; return; }
    const n = (k) => ck.items.filter(i => i.nivel === k).length;
    badge.textContent = String(n('erro') + n('aviso')) === '0' ? '' : String(n('erro') + n('aviso'));
    badge.className = 'count ' + (n('erro') ? 'c-err' : 'c-warn');
    const std = nw(Object.values(STD).flat().join(' '));
    const cits = ck.citacoes.map(c => {
      const num = (c.label.match(/\d[\d.\/]*/) || [''])[0];
      const prefix = c.label.split(' ')[0].toLowerCase();
      const padrao = num && new RegExp('\\b' + prefix.replace('.', '') + '\\D{0,14}' + num.replace(/\./g, '\\.?').replace(/\//g, '\\/?'), 'i').test(Object.values(STD).flat().join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
      return { ...c, padrao };
    }).sort((a, b) => (a.padrao - b.padrao) || a.cat.localeCompare(b.cat));
    box.innerHTML = `
      <div class="sum">
        <span class="sum-i n-err">${n('erro')} a corrigir</span><span class="sum-i n-warn">${n('aviso')} a conferir</span><span class="sum-i n-ok">${n('ok')} conformes</span>
        <button id="btnFix" class="btn" ${(n('erro') + n('aviso')) && state.sample ? '' : 'disabled'}>Corrigir automaticamente</button>
        <button id="btnRecheck" class="btn ghost">Conferir de novo</button>
      </div>
      <p class="muted small">A conferência compara a minuta com as regras do gabinete e com o texto dos autos enviados. Ela não substitui a leitura do magistrado.</p>
      <ul class="chks">${listChecks(ck.items)}</ul>
      <h3 class="h-sec">Precedentes e normas citados</h3>
      <p class="muted small">Estas citações vêm do texto da minuta. O Claude não consulta bases oficiais: confira número e conteúdo na fonte antes de assinar.</p>
      ${cits.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Citação</th><th>Tipo</th><th>Vezes</th><th>Situação</th></tr></thead><tbody>${cits.map(c => `<tr><td>${esc(c.label)}</td><td>${esc(c.cat)}</td><td class="num">${c.n}</td><td>${c.padrao ? '<span class="chip ok">texto padrão do gabinete</span>' : '<span class="chip warn">conferir na fonte</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhuma citação normativa identificada.</p>'}`;
  }
  async function runFix() {
    const ck = state.check;
    if (!ck || !state.draft) return;
    const probs = ck.items.filter(i => i.nivel !== 'ok');
    if (!probs.length) return;
    setBusy(true, 'Corrigindo os pontos apontados...');
    try {
      const tipo = state.draftTipo;
      const lista = probs.map((p, i) => `${i + 1}. [${p.nivel.toUpperCase()}] ${p.regra}: ${p.detalhe}`).join('\n');
      const extra = byteLen(state.draft) + byteLen(lista) + 2500;
      const p = await ensureAutosFit(tipo, extra);
      if (!p) return;
      const turns = [
        { role: 'user', content: p.full },
        { role: 'assistant', content: state.draft },
        { role: 'user', content: `A CONFERÊNCIA AUTOMÁTICA apontou os itens abaixo na minuta.\n\n${lista}\n\nCorrija SOMENTE esses itens, mantendo todo o restante idêntico. Regras: (a) para ID, folha, citação literal ou valor não localizado nos autos, procure o dado correto nos autos e substitua; se não o encontrar, remova a afirmação ou registre [ALERTA DE INCONSISTÊNCIA: ...]; nunca invente; (b) para texto padrão, restaure-o literalmente; (c) para itens de cobertura de pedidos ou de aviso que sejam falso positivo, não altere o texto; (d) preserve a decisão do mérito. Devolva a minuta COMPLETA, terminando em "Nada mais.".` }
      ];
      progress('Corrigindo a minuta...');
      const res = await ask(turns, { tier: $('#rigor').value, onText: ({ text }) => { progress('Corrigindo... ' + fmtInt(text.length) + ' caracteres'); } });
      state.truncated = !!res.truncated;
      finishDraft(res.text, tipo, 'corrigida', true);
      const e = state.check.items.filter(i => i.nivel === 'erro').length;
      toast(e ? `Correção aplicada. Restam ${e} ponto(s) a corrigir.` : 'Correção aplicada. Nenhum ponto obrigatório pendente.', e ? 'warn' : 'ok');
    } catch (e) { toast(errMsg(e), e && e.code === 'cancelled' ? '' : 'err'); }
    finally { setBusy(false); updateButtons(); showDraftUI(); renderConf(); }
  }

  /* ---------- Parecer sobre minuta ---------- */
  async function runParecer() {
    const minuta = $('#minutaIn').value.trim();
    if (!minuta) { toast('Cole ou importe a minuta a analisar.', 'err'); return; }
    setBusy(true, 'Analisando a minuta...');
    const out = $('#parecerOut');
    out.innerHTML = '<p class="muted">O Claude está lendo a minuta e os autos...</p>';
    try {
      const head = `${SYSTEM_INSTRUCTION_ANALYSIS}\n\n=== MINUTA DE SENTENÇA (INÍCIO) ===\n${minuta}\n=== MINUTA DE SENTENÇA (FIM) ===\n\n`;
      const tail = '\n\nProduza o parecer completo na estrutura indicada.';
      let sec = autosSection(byteLen(head + tail) + 1000);
      if (sec.mode === 'insuficiente') {
        progress('Os autos são extensos: criando o fichamento...');
        const ok = await runExtractionInner(true);
        if (!ok) return;
        sec = autosSection(byteLen(head + tail) + 1000);
        if (sec.mode === 'insuficiente') throw Object.assign(new Error('Minuta e autos não cabem em um único envio.'), { code: 'prompt_too_large' });
      }
      if (sec.mode === 'nenhum') sec.text = '=== AUTOS ===\nNão há arquivos de autos carregados. Faça a análise com foco na coerência jurídica intrínseca e na aderência às diretrizes do gabinete, e diga expressamente que a conferência com os autos não foi possível.';
      // conferência determinística da própria minuta
      const ctx = checkCtx('standard');
      if (!readyFiles().length) { ctx.autos = null; ctx.corpusNw = ''; }
      state.parecerChecks = checkDraft(minuta, ctx);
      progress('Analisando a minuta...');
      const res = await ask([{ role: 'user', content: head + sec.text + tail }], { tier: $('#rigor').value, onText: ({ text }) => { progress('Analisando... ' + fmtInt(text.length) + ' caracteres'); out.innerHTML = mdToHtml(text); } });
      state.parecer = res.text;
      renderParecer();
    } catch (e) {
      if (e && e.text) { state.parecer = e.text; renderParecer(); }
      toast(errMsg(e), e && e.code === 'cancelled' ? '' : 'err');
    } finally { setBusy(false); updateButtons(); }
  }
  function renderParecer() {
    const out = $('#parecerOut');
    const pc = state.parecerChecks;
    let html = '';
    if (pc) {
      const e = pc.items.filter(i => i.nivel === 'erro').length, a = pc.items.filter(i => i.nivel === 'aviso').length;
      html += `<details class="det"><summary>Conferência automática da minuta: ${e} a corrigir, ${a} a conferir</summary><ul class="chks">${listChecks(pc.items)}</ul></details>`;
    }
    if (state.parecer) html += `<div class="rich">${mdToHtml(state.parecer)}</div><div class="actions"><button id="btnParecerCopy" class="btn ghost">Copiar parecer</button></div>`;
    out.innerHTML = html;
  }

  /* ---------- Exportação ---------- */
  async function saveFile(filename, data) {
    if (!state.downloads) { toast('Download indisponível neste ambiente. Use "Copiar".', 'err'); return; }
    try { await state.downloads.save({ filename, data }); toast('Arquivo salvo.', 'ok'); }
    catch (e) { if (e && e.code !== 'declined') toast('Não foi possível salvar: ' + (e.message || e.code), 'err'); }
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); toast('Texto copiado.', 'ok'); }
    catch (e) { toast('Seu navegador bloqueou a cópia. Selecione o texto e copie manualmente.', 'err'); }
  }
  async function exportDocx(text, tipo, filename) {
    if (!window.JSZip) { toast('O gerador de DOCX não carregou. Baixe em .txt ou copie o texto.', 'err'); return; }
    try { const blob = await buildDocx(text, tipo, window.JSZip, 'blob'); await saveFile(filename, blob); }
    catch (e) { toast('Falha ao gerar o DOCX: ' + e.message, 'err'); }
  }

  /* ---------- Histórico ---------- */
  function saveHistory(origem) {
    const an = state.analysis || {};
    const item = {
      id: 'h' + Date.now(), ts: Date.now(), tipo: state.draftTipo, origem,
      title: (state.draftTipo === 'ed' ? 'ED - ' : '') + (an.numero_processo || an.reclamante || 'Minuta sem título'),
      meta: { proc: an.numero_processo || '', reclamante: an.reclamante || '', reclamada: an.reclamada || '', materia: an.materia_principal || '' },
      text: state.draft
    };
    state.history.unshift(item);
    state.history = state.history.slice(0, 30);
    if (!lsSet('gd:history', state.history)) { state.history = state.history.slice(0, 8); lsSet('gd:history', state.history); }
    renderHist();
  }
  function renderHist() {
    const box = $('#histBody');
    if (!state.history.length) { box.innerHTML = '<div class="empty"><h3>Histórico vazio</h3><p>As minutas geradas ficam guardadas neste navegador (até 30). Elas não são enviadas a nenhum servidor além do Claude no momento da geração.</p></div>'; return; }
    box.innerHTML = `<ul class="hist">${state.history.map(h => `<li class="hist-item"><div><strong>${esc(h.title)}</strong><span class="muted small">${fmtDateTime(h.ts)} · ${h.tipo === 'ed' ? 'embargos' : 'sentença'} · ${esc(h.origem || '')}${h.meta.reclamada ? ' · ' + esc(h.meta.reclamada) : ''}</span></div><div class="actions"><button class="btn ghost" data-open="${h.id}">Abrir</button><button class="btn ghost" data-del="${h.id}">Excluir</button></div></li>`).join('')}</ul>`;
  }

  /* ---------- Eventos ---------- */
  function bind() {
    // abas
    $$('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('.tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const tabs = $$('.tab'); const i = tabs.findIndex(t => t.dataset.tab === state.activeTab);
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      setTab(n.dataset.tab); n.focus();
    });
    // arquivos
    const fi = $('#fileInput');
    fi.addEventListener('change', () => { if (fi.files.length) ingest(fi.files); fi.value = ''; });
    const dz = $('#drop');
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) ingest(e.dataTransfer.files); });
    $('#fileList').addEventListener('click', (e) => {
      const id = e.target.dataset && e.target.dataset.rm;
      if (id) { state.files = state.files.filter(f => String(f.id) !== id); onAutosChanged(); }
    });
    $('#pasteToggle').addEventListener('click', () => { const b = $('#pasteBox'); b.hidden = !b.hidden; $('#pasteToggle').setAttribute('aria-expanded', String(!b.hidden)); });
    $('#pasteAdd').addEventListener('click', () => {
      const t = $('#pasteText').value.trim();
      if (!t) return;
      const pages = textToBlocks(t);
      state.files.push({ id: ++uid, name: 'Texto colado ' + (state.files.filter(f => f.name.startsWith('Texto colado')).length + 1), kind: 'texto', pages, chars: pages.reduce((a, p) => a + p.text.length, 0), emptyPages: 0, loading: false });
      $('#pasteText').value = ''; $('#pasteBox').hidden = true; $('#pasteToggle').setAttribute('aria-expanded', 'false');
      onAutosChanged();
      autoExtract();
    });
    // diretrizes e opções
    let dirT = null;
    $('#diretrizes').addEventListener('input', () => { updateButtons(); $('#saveState').textContent = 'Salvando...'; clearTimeout(dirT); dirT = setTimeout(() => { saveDirectives(); state.corpusCache.sig = ''; }, 400); });
    [['fSum', 'sumarissimo'], ['fRev', 'revelia'], ['fProc', 'procedenteTotal'], ['fImproc', 'improcedenteTotal']].forEach(([id, k]) => {
      $('#' + id).addEventListener('change', (e) => {
        state.flags[k] = e.target.checked;
        if (e.target.checked && k === 'procedenteTotal') { state.flags.improcedenteTotal = false; $('#fImproc').checked = false; }
        if (e.target.checked && k === 'improcedenteTotal') { state.flags.procedenteTotal = false; $('#fProc').checked = false; }
        saveDirectives();
      });
    });
    $$('input[name=tipo]').forEach(r => r.addEventListener('change', () => { if (r.checked) { state.tipo = r.value; saveDirectives(); } }));
    $('#rigor').addEventListener('change', saveDirectives);
    $('#optExtract').addEventListener('change', saveDirectives);
    // ações
    $('#btnGenerate').addEventListener('click', runGenerate);
    $('#btnStop').addEventListener('click', stopNow);
    $('#btnRefine').addEventListener('click', runRefine);
    $('#btnContinue').addEventListener('click', runContinue);
    $('#btnParecer').addEventListener('click', runParecer);
    $('#btnOpenParecer').addEventListener('click', () => setTab('parecer'));
    // minuta
    $('#btnEdit').addEventListener('click', () => {
      state.editing = !state.editing;
      if (state.editing) $('#editor').value = state.draft;
      else { state.draft = $('#editor').value; paintDraft(state.draft); runChecks(); }
      showDraftUI();
    });
    let edT = null;
    $('#editor').addEventListener('input', () => { clearTimeout(edT); edT = setTimeout(() => { state.draft = $('#editor').value; runChecks(); }, 700); });
    $('#btnCopy').addEventListener('click', () => copyText(state.editing ? $('#editor').value : state.draft));
    $('#btnDocx').addEventListener('click', () => exportDocx(state.editing ? $('#editor').value : state.draft, state.draftTipo, safeFilename(state.analysis, state.draftTipo)));
    // parecer: importar minuta
    $('#minutaFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try { const r = await readAny(f); $('#minutaIn').value = r.pages.map(p => p.text).join('\n'); toast('Minuta importada: ' + f.name, 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    });
    $('#btnUseDraft').addEventListener('click', () => { if (state.draft) { $('#minutaIn').value = state.draft; } else toast('Ainda não há minuta gerada.', 'err'); });
    // delegação nos painéis
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const fl = t.closest('[data-flag]');
      if (fl) { const k = fl.dataset.flag; state.flags[k] = true; $(k === 'sumarissimo' ? '#fSum' : '#fRev').checked = true; saveDirectives(); renderResumo(); toast('Opção marcada.', 'ok'); return; }
      const dl = t.closest('[data-dl]'); if (dl) { state.deadlineFilter = dl.dataset.dl; renderPrazos(); return; }
      const ins = t.closest('[data-ins]');
      if (ins) {
        const p = ($('#prazosBody') || {})._shown[parseInt(ins.dataset.ins, 10)];
        const ta = $('#diretrizes'); const line = `- [${p.tipo.toUpperCase()}]: ${p.data} - ${p.descricao}`;
        ta.value = ta.value.trim() ? ta.value.trim() + '\n' + line : line; saveDirectives(); toast('Inserido nas diretrizes.', 'ok'); return;
      }
      const op = t.closest('[data-open]');
      if (op) { const h = state.history.find(x => x.id === op.dataset.open); if (h) { state.draft = h.text; state.draftTipo = h.tipo; state.truncated = false; state.editing = false; paintDraft(h.text, h.tipo); $('#editor').value = h.text; runChecks(); showDraftUI(); setTab('minuta'); } return; }
      const del = t.closest('[data-del]');
      if (del) { state.history = state.history.filter(x => x.id !== del.dataset.del); lsSet('gd:history', state.history); renderHist(); return; }
      if (t.closest('#btnFix')) { runFix(); return; }
      if (t.closest('#btnRecheck')) { runChecks(); toast('Conferência atualizada.', 'ok'); return; }
      if (t.closest('#btnParecerCopy')) { copyText(state.parecer); return; }
    });
  }

  /* ---------- Inicialização ---------- */
  async function init() {
    loadDirectives();
    state.history = lsGet('gd:history', []);
    bind();
    renderFiles(); renderResumo(); renderPrazos(); renderConf(); renderHist(); showDraftUI(); renderParecer();
    setTab('inicial');
    const st = $('#claudeStatus');
    let tries = 0;
    try {
      if (window.claude && window.claude.use) {
        state.sample = await window.claude.use('sample');
        state.downloads = await window.claude.use('downloads');
      }
    } catch (e) { state.sample = null; }
    if (state.sample) { st.textContent = 'Claude conectado'; st.className = 'status on'; }
    else { st.textContent = 'Claude indisponível aqui'; st.className = 'status off'; toast('Para usar o Claude, abra este artefato dentro do Claude e autorize o uso quando solicitado.', 'warn'); }
    $('#btnDocx').hidden = !state.downloads;
    updateButtons();
  }
  init();
})();
