/* ===== Lógica pura (sem DOM): prazos, marcadores, conferência da minuta, DOCX ===== */

const MESES = { janeiro: 1, fevereiro: 2, marco: 3, 'março': 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };

// normalização "por palavras": minúsculas, sem acentos, só letras/dígitos separados por espaço
function nw(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripMarkers(t) {
  return String(t || '').replace(/\[\[[^\]]*\]\]/g, ' ');
}

/* ---------- Datas ---------- */
function validDate(d, m, y) {
  if (!(y >= 1950 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtBR(o) { return `${pad2(o.d)}/${pad2(o.m)}/${o.y}`; }
function parseBR(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (m[3].length === 2) y += 2000;
    const o = { d: parseInt(m[1], 10), m: parseInt(m[2], 10), y };
    return validDate(o.d, o.m, o.y) ? o : null;
  }
  m = s.match(/(\d{1,2})\s+de\s+([a-zçã]+)\s+de\s+(\d{4})/i);
  if (m) {
    const mes = MESES[m[2].toLowerCase()];
    if (!mes) return null;
    const o = { d: parseInt(m[1], 10), m: mes, y: parseInt(m[3], 10) };
    return validDate(o.d, o.m, o.y) ? o : null;
  }
  return null;
}
// Marco da prescrição quinquenal: cinco anos antes do ajuizamento
function marcoPrescricional(ajuizamento) {
  const o = parseBR(ajuizamento);
  if (!o) return null;
  let d = o.d;
  if (o.m === 2 && o.d === 29) d = 28;
  return fmtBR({ d, m: o.m, y: o.y - 5 });
}
function cmpDate(a, b) {
  return (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
}

/* ---------- Prazos e datas (heurística por texto) ---------- */
function extractDeadlinesFromText(text) {
  if (!text || !text.trim()) return [];
  text = stripMarkers(text);
  const results = [];
  const seen = new Set();
  const add = (data, desc, tipo, status, origem, contexto) => {
    const cleanData = data.trim();
    let cleanDesc = desc.replace(/\s+/g, ' ').trim().replace(/^[-–—:;,.*#]+\s*/, '');
    if (cleanDesc.length > 140) cleanDesc = cleanDesc.slice(0, 137) + '...';
    const key = `${cleanData.toLowerCase()}::${tipo}::${cleanDesc.toLowerCase().slice(0, 25)}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ id: `txt-${results.length}`, data: cleanData, descricao: cleanDesc, tipo, status, origem, contexto });
  };
  const ctxAround = (idx, len, before, after) =>
    text.substring(Math.max(0, idx - before), Math.min(text.length, idx + len + after)).replace(/\s+/g, ' ');

  // 1. prazos em dias/horas
  const prazoRe = /(?:no\s+prazo\s+(?:legal\s+)?de\s+|prazo\s+(?:de\s+)?|com\s+prazo\s+de\s+)(\d{1,3})\s*(dias\s+úteis|dias\s+uteis|dias|dia|horas|hora)(?:[^.\n;]{0,120})/gi;
  let m;
  while ((m = prazoRe.exec(text)) !== null) {
    const dur = `${m[1]} ${m[2]}`;
    const ctx = ctxAround(m.index, m[0].length, 60, 90);
    const lc = ctx.toLowerCase();
    let tipo = 'prazo', status = 'alerta', desc;
    if (/contesta|resposta/.test(lc)) { desc = `Prazo de ${dur} para apresentação de Contestação`; status = 'urgente'; }
    else if (/manifest/.test(lc)) { desc = `Prazo de ${dur} para Manifestação sobre Documentos/Laudo`; }
    else if (/recurs|recorr|ordinário|ordinario/.test(lc)) { desc = `Prazo de ${dur} para Interposição de Recurso`; status = 'urgente'; }
    else if (/emend/.test(lc)) { desc = `Prazo de ${dur} para Emenda à Petição Inicial`; }
    else if (/raz[õo]es\s+finais/.test(lc)) { desc = `Prazo de ${dur} para Razões Finais`; }
    else if (/laudo|per[ií]cia|quesitos/.test(lc)) { desc = `Prazo de ${dur} relativo à Prova Pericial`; tipo = 'pericia'; }
    else { desc = `Prazo processual concedido de ${dur}`; }
    add(dur, desc, tipo, status, 'Texto dos autos', ctx);
  }

  // classifica a data pela palavra-chave MAIS PRÓXIMA antes dela (na mesma frase); se não houver, olha logo depois
  const CATS = [
    { k: 'audiencia', re: /audi[êe]ncia|sess[ãa]o/g },
    { k: 'distribuicao', re: /ajuizad|ajuizamento|distribui[çc][ãa]o|distribu[ií]d|protocolad/g },
    { k: 'prescricao', re: /prescri|bienal|quinquenal/g },
    { k: 'pericia', re: /per[ií]cia|laudo\s+pericial|vistoria|perito/g },
    { k: 'admissao', re: /admiss[ãa]o|admitid|contratad|in[ií]cio\s+do\s+pacto/g },
    { k: 'rescisao', re: /demiss[ãa]o|rescis[ãa]o|afastamento|despedida|dispensad/g },
    { k: 'intimacao', re: /notifica|intima|ci[êe]ncia/g }
  ];
  const lastIdx = (re, str) => { let last = -1, mm; re.lastIndex = 0; while ((mm = re.exec(str)) !== null) last = mm.index; return last; };
  const firstIdx = (re, str) => { re.lastIndex = 0; const mm = re.exec(str); return mm ? mm.index : -1; };
  const classify = (raw, idx, len) => {
    const sStart = Math.max(text.lastIndexOf('. ', idx) + 1, idx - 140, 0);
    const before = text.slice(sStart, idx).toLowerCase();
    let after = text.slice(idx + len, Math.min(text.length, idx + len + 70)).toLowerCase();
    const cut = after.indexOf('. '); if (cut >= 0) after = after.slice(0, cut);
    const ctx = ctxAround(idx, len, 90, 90);
    const lc = (before + ' ' + after);
    let best = null, bestPos = -1;
    for (const c of CATS) { const p = lastIdx(c.re, before); if (p > bestPos) { bestPos = p; best = c.k; } }
    if (!best) {
      let bestAfter = 1e9;
      for (const c of CATS) { const p = firstIdx(c.re, after); if (p >= 0 && p < bestAfter) { bestAfter = p; best = c.k; } }
    }
    if (best === 'audiencia') {
      let desc = 'Audiência Trabalhista designada';
      if (/instru[çc][ãa]o/.test(lc)) desc = 'Audiência de Instrução e Julgamento';
      else if (/concilia[çc][ãa]o|inicial/.test(lc)) desc = 'Audiência Inicial de Conciliação';
      else if (/\buna\b/.test(lc)) desc = 'Audiência Una designada';
      add(raw, desc, 'audiencia', 'urgente', 'Autos', ctx);
    } else if (best === 'distribuicao') add(raw, 'Distribuição / Ajuizamento da Reclamatória Trabalhista', 'distribuicao', 'cumprido', 'Petição Inicial', ctx);
    else if (best === 'prescricao') add(raw, `Marco da Prescrição ${/quinquenal/.test(lc) ? 'Quinquenal' : /bienal/.test(lc) ? 'Bienal' : 'Processual'}`, 'prescricao', 'informativo', 'Autos', ctx);
    else if (best === 'pericia') add(raw, 'Diligência Pericial / Vistoria', 'pericia', 'alerta', 'Autos', ctx);
    else if (best === 'admissao') add(raw, 'Data de Admissão do Trabalhador', 'outro', 'informativo', 'Contrato de Trabalho', ctx);
    else if (best === 'rescisao') add(raw, 'Data da Rescisão / Término Contratual', 'outro', 'informativo', 'Contrato de Trabalho', ctx);
    else if (best === 'intimacao') add(raw, 'Intimação / Notificação Processual', 'prazo', 'alerta', 'Notificação', ctx);
  };

  // 2. datas numéricas
  const dateRe = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:\s+(?:às|as)\s+(\d{1,2}[:h]\d{2}))?\b/gi;
  while ((m = dateRe.exec(text)) !== null) {
    const y = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    if (!validDate(parseInt(m[1], 10), parseInt(m[2], 10), y)) continue;
    const hora = m[4] ? ` às ${m[4].replace('h', ':')}` : '';
    const fmt = `${pad2(m[1])}/${pad2(m[2])}/${y}${hora}`;
    classify(fmt, m.index, m[0].length);
  }
  // 3. datas por extenso
  const extRe = /\b(\d{1,2})\s+de\s+(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})\b/gi;
  while ((m = extRe.exec(text)) !== null) {
    if (!parseBR(m[0])) continue;
    classify(m[0], m.index, m[0].length);
  }

  const peso = { urgente: 0, alerta: 1, informativo: 2, cumprido: 3 };
  return results.sort((a, b) => (peso[a.status] ?? 9) - (peso[b.status] ?? 9));
}

/* ---------- Marcadores nos autos ---------- */
function detectIds(pageText) {
  const ids = new Set();
  const re = /\b(?:id|ID|Id|Num|NUM)\.?\s*[:\-]?\s*([0-9a-z]{7})\b/g;
  let m;
  while ((m = re.exec(String(pageText || ''))) !== null) {
    const v = m[1];
    // sete letras com 3 ou mais vogais costumam ser palavras comuns, não identificadores
    if (/^[a-z]{7}$/.test(v) && (v.match(/[aeiou]/g) || []).length >= 3) continue;
    ids.add(v);
  }
  return [...ids];
}

// file: { name, kind: 'pdf'|'texto', pages: [{n, text}] }   (texto: blocos numerados)
function fileToBlocks(file) {
  const out = [`[[ARQUIVO: ${file.name}]]`];
  for (const p of file.pages) {
    const ids = detectIds(p.text);
    const head = file.kind === 'pdf' ? `[[fl. ${p.n}]]` : `[[bloco ${p.n}]]`;
    const idl = ids.length ? `\n[[IDs nesta fl.: ${ids.join(', ')}]]` : '';
    const body = p.text && p.text.trim() ? p.text.trim() : '[página sem texto legível]';
    out.push(`${head}${idl}\n${body}`);
  }
  return out;
}
function allBlocks(files) {
  return files.flatMap(fileToBlocks);
}
function autosText(files) {
  return allBlocks(files).join('\n');
}
function chunkBlocks(blocks, maxChars) {
  const chunks = [];
  let cur = [];
  let len = 0;
  const push = () => { if (cur.length) { chunks.push(cur.join('\n')); cur = []; len = 0; } };
  for (let b of blocks) {
    while (b.length > maxChars) {
      push();
      chunks.push(b.slice(0, maxChars));
      b = b.slice(maxChars);
    }
    if (len + b.length + 1 > maxChars) push();
    cur.push(b);
    len += b.length + 1;
  }
  push();
  return chunks;
}
function idIndex(files) {
  const map = new Map();
  let maxPage = 0;
  let emptyPages = 0;
  for (const f of files) {
    for (const p of f.pages) {
      if (f.kind === 'pdf') maxPage = Math.max(maxPage, p.n);
      if (!p.text || !p.text.trim()) emptyPages++;
      for (const id of detectIds(p.text)) {
        if (!map.has(id)) map.set(id, new Set());
        map.get(id).add(p.n);
      }
    }
  }
  return { ids: map, maxPage, emptyPages };
}
function byteLen(s) {
  return (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf8');
}

/* ---------- Normalização da minuta ---------- */
function cleanDraft(text) {
  let t = String(text || '').replace(/\r/g, '').trim();
  const i = t.lastIndexOf('Nada mais.');
  if (i !== -1) t = t.substring(0, i + 'Nada mais.'.length).trim();
  return t;
}
function ensureSentencaHeading(text, tipo) {
  if (!text) return text;
  if (tipo === 'ed') return text;
  const rel = /(?:\n|^)(?:\s*[*#_-]*\s*)(?:I\s*[-–—.]\s*)?RELATÓRIO:?/i;
  const m = text.match(rel);
  const has = (s) => /SENTEN[ÇC]A/i.test(s);
  if (m && m.index !== undefined) {
    const before = text.substring(0, m.index);
    if (!has(before)) return before + '\n\n**SENTENÇA**\n\n' + text.substring(m.index).replace(/^\n+/, '');
  } else if (!has(text)) {
    const vt = text.match(/(?:VT|VARA DO TRABALHO):[^\n]+/i);
    if (vt && vt.index !== undefined) {
      const end = vt.index + vt[0].length;
      return text.substring(0, end) + '\n\n**SENTENÇA**\n\n' + text.substring(end);
    }
    return '**SENTENÇA**\n\n' + text;
  }
  return text;
}

/* ---------- Extração de citações normativas ---------- */
function extractCitations(draft) {
  const found = new Map();
  const put = (label, cat) => { if (!found.has(label)) found.set(label, { label, cat, n: 0 }); found.get(label).n++; };
  let m;
  const reS = /S[úu]mulas?\s+(?:n[º°o.]*\s*)?(\d+)(?:\s+(?:do|da)\s+(TST|STF|STJ|TRT\s?\d+))?/gi;
  while ((m = reS.exec(draft)) !== null) put(`Súmula ${m[1]}${m[2] ? ' do ' + m[2].replace(/\s/g, '').toUpperCase() : ''}`, 'Súmula');
  const reOJ = /\bOJ\s*(?:n[º°o.]*\s*)?(\d+)\s*(?:da\s+)?(SDI-?\s?1|SBDI-?\s?1|SDI-?\s?2|SBDI-?\s?2|SDC)?/gi;
  while ((m = reOJ.exec(draft)) !== null) put(`OJ ${m[1]}${m[2] ? ' da ' + m[2].replace(/\s/g, '').toUpperCase() : ''}`, 'Orientação Jurisprudencial');
  const reT = /\bTema\s+(?:n[º°o.]*\s*)?(\d+)(?:\s+(?:do|da)\s+(TST|STF|STJ))?/g;
  while ((m = reT.exec(draft)) !== null) put(`Tema ${m[1]}${m[2] ? ' do ' + m[2] : ''}`, 'Tema vinculante');
  const reA = /\b(ADI|ADPF|ADC|ADO)\s*(?:n[º°o.]*\s*)?(\d+)/g;
  while ((m = reA.exec(draft)) !== null) put(`${m[1]} ${m[2]}`, 'Controle concentrado');
  const reL = /\bLei\s+(Complementar\s+)?n[.º°o]*\s*([\d.]+)\s*\/\s*(\d{4})/gi;
  while ((m = reL.exec(draft)) !== null) put(`Lei ${m[1] ? 'Complementar ' : ''}${m[2]}/${m[3]}`, 'Lei');
  const reArt = /\bart(?:igos?|s?\.)\s*(\d+[A-Za-z]?(?:-[A-Z])?)(?:[^.;\n]{0,60}?)\s+(?:do|da)\s+(CLT|CPC|CF|CC|CP|CPP)\b/gi;
  while ((m = reArt.exec(draft)) !== null) put(`art. ${m[1]} da ${m[2].toUpperCase()}`, 'Artigo');
  return [...found.values()];
}

/* ---------- Dinheiro ---------- */
function parseMoney(s) {
  const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}
function fmtMoney(n) {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ---------- Conferência automática da minuta ---------- */
function quoteSupport(quote, corpusNw) {
  const w = nw(quote).split(' ').filter(Boolean);
  if (w.length < 8) return 1;
  const whole = w.join(' ');
  if (corpusNw.includes(whole)) return 1;
  const size = 6;
  let ok = 0, tot = 0;
  for (let i = 0; i + size <= w.length; i += 3) {
    tot++;
    if (corpusNw.includes(w.slice(i, i + size).join(' '))) ok++;
  }
  return tot ? ok / tot : 1;
}

function headingOf(line) {
  const t = line.trim();
  if (/^#{1,6}\s+/.test(t)) return t.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').replace(/:$/, '').trim();
  const m = t.match(/^\*\*([^*].*?)\*\*:?$/);
  return m ? m[1].trim() : null;
}

const RANK = [
  { k: 'prescricao', re: /^PRESCRI/, rank: 1 },
  { k: 'danos', re: /DANOS?\s+MORAIS?|DANO\s+MORAL/, rank: 3 },
  { k: 'compensacao', re: /^COMPENSA/, rank: 4 },
  { k: 'recolhimentos', re: /^RECOLHIMENTOS?/, rank: 5 },
  { k: 'honadv', re: /^HONOR[ÁA]RIOS\s+ADVOCAT|^HONOR[ÁA]RIOS\s+DE\s+SUCUMB|^JUSTI[ÇC]A\s+GRATUITA|^GRATUIDADE/, rank: 6 },
  { k: 'honper', re: /^HONOR[ÁA]RIOS\s+PERICIAIS/, rank: 7 },
  { k: 'juros', re: /^JUROS/, rank: 8 }
];

// citações entre aspas retas (pareadas por linha), aspas curvas e itálico com asterisco
function extractQuotes(draft) {
  const out = [];
  for (const line of String(draft).split('\n')) {
    const idx = [];
    for (let i = 0; i < line.length; i++) if (line[i] === '"') idx.push(i);
    if (idx.length % 2 === 0) {
      for (let k = 0; k < idx.length; k += 2) {
        const q = line.slice(idx[k] + 1, idx[k + 1]);
        if (q.length >= 40) out.push(q);
      }
    }
    let m;
    const rc = /“([^”\n]{40,})”/g;
    while ((m = rc.exec(line)) !== null) out.push(m[1]);
    const ri = /(?<![*\w])\*(?!\*)([^*\n]{40,}?)(?<!\*)\*(?![*\w])/g;
    while ((m = ri.exec(line)) !== null) out.push(m[1]);
  }
  return out;
}

function checkDraft(draftRaw, ctx) {
  ctx = ctx || {};
  const tipo = ctx.tipo || 'standard';
  const flags = ctx.flags || {};
  const an = ctx.analysis || null;
  const items = [];
  const add = (nivel, regra, detalhe) => items.push({ nivel, regra, detalhe });
  const draft = String(draftRaw || '');
  if (!draft.trim()) return { items, citacoes: [] };
  const lines = draft.replace(/\r/g, '').split('\n');
  const nonEmpty = lines.map((l, i) => ({ l, i })).filter(x => x.l.trim());
  const dnw = nw(draft);

  const findIdx = (re) => lines.findIndex(l => re.test(l.replace(/[*#]/g, '').trim()));
  const iRel = findIdx(/^(?:I\s*[-–—.]?\s*)?RELAT[ÓO]RIO:?$/i);
  const iFun = findIdx(/^(?:II\s*[-–—.]?\s*)?FUNDAMENTA[ÇC][ÃA]O:?$/i);
  const iDis = findIdx(/^(?:III\s*[-–—.]?\s*)?DISPOSITIVO:?$/i);

  // 1. Cabeçalho
  const first = nonEmpty.slice(0, 12).map(x => x.l.replace(/[*#]/g, '').trim());
  if (tipo === 'ed') {
    if (!/^ATOrd\b/i.test(first[0] || '')) add('erro', 'Cabeçalho', 'A minuta de embargos deve começar por "ATOrd [número do processo]".');
    if (!first.some(l => /^SENTEN[ÇC]A DE EMBARGOS DE DECLARA[ÇC][ÃA]O$/i.test(l))) add('erro', 'Cabeçalho', 'Falta o título "SENTENÇA DE EMBARGOS DE DECLARAÇÃO".');
    else add('ok', 'Cabeçalho', 'Cabeçalho de embargos de declaração presente.');
  } else {
    const okProc = /^PROCESSO\s+N[ºo°]/i.test(first[0] || '');
    const okRecl = first.some(l => /^RECLAMANTE:/i.test(l));
    const okRecd = first.some(l => /^RECLAMADAS?(\(S\))?:/i.test(l));
    const okVt = first.some(l => /^VT:/i.test(l));
    const okSent = first.some(l => /^SENTEN[ÇC]A$/i.test(l));
    const falta = [!okProc && 'PROCESSO Nº', !okRecl && 'RECLAMANTE', !okRecd && 'RECLAMADA(S)', !okVt && 'VT', !okSent && '"SENTENÇA" isolada'].filter(Boolean);
    if (falta.length) add('erro', 'Cabeçalho', `Cabeçalho padrão incompleto. Falta: ${falta.join(', ')}.`);
    else add('ok', 'Cabeçalho', 'Cabeçalho padrão completo (processo, reclamante, reclamada, VT e "SENTENÇA").');
  }

  // 2. Capítulos
  if (iRel < 0 || iFun < 0 || iDis < 0 || !(iRel < iFun && iFun < iDis)) {
    const f = [iRel < 0 && 'I - RELATÓRIO', iFun < 0 && 'II - FUNDAMENTAÇÃO', iDis < 0 && 'III - DISPOSITIVO'].filter(Boolean);
    add('erro', 'Estrutura', f.length ? `Capítulo(s) ausente(s): ${f.join(', ')}.` : 'Os capítulos não estão na ordem Relatório, Fundamentação, Dispositivo.');
  } else add('ok', 'Estrutura', 'Relatório, Fundamentação e Dispositivo presentes e em ordem.');

  const relTxt = (iRel >= 0 && iFun > iRel) ? lines.slice(iRel + 1, iFun).join('\n') : '';
  const funLines = (iFun >= 0) ? lines.slice(iFun + 1, iDis > iFun ? iDis : lines.length) : [];
  const funTxt = funLines.join('\n');
  const disTxt = (iDis >= 0) ? lines.slice(iDis).join('\n') : '';
  const disNw = nw(disTxt);

  // resultado
  const improDetect = /julg\w*\s+improcedentes?\b/i.test(disTxt) && !/parcialmente|em\s+parte/i.test(disTxt.split('\n').filter(l => /julg\w*\s+improcedentes?/i.test(l)).join(' '));
  const improTotal = !!flags.improcedenteTotal || improDetect;

  // 3. Relatório
  if (tipo !== 'ed' && iRel >= 0 && iFun > iRel) {
    const rnw = nw(relTxt);
    const temDispensa = rnw.includes(nw(STD.relatorioSumarissimo));
    if (flags.sumarissimo) {
      if (!temDispensa) add('erro', 'Relatório (rito sumaríssimo)', 'O relatório deve ser substituído pelo texto padrão de dispensa (art. 852-I, "caput", da CLT).');
      else if (/\bo\s+relatorio\b/.test(rnw.replace(nw(STD.relatorioSumarissimo), '')) || /e o relatorio/.test(rnw)) add('erro', 'Relatório (rito sumaríssimo)', 'Não deve constar "É o relatório." após o texto de dispensa.');
      else if (rnw.length > nw(STD.relatorioSumarissimo).length + 60) add('erro', 'Relatório (rito sumaríssimo)', 'Há resumo ou histórico além do texto padrão de dispensa.');
      else add('ok', 'Relatório (rito sumaríssimo)', 'Texto padrão de dispensa aplicado.');
    } else {
      if (temDispensa) add('erro', 'Relatório', 'O texto de dispensa do relatório só vale para o rito sumaríssimo, mas a opção não está marcada.');
      else if (!/e o relatorio\s*$/.test(rnw)) add('erro', 'Relatório', 'O relatório do rito ordinário deve terminar com "É o relatório.".');
      else add('ok', 'Relatório', 'Relatório do rito ordinário encerrado com "É o relatório.".');
    }
  }

  // 4. Títulos e subtítulos
  if (tipo !== 'ed' && iFun >= 0) {
    const heads = [];
    funLines.forEach((l, k) => {
      const h = headingOf(l);
      if (h && !/^[-•*]\s/.test(l.trim())) heads.push({ h, line: iFun + 1 + k });
    });
    const probs = [];
    for (const { h } of heads) {
      if (h !== h.toUpperCase()) probs.push(`"${h}" não está em CAIXA ALTA`);
      if (/^(\d+[.)]|[A-Z][.)]\s|TEMA\s+(UM|DOIS|TR[ÊE]S|\d))/i.test(h.replace(/^\s+/, '')) && !/^[IVX]+\s*[-–—]/.test(h)) probs.push(`"${h}" está numerado`);
    }
    // títulos em caixa alta sem negrito
    funLines.forEach((l) => {
      const t = l.trim();
      if (t.length >= 8 && t.length < 90 && t === t.toUpperCase() && /[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{4}/.test(t) && !/[.;]$/.test(t) && !/^\*\*|^#|^\[\[|^[-•*]/.test(t) && !/\d{3}/.test(t)) probs.push(`"${t}" parece título sem negrito`);
    });
    if (probs.length) add('erro', 'Títulos e subtítulos', probs.slice(0, 6).join('; ') + (probs.length > 6 ? '; ...' : '') + '.');
    else if (heads.length) add('ok', 'Títulos e subtítulos', `${heads.length} título(s) em CAIXA ALTA e negrito, sem numeração.`);
    else add('aviso', 'Títulos e subtítulos', 'Nenhum título de tópico (negrito em caixa alta) foi encontrado na fundamentação.');

    // 5. Ordem dos tópicos
    let last = 0, lastName = '';
    const ordemProbs = [];
    const presentes = {};
    for (const { h } of heads) {
      const hu = h.toUpperCase();
      const r = RANK.find(x => x.re.test(hu));
      if (r) {
        presentes[r.k] = true;
        if (r.rank < last) ordemProbs.push(`"${h}" aparece depois de "${lastName}"`);
        else { last = r.rank; lastName = h; }
      } else if (last >= 4 && !/^(ADMISSIBILIDADE|PRELIMINAR)/.test(hu)) {
        ordemProbs.push(`o tema "${h}" aparece depois de "${lastName}" (temas de mérito vêm antes de compensação, recolhimentos, honorários e juros)`);
      }
    }
    if (ordemProbs.length) add('erro', 'Ordem dos tópicos', ordemProbs.slice(0, 4).join('; ') + '.');
    else add('ok', 'Ordem dos tópicos', 'Sequência dos tópicos de acordo com a ordem obrigatória.');

    // 6/7. Improcedência total x capítulos e textos padrão
    const funNw = nw(funTxt + '\n' + disTxt);
    if (improTotal) {
      const indevidos = ['compensacao', 'recolhimentos', 'juros'].filter(k => presentes[k]);
      if (indevidos.length) add('erro', 'Improcedência total', `Capítulo(s) indevido(s) em caso de improcedência total: ${indevidos.join(', ')}.`);
      else add('ok', 'Improcedência total', 'Sem os capítulos de compensação, recolhimentos e juros.');
      if (!funNw.includes(nw(STD.honorariosImprocedencia))) add('erro', 'Honorários (improcedência)', 'Falta o texto padrão de honorários para total improcedência.');
      if (!/arquive-se/i.test(disTxt)) add('erro', 'Dispositivo', 'Na improcedência total o dispositivo deve terminar com "Arquive-se.".');
      if (!/custas pelo reclamante/i.test(disTxt)) add('erro', 'Dispositivo', 'Na improcedência total: "Custas pelo reclamante ... dispensado do recolhimento".');
    } else {
      if (presentes.compensacao && !funNw.includes(nw(STD.compensacao))) add('erro', 'Compensação/dedução', 'O texto padrão foi alterado.');
      if (presentes.recolhimentos) {
        const falt = STD.recolhimentos.map((p, i) => funNw.includes(nw(p)) ? null : i + 1).filter(Boolean);
        if (falt.length) add('erro', 'Recolhimentos previdenciários e fiscais', `Texto padrão alterado ou incompleto (parágrafo(s) ${falt.join(', ')}).`);
      }
      if (presentes.juros && !funNw.includes(nw(STD.juros))) add('erro', 'Juros e correção monetária', 'O texto padrão foi alterado.');
      const faltam = [!presentes.compensacao && 'COMPENSAÇÃO/DEDUÇÃO', !presentes.recolhimentos && 'RECOLHIMENTOS PREVIDENCIÁRIOS E FISCAIS', !presentes.juros && 'JUROS E CORREÇÃO MONETÁRIA'].filter(Boolean);
      if (faltam.length) add('aviso', 'Capítulos obrigatórios', `Capítulo(s) ausente(s) (obrigatórios quando há condenação): ${faltam.join(', ')}.`);
      // honorários
      const hasTotal = funNw.includes(nw(STD.honorariosTotal));
      const hasRec = STD.honorariosReciproca.every(p => funNw.includes(nw(p)));
      if (flags.revelia || flags.procedenteTotal) {
        if (!hasTotal) add('erro', 'Honorários advocatícios', 'Com revelia ou procedência total, usar exclusivamente o texto padrão de 10% sobre a condenação.');
        else if (/sucumb[êe]ncia\s+rec[íi]proca/i.test(funTxt + disTxt)) add('erro', 'Honorários advocatícios', 'Há menção a sucumbência recíproca, incompatível com revelia/procedência total.');
        else add('ok', 'Honorários advocatícios', 'Texto padrão (revelia/procedência total) aplicado.');
      } else if (!hasTotal && !hasRec) {
        add('erro', 'Honorários advocatícios', 'Nenhum dos textos padrão de honorários (item 5) foi aplicado literalmente.');
      } else add('ok', 'Honorários advocatícios', 'Texto padrão de honorários aplicado.');
    }
    // perícia
    if (presentes.honper && !(nw(funTxt).includes(nw(STD.periciaA)) || nw(funTxt).includes(nw(STD.periciaB)))) add('erro', 'Honorários periciais', 'Nenhuma das opções do texto padrão (A ou B) foi aplicada literalmente.');
    // justiça gratuita
    if (/benef[íi]cio da justi[çc]a gratuita/i.test(funTxt + disTxt)) {
      const g1 = nw(STD.gratuita1).split(' (id')[0];
      if (!nw(funTxt).includes(g1.slice(0, 140))) add('erro', 'Justiça gratuita', 'O primeiro parágrafo padrão da justiça gratuita foi alterado.');
      if (flags.revelia && /Cabia ao reclamado o ônus de provar que o reclamante não ostentava/i.test(funTxt)) add('erro', 'Justiça gratuita', 'Com revelia da reclamada, o segundo parágrafo ("Cabia ao reclamado...") deve ser omitido.');
    }
    // prescrição
    if (presentes.prescricao) {
      const pre = nw(STD.prescricao).split(' antes de ')[0];
      if (!nw(funTxt).includes(pre)) add('erro', 'Prescrição', 'O texto padrão da prescrição quinquenal foi alterado.');
      const mm = funTxt.match(/exigibilidade\s+verificou-se\s+antes\s+de\s+([^,]+),/i);
      if (mm && ctx.marcoPrescricional) {
        const d = parseBR(mm[1]);
        if (!d) add('aviso', 'Prescrição', `Data da prescrição não reconhecida: "${mm[1].trim()}".`);
        else if (fmtBR(d) !== ctx.marcoPrescricional) add('erro', 'Prescrição', `A data pronunciada (${fmtBR(d)}) difere do marco calculado (${ctx.marcoPrescricional}), cinco anos antes do ajuizamento.`);
        else add('ok', 'Prescrição', `Marco ${ctx.marcoPrescricional} confere com o ajuizamento (${ctx.dataAjuizamento}).`);
      }
      if (an && an.prescricao_requerida === false && ctx.marcoPrescricional && an.data_admissao) {
        const adm = parseBR(an.data_admissao), mar = parseBR(ctx.marcoPrescricional);
        if (adm && mar && cmpDate(adm, mar) >= 0) add('aviso', 'Prescrição', 'Os dados extraídos indicam que não houve requerimento e que o contrato começou depois do marco; o tópico pode ser indevido.');
      }
    } else if (an && an.prescricao_requerida === true) {
      add('aviso', 'Prescrição', 'Os dados extraídos indicam requerimento de prescrição, mas a minuta não tem o tópico PRESCRIÇÃO.');
    }
  }

  // 8. Dispositivo
  if (iDis >= 0) {
    const dl = lines.slice(iDis + 1);
    const badBullets = dl.filter(l => /^\s*[•·▪●◦‣–—]\s/.test(l) || /^\s*\*\s(?!\*)/.test(l));
    if (badBullets.length) add('erro', 'Dispositivo', 'Listas do dispositivo devem usar somente traço (-); foram encontrados outros marcadores.');
    const lastLine = nonEmpty[nonEmpty.length - 1]?.l.trim() || '';
    if (lastLine !== 'Nada mais.') add('erro', 'Dispositivo', 'A última linha deve ser exatamente "Nada mais.".');
    if (tipo !== 'ed') {
      if (!/Ante o exposto, nos termos da fundamenta[çc][ãa]o, que passa a fazer parte deste dispositivo/i.test(disTxt)) add('aviso', 'Dispositivo', 'Falta a abertura padrão "Ante o exposto, nos termos da fundamentação...".');
      if (!/Intimem-se/i.test(disTxt)) add('aviso', 'Dispositivo', 'Falta "Intimem-se as partes".');
      if (!improTotal) {
        if (!/Custas pela reclamada/i.test(disTxt)) add('aviso', 'Dispositivo', 'Falta a linha de custas pela reclamada.');
        if (!/Cumpra-se, ap[óo]s o tr[âa]nsito em julgado/i.test(disTxt)) add('aviso', 'Dispositivo', 'Falta "Cumpra-se, após o trânsito em julgado.".');
        if (!/Autorizo a dedu[çc][ãa]o dos valores pagos a id[êe]ntico t[íi]tulo/i.test(disTxt)) add('aviso', 'Dispositivo', 'Falta "Autorizo a dedução dos valores pagos a idêntico título...".');
        if (!/recolher as contribui[çc][õo]es previdenci[áa]rias e fiscais/i.test(disTxt)) add('aviso', 'Dispositivo', 'Falta o parágrafo sobre recolhimento das contribuições previdenciárias e fiscais.');
      }
      // custas = 2%
      const c = disTxt.match(/Custas\s+pel[oa]\s+(?:reclamante|reclamada)[^$]*\$\s*([\d.]+,\d{2})[^$]*\$\s*([\d.]+,\d{2})/i);
      if (c) {
        const v = parseMoney(c[1]), base = parseMoney(c[2]);
        if (v != null && base != null) {
          const esp = Math.round(base * 0.02 * 100) / 100;
          if (Math.abs(v - esp) > 0.011 && Math.abs(v - 10.64) > 0.011) add('aviso', 'Custas', `Custas de R$ ${c[1]} sobre base de R$ ${c[2]}: 2% seriam R$ ${fmtMoney(esp)} (art. 789 da CLT; confira mínimo e teto).`);
          else add('ok', 'Custas', 'Custas conferem com 2% da base informada.');
        }
      }
    }
  }

  // 9. Lacunas não preenchidas
  const lac = [];
  const lacRe = /\[([^\]\n]{0,160})\]/g;
  let m;
  while ((m = lacRe.exec(draft)) !== null) {
    const inside = m[1];
    if (/^ALERTA DE INCONSIST/i.test(inside)) continue;
    if (/XX|DATA|Parcela|Obriga[çc][ãa]o|NOME DO|SE HOUVER|SE FOR|OU SE|INCLUIR|Inserir|PARCIALMENTE|Reclamante\/Reclamada|omiss[õo]es|sem atribui|sem imprimir/i.test(inside)) lac.push(m[0]);
  }
  if (/\bx{7}\b/i.test(draft)) lac.push('ID "xxxxxxx"');
  if (lac.length) add('erro', 'Lacunas do modelo', `Há trechos de modelo não preenchidos: ${lac.slice(0, 4).join(' | ')}${lac.length > 4 ? ' ...' : ''}`);
  else add('ok', 'Lacunas do modelo', 'Nenhuma lacuna [ ] do modelo ficou sem preencher.');

  // 10. Alertas de inconsistência
  const alerts = draft.match(/\[ALERTA DE INCONSIST[^\]]*\]/gi) || [];
  alerts.forEach(a => add('aviso', 'Alerta de inconsistência', a.replace(/^\[|\]$/g, '')));

  // 11. Gerundismo
  const ger = draft.match(/\b(?:vou|vamos|irei|iremos)\s+estar\s+\w+ndo\b/gi);
  if (ger) add('aviso', 'Linguagem', `Gerundismo: "${ger[0]}".`);

  // 12. IDs e folhas
  if (ctx.autos) {
    const ix = ctx.autos;
    if (ix.ids.size > 0) {
      const cited = new Set();
      const reId = /\bID\.?\s*[:\-]?\s*([0-9a-z]{7})\b/g;
      while ((m = reId.exec(draft)) !== null) { if (!/^x{7}$/i.test(m[1])) cited.add(m[1]); }
      const missing = [...cited].filter(id => !ix.ids.has(id));
      if (missing.length) add('erro', 'IDs citados', `ID(s) que não aparecem nos autos enviados: ${missing.join(', ')}. Possível invenção; confira antes de usar.`);
      else if (cited.size) add('ok', 'IDs citados', `${cited.size} ID(s) citado(s), todos localizados nos autos.`);
      else add('aviso', 'IDs citados', 'A minuta não cita nenhum ID de documento (formato "ID. xxxxxxx, fl. N").');
    } else {
      add('aviso', 'IDs citados', 'Não foi possível detectar IDs nos autos enviados; a conferência de IDs não foi feita.');
    }
    if (ix.maxPage > 0) {
      const over = [];
      const reFl = /\bfls?\.\s*(\d+)(?:\s*[-–a]\s*(\d+))?/gi;
      while ((m = reFl.exec(draft)) !== null) {
        const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
        if (a > ix.maxPage || b > ix.maxPage) over.push(m[0]);
      }
      if (over.length) add('erro', 'Folhas citadas', `Folha(s) além do total de páginas dos PDFs (${ix.maxPage}): ${[...new Set(over)].slice(0, 6).join(', ')}.`);
    }
  }

  // 13. Citações literais, valores, nomes
  if (ctx.corpusNw) {
    const quotes = extractQuotes(draft);
    const std = nw(Object.values(STD).flat().join(' '));
    const sem = [];
    for (const q of quotes.slice(0, 60)) {
      if (std.includes(nw(q))) continue;
      const s = quoteSupport(q, ctx.corpusNw);
      if (s < 0.7) sem.push(q.length > 90 ? q.slice(0, 87) + '...' : q);
    }
    if (sem.length) add('erro', 'Citações literais', `${sem.length} citação(ões) entre aspas/itálico não localizada(s) nos autos: ${sem.slice(0, 3).map(s => `"${s}"`).join(' | ')}${sem.length > 3 ? ' ...' : ''}`);
    else if (quotes.length) add('ok', 'Citações literais', `${quotes.length} citação(ões) literal(is) localizada(s) nos autos.`);

    const amtRe = /R\$\s*([\d.]+,\d{2})/g;
    const stdAmts = new Set(['3.000,00', '1.500,00']);
    const corpusAmts = new Set((ctx.corpusRaw || '').match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || []);
    const novos = new Set();
    while ((m = amtRe.exec(draft)) !== null) {
      if (!corpusAmts.has(m[1]) && !stdAmts.has(m[1])) novos.add(m[1]);
    }
    if (novos.size) add('aviso', 'Valores', `Valores em R$ que não constam literalmente dos autos nem das diretrizes (podem ser cálculo; confira): ${[...novos].slice(0, 8).join(', ')}.`);
  }
  if (an) {
    const h = nw(first.join(' '));
    if (tipo !== 'ed') {
      if (an.reclamante && !h.includes(nw(an.reclamante).split(' ').slice(0, 2).join(' '))) add('aviso', 'Cabeçalho', `O nome do reclamante extraído ("${an.reclamante}") não aparece no cabeçalho.`);
      if (an.numero_processo) {
        const dig = (s) => String(s).replace(/\D/g, '');
        if (dig(an.numero_processo) && !dig(first.join(' ')).includes(dig(an.numero_processo))) add('aviso', 'Cabeçalho', `O número do processo extraído (${an.numero_processo}) não aparece no cabeçalho.`);
      }
    }
    // cobertura de pedidos
    if (an.pedidos_inicial) {
      const stop = new Set(['pedido', 'pagamento', 'valor', 'reclamante', 'reclamada', 'diferencas', 'condenacao', 'devido', 'devida', 'tempo', 'periodo', 'contrato', 'trabalho', 'sobre', 'forma', 'parcelas', 'verbas', 'conforme']);
      const faltando = [];
      for (const raw of String(an.pedidos_inicial).split('\n').slice(0, 40)) {
        const txt = raw.replace(/^\s*[-•*\d.)]+\s*/, '').replace(/\((?:fl|ID)[^)]*\)/gi, '').trim();
        if (txt.length < 8) continue;
        const toks = [...new Set(nw(txt).split(' ').filter(w => w.length >= 5 && !stop.has(w)))].slice(0, 6);
        if (toks.length < 1) continue;
        const hit = toks.filter(w => dnw.includes(w)).length / toks.length;
        if (hit < 0.5) faltando.push(txt.length > 100 ? txt.slice(0, 97) + '...' : txt);
      }
      if (faltando.length) add('aviso', 'Cobertura de pedidos', `Pedido(s) da inicial que talvez não tenham sido enfrentados (heurística por palavras-chave): ${faltando.slice(0, 5).map(s => `"${s}"`).join(' | ')}${faltando.length > 5 ? ' ...' : ''}`);
      else add('ok', 'Cobertura de pedidos', 'Os pedidos extraídos da inicial aparecem na minuta (heurística por palavras-chave).');
    }
  }

  return { items, citacoes: extractCitations(draft) };
}

/* ---------- Normalização do JSON de extração ---------- */
function normalizeAnalysis(a) {
  a = a && typeof a === 'object' ? a : {};
  const s = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(x => '- ' + x).join('\n') : v == null ? '' : String(v));
  const b = (v) => (v === true || v === false) ? v : null;
  const j = a.jurisprudencia && typeof a.jurisprudencia === 'object' ? a.jurisprudencia : {};
  const prazos = Array.isArray(a.prazos_processuais) ? a.prazos_processuais : [];
  return {
    numero_processo: s(a.numero_processo), reclamante: s(a.reclamante), reclamada: s(a.reclamada), vt: s(a.vt),
    materia_principal: s(a.materia_principal),
    rito: ['sumaríssimo', 'ordinário', 'não identificado'].includes(a.rito) ? a.rito : 'não identificado',
    revelia: b(a.revelia),
    data_ajuizamento: s(a.data_ajuizamento), data_admissao: s(a.data_admissao), data_rescisao: s(a.data_rescisao),
    prescricao_requerida: b(a.prescricao_requerida),
    alegacoes_inicial: s(a.alegacoes_inicial), pedidos_inicial: s(a.pedidos_inicial),
    alegacoes_contestacao: s(a.alegacoes_contestacao), pedidos_contestacao: s(a.pedidos_contestacao),
    provas_autor: s(a.provas_autor), provas_reclamada: s(a.provas_reclamada), analise_provas: s(a.analise_provas),
    provas_produzidas: s(a.provas_produzidas),
    jurisprudencia: { trt4: s(j.trt4), tst: s(j.tst), stf: s(j.stf) },
    prazos_processuais: prazos.filter(p => p && (p.data || p.descricao)).map((p, i) => ({
      id: `ia-${i}`, data: s(p.data) || 'Data nos autos', descricao: s(p.descricao) || 'Prazo processual relevante',
      tipo: PRAZOS_TIPOS.includes(p.tipo) ? p.tipo : 'outro',
      status: ['urgente', 'alerta', 'cumprido', 'informativo'].includes(p.status) ? p.status : 'alerta',
      origem: s(p.fonte) || 'Análise por IA'
    })),
    alertas: Array.isArray(a.alertas) ? a.alertas.map(s).filter(Boolean) : []
  };
}
function parseJsonLoose(raw) {
  let t = String(raw || '').trim();
  const a = t.indexOf('{'), z = t.lastIndexOf('}');
  if (a === -1 || z === -1) throw new Error('Resposta sem JSON.');
  t = t.slice(a, z + 1);
  try { return JSON.parse(t); } catch (e) {
    return JSON.parse(t.replace(/[\u0000-\u001F]+/g, ' '));
  }
}
// verifica se um dado extraído consta literalmente nos autos
function dadoNosAutos(valor, corpusRaw) {
  if (!valor) return null;
  const v = String(valor).trim();
  if (!v) return null;
  const digits = v.replace(/\D/g, '');
  if (/^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(v)) {
    const o = parseBR(v);
    if (!o) return false;
    const re = new RegExp(`\\b0?${o.d}[\\/.\\-]0?${o.m}[\\/.\\-](?:${o.y}|${String(o.y).slice(2)})\\b`);
    if (re.test(corpusRaw)) return true;
    const mes = Object.keys(MESES).find(k => MESES[k] === o.m && !k.includes('ç'));
    return new RegExp(`\\b0?${o.d}\\s+de\\s+${mes === 'marco' ? 'mar[çc]o' : mes}\\s+de\\s+${o.y}\\b`, 'i').test(corpusRaw);
  }
  if (digits.length >= 10) return corpusRaw.replace(/\D/g, '').includes(digits);
  return nw(corpusRaw).includes(nw(v));
}

/* ---------- Renderização leve de texto ---------- */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function inlineMd(s) {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
}
function mdToHtml(md) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
    const l = raw.trimEnd();
    if (!l.trim()) { close(); continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { close(); const lv = Math.min(m[1].length + 2, 6); out.push(`<h${lv}>${inlineMd(m[2])}</h${lv}>`); continue; }
    if ((m = l.match(/^\s*[-*•]\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inlineMd(m[1])}</li>`); continue; }
    if ((m = l.match(/^\s*(\d+)[.)]\s+(.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inlineMd(m[2])}</li>`); continue; }
    close();
    out.push(`<p>${inlineMd(l)}</p>`);
  }
  close();
  return out.join('\n');
}
// Papel da minuta: preserva a formatação jurídica
function draftToHtml(text, tipo) {
  const lines = ensureSentencaHeading(String(text || ''), tipo).replace(/\r/g, '').split('\n');
  const out = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    const plain = l.replace(/[*#]/g, '').trim();
    const up = plain.toUpperCase();
    if (/^(SENTEN[ÇC]A|SENTEN[ÇC]A DE EMBARGOS DE DECLARA[ÇC][ÃA]O)$/.test(up)) { out.push(`<h1 class="p-sent">${esc(plain)}</h1>`); continue; }
    if (headingOf(l)) { out.push(`<h2 class="p-tit">${esc(headingOf(l))}</h2>`); continue; }
    if (/^(PROCESSO\s+N|RECLAMANTE:|RECLAMADAS?(\(S\))?:|RECLAMADO:|VT:|ATOrd\b)/i.test(plain)) { out.push(`<p class="p-cab">${inlineMd(l)}</p>`); continue; }
    if (/^(I\s*[-–—]\s*RELAT|II\s*[-–—]\s*FUNDAMENTA|III\s*[-–—]\s*DISPOSITIVO)/i.test(plain)) { out.push(`<h2 class="p-tit">${esc(plain.replace(/:$/, ''))}</h2>`); continue; }
    if (/^-\s+/.test(l)) { out.push(`<p class="p-item">${inlineMd(l)}</p>`); continue; }
    let h = inlineMd(l);
    h = h.replace(/\[ALERTA DE INCONSIST[^\]]*\]/gi, (x) => `<mark class="p-alerta">${x}</mark>`);
    out.push(`<p>${h}</p>`);
  }
  return out.join('\n');
}

/* ---------- DOCX (sem dependências além do JSZip) ---------- */
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function docxRuns(line, forceBold) {
  const runs = [];
  let cur = '', bold = false, ital = false;
  const flush = () => {
    if (!cur) return;
    runs.push(`<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${(bold || forceBold) ? '<w:b/>' : ''}${ital ? '<w:i/>' : ''}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">${xmlEsc(cur)}</w:t></w:r>`);
    cur = '';
  };
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '*' && line[i + 1] === '*') { flush(); bold = !bold; i++; }
    else if (line[i] === '*') { flush(); ital = !ital; }
    else cur += line[i];
  }
  flush();
  return runs.join('');
}

function docxBody(text, tipo) {
  const lines = ensureSentencaHeading(cleanDraft(text), tipo).split('\n');
  const paras = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let p = line.trim().replace(/^#{1,6}\s+/, '');
    const normalized = p.replace(/[*#]/g, '').trim().toUpperCase();
    let isHeader = false;
    if (/^(I\s*[-–—]?\s*)?RELAT[ÓO]RIO:?$/.test(normalized)) { p = 'I - RELATÓRIO'; isHeader = true; }
    else if (/^(II\s*[-–—]?\s*)?FUNDAMENTA[ÇC][ÃA]O:?$/.test(normalized)) { p = 'II - FUNDAMENTAÇÃO'; isHeader = true; }
    else if (/^(III\s*[-–—]?\s*)?DISPOSITIVO:?$/.test(normalized)) { p = 'III - DISPOSITIVO'; isHeader = true; }
    else if (/^\*\*\s*\d+(\.\d+)*[.)\-]\s*/.test(p)) p = p.replace(/^\*\*\s*\d+(\.\d+)*[.)\-]\s*/, '**');
    const isSent = /^SENTEN[ÇC]A( DE EMBARGOS DE DECLARA[ÇC][ÃA]O)?$/.test(normalized);
    const isCab = /^(PROCESSO\s+N|RECLAMANTE:|RECLAMADAS?(\(S\))?:|RECLAMADO:|VT:|ATOrd\b)/i.test(normalized);
    const isBoldLine = /^\*\*[^*].*\*\*:?$/.test(p);
    const isTitle = isHeader || isSent || isBoldLine || (p === p.toUpperCase() && p.length > 5 && p.length < 100 && /[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{4}/.test(p) && !/^[-•]/.test(p));
    const spacing = (isTitle && !isCab) ? '<w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/>' : '<w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/>';
    const ind = (isSent || isCab || isTitle) ? '' : '<w:ind w:firstLine="850"/>';
    const jc = isSent ? 'center' : (isCab ? 'left' : 'both');
    paras.push(`<w:p><w:pPr>${spacing}${ind}<w:jc w:val="${jc}"/></w:pPr>${docxRuns(p, isTitle)}</w:p>`);
  }
  return paras.join('');
}

async function buildDocx(text, tipo, JSZipCtor, outType) {
  const zip = new JSZipCtor();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${tipo === 'ed' ? 'Minuta de Sentença de Embargos de Declaração' : 'Minuta de Sentença Trabalhista'}</dc:title><dc:creator>Gabinete Digital</dc:creator></cp:coreProperties>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${docxBody(text, tipo)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: outType || 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function safeFilename(analysis, tipo) {
  const a = analysis || {};
  const parts = [a.numero_processo || (tipo === 'ed' ? 'Embargos' : 'Processo'), (a.reclamada || 'Reclamada').toUpperCase(), a.materia_principal || (tipo === 'ed' ? 'Embargos de Declaração' : 'Sentença')];
  return parts.join(' - ').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150) + '.docx';
}

if (typeof module !== 'undefined') {
  module.exports = { extractQuotes, nw, stripMarkers, parseBR, fmtBR, marcoPrescricional, extractDeadlinesFromText, detectIds, fileToBlocks, allBlocks, autosText, chunkBlocks, idIndex, byteLen, cleanDraft, ensureSentencaHeading, extractCitations, checkDraft, normalizeAnalysis, parseJsonLoose, dadoNosAutos, mdToHtml, draftToHtml, buildDocx, safeFilename, quoteSupport, parseMoney, fmtMoney, headingOf };
}
