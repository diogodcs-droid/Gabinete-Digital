# Gabinete Claude

Versão do Gabinete Digital para rodar como Artifact no Claude (página HTML única, sem servidor).

- `index.html`: página final (gerada por `src/build.sh`), a que é publicada como Artifact.
- `src/`: instruções de processamento (`prompts.js`), lógica de conferência (`logic.js`), interface (`app.js`, `style.css`, `template.html`).
- `test/`: testes da lógica (`logic.test.js`) e teste de fumaça (`smoke.js`).

Uso do Claude via capacidade `sample`; exportação via `downloads`. PDFs são lidos com pdf.js no navegador (sem OCR).
