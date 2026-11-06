export interface PrazoProcessual {
  id: string;
  data: string;
  descricao: string;
  tipo: 'audiencia' | 'prazo' | 'prescricao' | 'distribuicao' | 'pericia' | 'outro';
  status: 'urgente' | 'alerta' | 'cumprido' | 'informativo';
  origem?: string;
  contexto?: string;
}

export function extractDeadlinesFromText(text: string): PrazoProcessual[] {
  if (!text || text.trim().length === 0) return [];

  const results: PrazoProcessual[] = [];
  const seenKeys = new Set<string>();

  const addResult = (
    dataStr: string,
    descStr: string,
    tipo: PrazoProcessual['tipo'],
    status: PrazoProcessual['status'],
    origem: string = 'Texto da Petição',
    contexto?: string
  ) => {
    const cleanData = dataStr.trim();
    let cleanDesc = descStr.replace(/\s+/g, ' ').trim();
    cleanDesc = cleanDesc.replace(/^[-–—:;,.*#]+\s*/, '');
    if (cleanDesc.length > 140) {
      cleanDesc = cleanDesc.slice(0, 137) + '...';
    }
    const key = `${cleanData.toLowerCase()}::${tipo}::${cleanDesc.toLowerCase().slice(0, 25)}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      results.push({
        id: `prazo-${Date.now()}-${results.length}-${Math.random().toString(36).substring(2, 6)}`,
        data: cleanData,
        descricao: cleanDesc,
        tipo,
        status,
        origem,
        contexto
      });
    }
  };

  // 1. Procedural timeframes: e.g. "prazo de 15 dias", "no prazo de 5 dias úteis", "com prazo de 8 dias"
  const prazoRegex = /(?:no\s+prazo\s+de\s+|prazo\s+(?:de\s+)?|com\s+prazo\s+de\s+|no\s+prazo\s+legal\s+de\s+)(\d+)\s*(dias|dia|dias\s+úteis|dias\s+uteis|horas|hora)(?:[^\.\n;]{0,120})/gi;
  let match: RegExpExecArray | null;
  while ((match = prazoRegex.exec(text)) !== null) {
    const fullMatch = match[0];
    const duration = `${match[1]} ${match[2]}`;
    const startIdx = Math.max(0, match.index - 60);
    const endIdx = Math.min(text.length, match.index + fullMatch.length + 90);
    const context = text.substring(startIdx, endIdx).replace(/\s+/g, ' ');

    let tipo: PrazoProcessual['tipo'] = 'prazo';
    let status: PrazoProcessual['status'] = 'alerta';
    let desc = fullMatch;

    const lowerCtx = context.toLowerCase();
    if (lowerCtx.includes('contestação') || lowerCtx.includes('contestar') || lowerCtx.includes('resposta')) {
      desc = `Prazo de ${duration} para apresentação de Contestação`;
      status = 'urgente';
    } else if (lowerCtx.includes('manifestação') || lowerCtx.includes('manifestar')) {
      desc = `Prazo de ${duration} para Manifestação sobre Documentos/Laudo`;
    } else if (lowerCtx.includes('recurso') || lowerCtx.includes('recorrer') || lowerCtx.includes('ro') || lowerCtx.includes('ordinário')) {
      desc = `Prazo de ${duration} para Interposição de Recurso`;
      status = 'urgente';
    } else if (lowerCtx.includes('emenda') || lowerCtx.includes('emendar')) {
      desc = `Prazo de ${duration} para Emenda à Petição Inicial`;
      status = 'alerta';
    } else if (lowerCtx.includes('razões finais') || lowerCtx.includes('razoes finais')) {
      desc = `Prazo de ${duration} para Apresentação de Razões Finais`;
    } else if (lowerCtx.includes('laudo') || lowerCtx.includes('perícia') || lowerCtx.includes('pericia') || lowerCtx.includes('quesitos')) {
      desc = `Prazo de ${duration} relativo à Prova Pericial`;
      tipo = 'pericia';
    } else {
      desc = `Prazo processual concedido de ${duration}`;
    }

    addResult(duration, desc, tipo, status, 'Petição / Autos', context);
  }

  // 2. Specific calendar dates with day/month/year: DD/MM/AAAA or DD-MM-AAAA
  const dateRegex = /\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})(?:\s+(?:às|as)\s+(\d{1,2}[:h]\d{2}))?\b/gi;
  while ((match = dateRegex.exec(text)) !== null) {
    const rawDate = match[0];
    const timePart = match[4] ? ` às ${match[4].replace('h', ':')}` : '';
    const dateFormatted = `${match[1].padStart(2, '0')}/${match[2].padStart(2, '0')}/${match[3].length === 2 ? '20' + match[3] : match[3]}${timePart}`;
    const startIdx = Math.max(0, match.index - 90);
    const endIdx = Math.min(text.length, match.index + rawDate.length + 90);
    const context = text.substring(startIdx, endIdx).replace(/\s+/g, ' ');
    const lowerCtx = context.toLowerCase();

    if (lowerCtx.includes('audiência') || lowerCtx.includes('audiencia') || lowerCtx.includes('sessão') || lowerCtx.includes('sessao') || lowerCtx.includes('sala de audiência')) {
      let desc = 'Audiência Trabalhista designada';
      if (lowerCtx.includes('instrução') || lowerCtx.includes('instrucao')) desc = 'Audiência de Instrução e Julgamento';
      else if (lowerCtx.includes('conciliação') || lowerCtx.includes('conciliacao') || lowerCtx.includes('inicial')) desc = 'Audiência Inicial de Conciliação';
      else if (lowerCtx.includes('una')) desc = 'Audiência Una designada';
      addResult(dateFormatted, desc, 'audiencia', 'urgente', 'Autos do Processo', context);
    } else if (lowerCtx.includes('ajuizada') || lowerCtx.includes('ajuizamento') || lowerCtx.includes('distribuição') || lowerCtx.includes('distribuicao') || lowerCtx.includes('distribuída') || lowerCtx.includes('distribuido') || lowerCtx.includes('protocolada') || lowerCtx.includes('distribuído em') || lowerCtx.includes('distribuída em')) {
      addResult(dateFormatted, 'Distribuição / Ajuizamento da Reclamatória Trabalhista', 'distribuicao', 'cumprido', 'Petição Inicial', context);
    } else if (lowerCtx.includes('prescrição') || lowerCtx.includes('prescricao') || lowerCtx.includes('bienal') || lowerCtx.includes('quinquenal') || lowerCtx.includes('prescricional')) {
      const tipoPresc = lowerCtx.includes('quinquenal') ? 'Quinquenal' : (lowerCtx.includes('bienal') ? 'Bienal' : 'Processual');
      addResult(dateFormatted, `Marco da Prescrição ${tipoPresc}`, 'prescricao', 'informativo', 'Fundamentação', context);
    } else if (lowerCtx.includes('perícia') || lowerCtx.includes('pericia') || lowerCtx.includes('laudo pericial') || lowerCtx.includes('vistoria') || lowerCtx.includes('perito')) {
      addResult(dateFormatted, 'Diligência Pericial / Vistoria Agendada', 'pericia', 'alerta', 'Autos', context);
    } else if (lowerCtx.includes('admissão') || lowerCtx.includes('admissao') || lowerCtx.includes('admitido') || lowerCtx.includes('contratado') || lowerCtx.includes('início do pacto') || lowerCtx.includes('inicio do pacto')) {
      addResult(dateFormatted, 'Data de Admissão do Trabalhador', 'outro', 'informativo', 'Contrato de Trabalho', context);
    } else if (lowerCtx.includes('demissão') || lowerCtx.includes('demissao') || lowerCtx.includes('rescisão') || lowerCtx.includes('rescisao') || lowerCtx.includes('afastamento') || lowerCtx.includes('despedida') || lowerCtx.includes('dispensado')) {
      addResult(dateFormatted, 'Data da Rescisão / Término Contratual', 'outro', 'informativo', 'Contrato de Trabalho', context);
    } else if (lowerCtx.includes('notificação') || lowerCtx.includes('notificacao') || lowerCtx.includes('intimação') || lowerCtx.includes('intimacao') || lowerCtx.includes('ciência')) {
      addResult(dateFormatted, 'Intimação / Notificação Processual', 'prazo', 'alerta', 'Notificação', context);
    }
  }

  // 3. Extended dates in full Portuguese: e.g. "15 de março de 2024"
  const extendedDateRegex = /\b(\d{1,2})\s+de\s+(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})\b/gi;
  while ((match = extendedDateRegex.exec(text)) !== null) {
    const rawDate = match[0];
    const startIdx = Math.max(0, match.index - 90);
    const endIdx = Math.min(text.length, match.index + rawDate.length + 90);
    const context = text.substring(startIdx, endIdx).replace(/\s+/g, ' ');
    const lowerCtx = context.toLowerCase();

    if (lowerCtx.includes('audiência') || lowerCtx.includes('audiencia')) {
      addResult(rawDate, 'Audiência Trabalhista designada', 'audiencia', 'urgente', 'Autos', context);
    } else if (lowerCtx.includes('ajuizada') || lowerCtx.includes('distribuição') || lowerCtx.includes('ajuizamento')) {
      addResult(rawDate, 'Ajuizamento da Reclamatória Trabalhista', 'distribuicao', 'cumprido', 'Petição Inicial', context);
    } else if (lowerCtx.includes('prescrição') || lowerCtx.includes('prescricao')) {
      addResult(rawDate, 'Marco Temporal de Prescrição', 'prescricao', 'informativo', 'Autos', context);
    } else if (lowerCtx.includes('perícia') || lowerCtx.includes('pericia')) {
      addResult(rawDate, 'Diligência Pericial Agendada', 'pericia', 'alerta', 'Autos', context);
    } else if (lowerCtx.includes('admissão') || lowerCtx.includes('admissao')) {
      addResult(rawDate, 'Data de Admissão do Trabalhador', 'outro', 'informativo', 'Contrato', context);
    } else if (lowerCtx.includes('rescisão') || lowerCtx.includes('demissão')) {
      addResult(rawDate, 'Data de Rescisão Contratual', 'outro', 'informativo', 'Contrato', context);
    }
  }

  // 4. Sort prioritizing urgency
  const statusWeight: Record<string, number> = {
    urgente: 0,
    alerta: 1,
    informativo: 2,
    cumprido: 3
  };

  return results.sort((a, b) => (statusWeight[a.status] ?? 9) - (statusWeight[b.status] ?? 9));
}

export function extractSectionsFromRawText(text: string) {
  if (!text || !text.trim()) {
    return {
      numero_processo: 'Aguardando autos...',
      reclamante: 'Aguardando identificação...',
      reclamada: 'Aguardando identificação...',
      vt: 'Vara do Trabalho de Origem',
      materia_principal: 'Processo Trabalhista',
      alegacoes_inicial: '',
      pedidos_inicial: '',
      alegacoes_contestacao: '',
      pedidos_contestacao: '',
      provas_produzidas: '',
      jurisprudencia: { trt4: '', tst: '', stf: '' },
      prazos_processuais: []
    };
  }

  // Parse process number
  const procMatch = text.match(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/);
  const procNum = procMatch ? procMatch[0] : '';

  // Parse parties
  let reclamante = '';
  let reclamada = '';
  const reclMatch = text.match(/(?:RECLAMANTE|AUTOR|REQUERENTE)[\s:–—]+([^\n,;]{3,80})/i);
  if (reclMatch) reclamante = reclMatch[1].trim();
  const recdMatch = text.match(/(?:RECLAMADA|RÉ|RÉU|REQUERIDO)[\s:–—]+([^\n,;]{3,80})/i);
  if (recdMatch) reclamada = recdMatch[1].trim();

  // Search for lines and headers
  const lines = text.split('\n');
  const findSectionLines = (keywords: string[]): string => {
    let capturing = false;
    const captured: string[] = [];
    for (const line of lines) {
      const upper = line.toUpperCase().trim();
      if (!capturing && keywords.some(k => upper.includes(k))) {
        capturing = true;
        continue;
      }
      if (capturing) {
        if (
          upper.startsWith('DOS PEDIDOS') || 
          upper.startsWith('DA CONTESTAÇÃO') || 
          upper.startsWith('DO MÉRITO') || 
          upper.startsWith('DAS PROVAS') || 
          upper.startsWith('III -') || 
          upper.startsWith('II -') || 
          upper.startsWith('IV -')
        ) {
          if (captured.length > 3) break;
        }
        if (line.trim()) captured.push(line.trim());
        if (captured.length >= 80) break;
      }
    }
    return captured.length > 0 ? captured.map(l => l.startsWith('-') ? l : `- ${l}`).join('\n') : '';
  };

  const alegacoes = findSectionLines(['DOS FATOS', 'DA CAUSA DE PEDIR', 'DO CONTRATO DE TRABALHO', 'DAS ALEGAÇÕES', 'BREVE RELATO DOS FATOS']) || 
    (text.length > 100 ? text.slice(0, 1500).split('\n').filter(l => l.trim()).map(l => `- ${l.trim()}`).join('\n') : '');

  const pedidos = findSectionLines(['DOS PEDIDOS', 'DO ROL DE PEDIDOS', 'REQUERIMENTOS', 'REQUER']) || 
    (text.toLowerCase().includes('condenação') ? '- Pedidos formulados na petição inicial aguardando extração completa.' : '');

  const contestacao = findSectionLines(['DA CONTESTAÇÃO', 'PRELIMINARMENTE', 'DA DEFESA', 'DO MÉRITO DA DEFESA', 'RESISTÊNCIA']) || '';
  const impugnacoes = findSectionLines(['IMPUGNAÇÃO', 'PEDIDOS DA CONTESTAÇÃO', 'REQUER A IMPROCEDÊNCIA']) || '';
  const provas = findSectionLines(['DAS PROVAS', 'PROVA TESTEMUNHAL', 'DOCUMENTOS JUNTADOS', 'DA INSTRUÇÃO', 'PROTESTA POR PROVAS']) || '';

  return {
    numero_processo: procNum || '0000000-00.0000.5.04.0000',
    reclamante: reclamante || 'Autor da Ação',
    reclamada: reclamada || 'Reclamada',
    vt: 'Vara do Trabalho',
    materia_principal: 'Verbas Trabalhistas Controvertidas',
    alegacoes_inicial: alegacoes,
    pedidos_inicial: pedidos,
    alegacoes_contestacao: contestacao,
    pedidos_contestacao: impugnacoes,
    provas_produzidas: provas,
    jurisprudencia: { 
      trt4: 'Súmula nº 37 do TRT4 (Honorários Advocatícios na Justiça do Trabalho)', 
      tst: 'Súmula 368 do TST (Descontos Previdenciários e Fiscais); OJ 400 da SDI-1', 
      stf: 'Tema 1046 do STF (Validade de Acordos e CCTs); ADI 5766 (Justiça Gratuita)' 
    },
    prazos_processuais: []
  };
}

