const assert = require('assert');
const L = require('./bundle.js');
const JSZip = require('jszip');
const mammoth = require('mammoth');
const fs = require('fs');
const { STD } = L;

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FALHA', name, '\n       ', e.message); } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FALHA', name, '\n       ', e.message); } };

// ---------- datas ----------
t('marco prescricional: 14/03/2024 -> 14/03/2019', () => assert.strictEqual(L.marcoPrescricional('14/03/2024'), '14/03/2019'));
t('marco prescricional: 29/02/2024 -> 28/02/2019', () => assert.strictEqual(L.marcoPrescricional('29/02/2024'), '28/02/2019'));
t('marco por extenso', () => assert.strictEqual(L.marcoPrescricional('5 de março de 2024'), '05/03/2019'));
t('data inválida', () => assert.strictEqual(L.marcoPrescricional('31/02/2024'), null));

// ---------- prazos ----------
const txt = `Fica a reclamada notificada para apresentar contestação no prazo de 15 dias. Audiência inicial de conciliação designada para 14/03/2025 às 10h30. Ação ajuizada em 10/01/2024. O reclamante foi admitido em 01/02/2018 e dispensado em 15/12/2023. Prazo de 8 dias úteis para manifestação sobre o laudo pericial. Valor 12/2023 não é data.`;
const pr = L.extractDeadlinesFromText(txt);
t('prazos: contestação urgente', () => assert(pr.some(p => /Contestação/.test(p.descricao) && p.status === 'urgente')));
t('prazos: audiência', () => assert(pr.some(p => p.tipo === 'audiencia' && p.data.startsWith('14/03/2025'))));
t('prazos: distribuição', () => assert(pr.some(p => p.tipo === 'distribuicao' && p.data === '10/01/2024')));
t('prazos: admissão e rescisão', () => assert(pr.some(p => /Admissão/.test(p.descricao)) && pr.some(p => /Rescisão/.test(p.descricao))));
t('prazos: "ro" não vira recurso (bug do original)', () => assert(!pr.some(p => /Recurso/.test(p.descricao))));
t('prazos: manifestação sobre laudo', () => assert(pr.some(p => p.tipo === 'pericia' || /Manifestação/.test(p.descricao))));

// ---------- IDs e blocos ----------
const files = [{
  name: 'autos.pdf', kind: 'pdf', pages: [
    { n: 1, text: 'PROCESSO 0020001-12.2024.5.04.0001 Num. a1b2c3d - Pág. 1 Reclamante: JOÃO DA SILVA. Ajuizada em 10/01/2024. Admitido em 01/02/2018. Dispensado em 15/12/2023. Requer horas extras e adicional noturno. Valor da causa R$ 50.000,00.' },
    { n: 2, text: 'Id. 9f8e7d6 - Pág. 1 TRCT. A testemunha Maria declarou: "trabalhava das oito às dezoito horas com uma hora de intervalo, todos os dias da semana, inclusive aos sábados pela manhã".' },
    { n: 3, text: '' }
  ]
}];
const ix = L.idIndex(files);
t('ids detectados', () => assert(ix.ids.has('a1b2c3d') && ix.ids.has('9f8e7d6')));
t('páginas vazias contadas', () => assert.strictEqual(ix.emptyPages, 1));
t('marcadores nos blocos', () => { const a = L.autosText(files); assert(a.includes('[[fl. 2]]') && a.includes('[[IDs nesta fl.: 9f8e7d6]]') && a.includes('[página sem texto legível]')); });
t('chunk respeita limite', () => { const ch = L.chunkBlocks(['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)], 120); assert(ch.length === 2 && ch.every(c => c.length <= 120)); });
t('chunk divide bloco gigante', () => { const ch = L.chunkBlocks(['x'.repeat(250)], 100); assert(ch.length === 3); });

// ---------- minuta modelo ----------
const corpusRaw = L.stripMarkers(L.autosText(files)) + '\nDiretrizes: deferir horas extras.';
const corpusNw = L.nw(corpusRaw);
const marco = L.marcoPrescricional('10/01/2024');
const good = `PROCESSO Nº 0020001-12.2024.5.04.0001
RECLAMANTE: JOÃO DA SILVA
RECLAMADA(S): EMPRESA EXEMPLO LTDA
VT: 1ª Vara do Trabalho de Porto Alegre

**SENTENÇA**

**I - RELATÓRIO**
João da Silva ajuizou ação contra Empresa Exemplo Ltda., pedindo horas extras (ID. a1b2c3d, fl. 1). A reclamada contestou.
É o relatório.

**II - FUNDAMENTAÇÃO**

**PRESCRIÇÃO**
Considerado o requerimento da reclamada, na forma do art. 7°, XXIX, da CF, pronuncio a prescrição quinquenal das pretensões cuja exigibilidade verificou-se antes de ${marco}, extinguindo o processo com resolução do mérito, no aspecto, conforme o art. 487, II, do CPC.

**HORAS EXTRAS**
A testemunha Maria declarou: *trabalhava das oito às dezoito horas com uma hora de intervalo, todos os dias da semana, inclusive aos sábados pela manhã* (ID. 9f8e7d6, fl. 2). Pelo art. 818 da CLT, cabia ao reclamante o ônus. Defiro as horas extras, com reflexos.

**COMPENSAÇÃO/DEDUÇÃO**
${STD.compensacao}

**RECOLHIMENTOS PREVIDENCIÁRIOS E FISCAIS**
${STD.recolhimentos.join('\n')}

**HONORÁRIOS ADVOCATÍCIOS**
${STD.honorariosReciproca.join('\n')}

**JUROS E CORREÇÃO MONETÁRIA**
${STD.juros}

**III - DISPOSITIVO:**
Ante o exposto, nos termos da fundamentação, que passa a fazer parte deste dispositivo, pronuncio a prescrição quinquenal das parcelas com exigibilidade anterior a ${marco} e julgo PARCIALMENTE PROCEDENTES os pedidos formulados por JOÃO DA SILVA para condenar EMPRESA EXEMPLO LTDA a pagar as seguintes parcelas:
- horas extras e reflexos;
Juros e correção monetária na forma da fundamentação.
Autorizo a dedução dos valores pagos a idêntico título, devidamente comprovados nos autos.
A reclamada deverá recolher as contribuições previdenciárias e fiscais.
Custas pela reclamada no valor de R$ 1.000,00, calculadas sobre o valor atribuído provisoriamente à condenação de R$ 50.000,00, complementáveis ao final.
Intimem-se as partes.
Cumpra-se, após o trânsito em julgado.
Nada mais.`;

const analysis = L.normalizeAnalysis({ numero_processo: '0020001-12.2024.5.04.0001', reclamante: 'JOÃO DA SILVA', reclamada: 'EMPRESA EXEMPLO LTDA', pedidos_inicial: '- Horas extras e reflexos (fl. 1)\n- Adicional noturno (fl. 1)', prescricao_requerida: true, data_admissao: '01/02/2018' });
const ctx = { tipo: 'standard', flags: {}, analysis, autos: ix, corpusNw, corpusRaw, marcoPrescricional: marco, dataAjuizamento: '10/01/2024' };

const r = L.checkDraft(good, ctx);
const erros = r.items.filter(i => i.nivel === 'erro');
t('minuta modelo sem erros', () => assert.strictEqual(erros.length, 0, JSON.stringify(erros, null, 1)));
t('detecta pedido não enfrentado (adicional noturno)', () => assert(r.items.some(i => i.regra === 'Cobertura de pedidos' && i.nivel === 'aviso' && /noturno/i.test(i.detalhe))));
t('citações normativas extraídas', () => { const c = r.citacoes.map(x => x.label); assert(c.includes('Súmula 368 do TST') && c.includes('OJ 400 da SDI-1') && c.includes('ADI 5766')); });
t('custas 2% conferem? (R$1.000 de 50.000)', () => assert(r.items.some(i => i.regra === 'Custas' && i.nivel === 'ok')));

const falha = (nome, mut, regra, nivel = 'erro', c2) => t(`detecta: ${nome}`, () => {
  const rr = L.checkDraft(mut(good), c2 || ctx);
  assert(rr.items.some(i => i.regra === regra && i.nivel === nivel), 'não encontrou ' + regra + ' => ' + JSON.stringify(rr.items.filter(i => i.nivel !== 'ok').map(i => i.regra + ':' + i.detalhe.slice(0, 80))));
});
falha('data de prescrição errada', s => s.replace(marco, '10/01/2020'), 'Prescrição');
falha('ID inventado', s => s.replace('9f8e7d6', 'zz9y8x7'), 'IDs citados');
falha('folha inexistente', s => s.replace('fl. 2', 'fl. 77'), 'Folhas citadas');
falha('citação adulterada', s => s.replace('trabalhava das oito às dezoito horas com uma hora de intervalo, todos os dias da semana, inclusive aos sábados pela manhã', 'trabalhava sempre das sete às vinte e duas horas sem qualquer intervalo para refeição e descanso, nunca folgava'), 'Citações literais');
falha('título em minúsculas', s => s.replace('**HORAS EXTRAS**', '**Horas extras**'), 'Títulos e subtítulos');
falha('título numerado', s => s.replace('**HORAS EXTRAS**', '**1. HORAS EXTRAS**'), 'Títulos e subtítulos');
falha('ordem dos tópicos', s => s.replace('**JUROS E CORREÇÃO MONETÁRIA**', '**HONORÁRIOS PERICIAIS**\n' + STD.periciaA + '\n**JUROS E CORREÇÃO MONETÁRIA**').replace('**HONORÁRIOS ADVOCATÍCIOS**', '**ADICIONAL NOTURNO**\nDefiro.\n**HONORÁRIOS ADVOCATÍCIOS**'), 'Ordem dos tópicos');
falha('compensação alterada', s => s.replace('autoriza', 'x').replace('Entretanto, autorizo', 'Contudo, autorizo'), 'Compensação/dedução');
falha('sem "Nada mais."', s => s.replace('Nada mais.', 'Fim.'), 'Dispositivo');
falha('bolinha no dispositivo', s => s.replace('- horas extras e reflexos;', '• horas extras e reflexos;'), 'Dispositivo');
falha('lacuna não preenchida', s => s.replace('horas extras e reflexos;', '[Parcela 2...]'), 'Lacunas do modelo');
falha('sem É o relatório', s => s.replace('É o relatório.\n', ''), 'Relatório');
falha('custas erradas', s => s.replace('R$ 1.000,00, calculadas', 'R$ 2.500,00, calculadas'), 'Custas', 'aviso');
falha('revelia exige honorários 10%', s => s, 'Honorários advocatícios', 'erro', { ...ctx, flags: { revelia: true } });
falha('sumaríssimo exige dispensa', s => s, 'Relatório (rito sumaríssimo)', 'erro', { ...ctx, flags: { sumarissimo: true } });
falha('improcedência total: capítulos indevidos', s => s, 'Improcedência total', 'erro', { ...ctx, flags: { improcedenteTotal: true } });
falha('cabeçalho', s => s.replace('RECLAMANTE: JOÃO DA SILVA\n', ''), 'Cabeçalho');
falha('alerta de inconsistência vira aviso', s => s.replace('Defiro as horas extras', 'Defiro as horas extras [ALERTA DE INCONSISTÊNCIA: o documento X não consta]'), 'Alerta de inconsistência', 'aviso');
falha('valor fora dos autos', s => s.replace('com reflexos.', 'com reflexos, no valor de R$ 7.777,77.'), 'Valores', 'aviso');

// sumaríssimo correto
const sum = good.replace(/\*\*I - RELATÓRIO\*\*[\s\S]*?É o relatório\./, `${STD.relatorioSumarissimoTitulo}\n\n${STD.relatorioSumarissimo}`);
t('sumaríssimo correto sem erro de relatório', () => { const rr = L.checkDraft(sum, { ...ctx, flags: { sumarissimo: true } }); assert(!rr.items.some(i => /Relatório/.test(i.regra) && i.nivel === 'erro'), JSON.stringify(rr.items.filter(i => /Relatório/.test(i.regra)))); });

// improcedência total correta
const impro = `PROCESSO Nº 0020001-12.2024.5.04.0001
RECLAMANTE: JOÃO DA SILVA
RECLAMADA(S): EMPRESA EXEMPLO LTDA
VT: 1ª Vara do Trabalho de Porto Alegre

SENTENÇA

**I - RELATÓRIO**
Resumo.
É o relatório.

**II - FUNDAMENTAÇÃO**

**HORAS EXTRAS**
Indefiro.

**HONORÁRIOS ADVOCATÍCIOS**
${STD.honorariosImprocedencia}

**III - DISPOSITIVO:**
Ante o exposto, nos termos da fundamentação, que passa a fazer parte deste dispositivo, julgo IMPROCEDENTES os pedidos formulados por JOÃO DA SILVA.
Custas pelo reclamante no valor de R$ 1.000,00, calculadas sobre o valor atribuído à causa de R$ 50.000,00, dispensado do recolhimento.
Intimem-se as partes.
Arquive-se.
Nada mais.`;
t('improcedência total correta sem erros', () => { const rr = L.checkDraft(impro, { ...ctx, flags: {}, analysis: null }); const e = rr.items.filter(i => i.nivel === 'erro'); assert.strictEqual(e.length, 0, JSON.stringify(e)); });

// sentença de embargos
const ed = `ATOrd 0020001-12.2024.5.04.0001
1ª Vara do Trabalho de Porto Alegre
RECLAMANTE: JOÃO DA SILVA
RECLAMADO: EMPRESA EXEMPLO LTDA

SENTENÇA DE EMBARGOS DE DECLARAÇÃO

I - RELATÓRIO
Texto.
É o relatório.

II - FUNDAMENTAÇÃO

ADMISSIBILIDADE
Conheço.

III - DISPOSITIVO
- JULGO IMPROCEDENTES os embargos de declaração opostos por JOÃO.
Intimem-se as partes.
Nada mais.`;
t('embargos: cabeçalho e fim ok', () => { const rr = L.checkDraft(ed, { ...ctx, tipo: 'ed', analysis: null }); assert(!rr.items.some(i => i.nivel === 'erro'), JSON.stringify(rr.items.filter(i => i.nivel === 'erro'))); });

// dados nos autos
t('data nos autos', () => { assert.strictEqual(L.dadoNosAutos('10/01/2024', corpusRaw), true); assert.strictEqual(L.dadoNosAutos('11/01/2024', corpusRaw), false); });
t('nº do processo nos autos', () => assert.strictEqual(L.dadoNosAutos('0020001-12.2024.5.04.0001', corpusRaw), true));

// ensureSentencaHeading / cleanDraft
t('ensureSentencaHeading insere SENTENÇA', () => { const x = L.ensureSentencaHeading('PROCESSO Nº 1\nVT: x\n\n**I - RELATÓRIO**\nTexto', 'standard'); assert(/\*\*SENTENÇA\*\*/.test(x)); });
t('cleanDraft corta após Nada mais.', () => assert.strictEqual(L.cleanDraft('abc\nNada mais.\nDeseja ajustes?'), 'abc\nNada mais.'));
t('parseJsonLoose', () => assert.deepStrictEqual(L.parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 }));
t('instruções contêm textos padrão', () => assert(L.SYSTEM_INSTRUCTION.includes(STD.honorariosImprocedencia) && L.SYSTEM_INSTRUCTION.includes('ADI 5766') && !L.SYSTEM_INSTRUCTION.includes('${')));
t('regras adicionais (revelia)', () => assert(L.regrasAdicionais({ tipo: 'standard', revelia: true }).includes('REVELIA')));
t('html do papel escapa', () => assert(!L.draftToHtml('<script>x</script>').includes('<script>')));

(async () => {
  await ta('DOCX: gera, abre no mammoth e preserva texto', async () => {
    const buf = await L.buildDocx(good, 'standard', JSZip, 'nodebuffer');
    fs.writeFileSync(__dirname + '/amostra.docx', buf);
    const out = await mammoth.extractRawText({ buffer: buf });
    assert(out.value.includes('I - RELATÓRIO') && out.value.includes('HORAS EXTRAS') && out.value.includes('Nada mais.') && !out.value.includes('**'));
  });
  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail ? 1 : 0);
})();
