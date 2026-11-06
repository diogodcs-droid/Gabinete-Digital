# Gabinete Digital

Aplicação React/Vite com servidor Express e Gemini para leitura de autos e elaboração de minutas trabalhistas.

## Executar

Use Node.js 22 ou superior. Execute `npm ci`, configure `GEMINI_API_KEY` nas variáveis do servidor (ou em `.env`, sem versioná-lo) e rode `npm run dev`. Para produção: `npm run build` e `npm start`. O servidor usa a porta `PORT`, com padrão 3000. Nunca coloque a chave no frontend nem use prefixo `VITE_` para ela.

`GEMINI_MODEL` define o modelo, com padrão `gemini-3.1-pro-preview`. O modelo deve estar disponível para o projeto da chave. `GEMINI_FALLBACK_MODELS` permite alternativas expressamente configuradas, separadas por vírgula; não há troca automática para Lite/Flash. Falhas de credenciais e de entrada não são resolvidas trocando modelos. A configuração do Firebase permanece a do projeto original.

## Leitura dos documentos

O PDF.js e seu worker são empacotados juntos, com a versão de compatibilidade, sem carregar código de CDN. O leitor aceita extensão PDF/DOCX/TXT mesmo quando o navegador não informa MIME. Preserva quebras de linha e marca cada página física do PDF com arquivo, número e método de leitura. Essa numeração não equivale necessariamente às folhas impressas nos autos.

Páginas com pouco texto, inclusive imagens com apenas rodapé pesquisável, são renderizadas para leitura por imagem usando o Gemini. O OCR deve devolver transcrição, indicação de página vazia e de incerteza. Incerteza declarada, PDF inválido, senha ou falha em uma página interrompem a importação daquele conjunto. O OCR é probabilístico: a declaração de confiança pelo modelo não comprova exatidão. Transcrições obtidas dessa forma exigem conferência visual antes de uso profissional. Páginas mistas com quantidade significativa de texto pesquisável podem exigir OCR externo revisado; a heurística não detecta todos os casos de texto incompleto.

## Análise e redação

Todas as fontes são divididas em partes limitadas, sem descartar caracteres nem limitar a cinco partes. A extração estruturada usa instruções próprias e interrompe se alguma parte falhar, em vez de apresentar consolidação aparentemente completa. Uma resposta JSON precisa ter os campos esperados.

A redação segue inventário de cada parte, plano de capítulos com fontes identificadas, redação de cada capítulo confrontada com as fontes originais e conferência final de cobertura e coerência. O plano não pode omitir uma fonte nem apontar para fonte inexistente. A validação de citações entre aspas e em itálico compara a sequência transcrita ao texto extraído, tolerando apenas normalização Unicode e de espaços; não certifica a exatidão do OCR nem substitui conferência da prova original.

Se a conferência identificar pendências, o texto parcial permanece para revisão e não é salvo automaticamente como minuta concluída. A conferência usa IA e pode deixar de detectar problemas. Ela compara plano e inventário, que também podem conter omissões; não garante julgamento de todos os pedidos. A revisão jurídica e probatória humana continua necessária. Não existe consulta automática de jurisprudência: não se deve assumir atualização de teses citadas pelo modelo.

O servidor conta os tokens antes da geração, informa excesso de contexto e rejeita respostas bloqueadas ou interrompidas por limite de saída. Não corta autos para conseguir concluir uma minuta. A transmissão só termina com sucesso após o marcador de conclusão; desconexões não são tratadas como respostas completas.

Esse fluxo faz mais chamadas e pode aumentar tempo e custo. Para N partes e C capítulos, a redação usa N + C + 2 chamadas de geração, além da contagem de tokens e do OCR quando necessário. Processos que excedam o contexto em uma etapa exigem divisão adicional ou ajuste do fluxo; o aplicativo informa o limite em vez de eliminar provas.

## Verificar

- `npm test`: regressões de divisão, extração integral, falha de partes, plano, literalidade, transmissão interrompida, limite de saída, redação e auditoria; inclui PDFs sintéticos com texto, imagem, página vazia e arquivo inválido.
- `npm run lint`: verificação TypeScript.
- `npm run build`: compilação da interface e empacotamento do worker.

Os testes de PDF usam a dependência opcional de canvas instalada pelo PDF.js e fazem OCR simulado. Os testes do fluxo de redação usam respostas simuladas. Não comprovam a precisão de uma sentença real, nem disponibilidade, cobrança ou qualidade do Gemini. Ainda é necessário testar a integração real no AI Studio com sua chave e um processo de referência revisado. Não foi concluída uma verificação visual em navegador neste ambiente.
