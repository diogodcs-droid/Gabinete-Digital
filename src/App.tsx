/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { 
  Scale, FileText, Download, Loader2, Sparkles, Upload, Trash2, 
  FileCheck, Search, BookOpen, Gavel, FileUp, LogIn, LogOut, 
  History, Clock, CheckCircle, ChevronRight, FileEdit, Type, Eye,
  LayoutGrid, HelpCircle, AlignLeft, Shield, Landmark, Book, Sparkle,
  AlertCircle, SlidersHorizontal, Calendar, CalendarClock, ChevronDown,
  ChevronUp, AlertTriangle, CheckCircle2, RefreshCw, PlusCircle
} from 'lucide-react';
import { exportToDocx } from '@/lib/docxUtils';
import { SYSTEM_INSTRUCTION, SYSTEM_INSTRUCTION_ED, SYSTEM_INSTRUCTION_ANALYSIS } from '@/lib/prompts';
import { extractDeadlinesFromText, extractSectionsFromRawText, PrazoProcessual } from '@/lib/deadlines';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { readDocument } from '@/lib/readDocuments';
import { readGeminiStream } from '@/lib/geminiClient';
import { extractCase, draftInChapters } from '@/lib/legalWorkflow';
import { auth, db, signInWithGoogle, logout, handleFirestoreError, OperationType, isFirebaseConfigured } from '@/src/lib/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, addDoc, query, where, orderBy, getDocs, Timestamp, deleteDoc, doc } from 'firebase/firestore';
import { motion, AnimatePresence } from 'motion/react';

// Rolling descriptive texts to show during intense judicial AI steps
const LOADING_STEPS = [
  "Buscando as preliminares e alegações iniciais na petição...",
  "Vasculhando contestação e mapeando controvérsias fáticas...",
  "Aglutinando termos documentais e depoimentos de testemunhas...",
  "Conferindo as referências jurídicas fornecidas nos autos...",
  "Formatando cabeçalho estrutural em conformidade com o rito trabalhista...",
  "Redigindo os fundamentos jurídicos com base na distribuição do ônus...",
  "Alinhando dispositivo final e parâmetros de liquidação das custas..."
];

// PRESETS_CHIPS removed as typical decisions feature was requested to be removed

function extractMatchingBraceJSON(text: string): string | null {
  const startIdx = text.indexOf('{');
  if (startIdx === -1) return null;
  
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  
  for (let i = startIdx; i < text.length; i++) {
    const char = text[i];
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          return text.substring(startIdx, i + 1);
        }
      }
    }
  }
  return null;
}

function cleanAndParseJSON(rawText: string): any {
  let cleaned = rawText.trim();
  
  // Remove markdown blocks if they wrap the entire text
  if (cleaned.startsWith('```')) {
    const openBrace = cleaned.indexOf('{');
    if (openBrace !== -1) {
      cleaned = cleaned.substring(openBrace);
    }
    const closeBrace = cleaned.lastIndexOf('}');
    if (closeBrace !== -1) {
      cleaned = cleaned.substring(0, closeBrace + 1);
    }
  } else {
    const openBrace = cleaned.indexOf('{');
    const closeBrace = cleaned.lastIndexOf('}');
    if (openBrace !== -1 && closeBrace !== -1) {
      cleaned = cleaned.substring(openBrace, closeBrace + 1);
    }
  }
  
  try {
    return JSON.parse(cleaned);
  } catch (err: any) {
    console.warn("Standard JSON parse failed, trying brace-matching parser...", err);
    const braceExtracted = extractMatchingBraceJSON(cleaned);
    if (braceExtracted) {
      try {
        return JSON.parse(braceExtracted);
      } catch (innerErr: any) {
        console.error("Brace extraction parsing also failed:", innerErr);
      }
    }
    // Attempt standard recovery: clean potential unescaped control chars (common in LLM output)
    try {
      cleaned = cleaned
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // remove control characters
        .trim();
      return JSON.parse(cleaned);
    } catch (controlCharErr: any) {
      throw err; // throw original
    }
  }
}

function formatFriendlyErrorMessage(err: any): string {
  if (!err) return 'Erro inesperado na comunicação.';
  let msg = typeof err === 'string' ? err : (err.message || String(err));

  // Recursively unpack nested JSON strings
  for (let i = 0; i < 3; i++) {
    try {
      const trimmed = msg.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        const parsed = JSON.parse(trimmed);
        if (parsed.error?.message) {
          msg = parsed.error.message;
        } else if (parsed.message) {
          msg = parsed.message;
        } else if (typeof parsed.error === 'string') {
          msg = parsed.error;
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

  const lower = msg.toLowerCase();
  if (lower.includes('503') || lower.includes('high demand') || lower.includes('unavailable') || lower.includes('service unavailable')) {
    return 'O serviço de inteligência artificial do Google está com alta demanda temporária (Erro 503). O sistema realizou tentativas automáticas de reconexão. Por favor, aguarde alguns instantes e clique em Gerar novamente.';
  }
  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota') || lower.includes('rate limit')) {
    return 'Limite temporário de requisições excedido (Erro 429). Aguarde alguns instantes e tente novamente.';
  }
  if (lower.includes('proxy_generation_disabled')) {
    return 'A geração direta pelo navegador foi atualizada para processamento seguro via servidor. Por favor, tente novamente.';
  }

  return msg;
}

function ensureSentencaHeading(text: string): string {
  if (!text) return text;
  
  // Clean checks
  const clean = text.toUpperCase();
  const hasSentenca = clean.includes("SENTENÇÃO") || clean.includes("SENTENÇA") || clean.includes("SENTENCA");
  
  // Find where the Relatório section starts
  const relatorioRegex = /(?:\n|^)(?:\s*[\*#_-]*\s*)(?:I\s*[-–—\.]\s*)?RELATÓRIO:?/i;
  const match = text.match(relatorioRegex);
  
  if (match && match.index !== undefined) {
    const beforeRelatorio = text.substring(0, match.index);
    const afterRelatorio = text.substring(match.index);
    
    // Check if SENTENÇA is already there in beforeRelatorio
    const beforeClean = beforeRelatorio.toUpperCase();
    if (!beforeClean.includes("SENTENÇA") && !beforeClean.includes("SENTENCA")) {
      return beforeRelatorio + "\n\n**SENTENÇA**\n\n" + afterRelatorio;
    }
  } else if (!hasSentenca) {
    // Fallback: place SENTENÇA after VT
    const vtRegex = /(?:VT|VARA DO TRABALHO):[^\n]+/i;
    const vtMatch = text.match(vtRegex);
    if (vtMatch && vtMatch.index !== undefined) {
      const endOfHeaderIndex = vtMatch.index + vtMatch[0].length;
      return text.substring(0, endOfHeaderIndex) + "\n\n**SENTENÇA**\n\n" + text.substring(endOfHeaderIndex);
    } else {
      return "**SENTENÇA**\n\n" + text;
    }
  }
  
  return text;
}

function openDraftInNewTab(title: string, content: string) {
  const formattedContent = ensureSentencaHeading(content);
  
  const paragraphs = formattedContent.split('\n\n').map(p => {
    let text = p.trim();
    if (!text) return '';
    
    // Headers or Bold line
    if (text.startsWith('#') || (text.startsWith('**') && text.endsWith('**'))) {
      const clean = text.replace(/[\*#]/g, '').trim();
      const cleanUpper = clean.toUpperCase();
      const isSentenca = cleanUpper === 'SENTENÇA' || cleanUpper === 'SENTENCA' || cleanUpper.includes('SENTENÇA DE EMBARGOS') || cleanUpper.includes('SENTENCA DE EMBARGOS');
      if (isSentenca) {
        return `<h1 style="text-align: center; font-size: 1.35rem; font-weight: bold; margin: 2rem 0; letter-spacing: 0.05em; text-transform: uppercase;">${clean}</h1>`;
      }
      return `<h2 style="font-size: 1.1rem; font-weight: bold; margin-top: 1.5rem; margin-bottom: 0.5rem; text-transform: uppercase; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.25rem;">${clean}</h2>`;
    }
    
    // Check for lists
    if (text.startsWith('-') || text.startsWith('*')) {
      const items = text.split('\n').map(item => {
        const cleanItem = item.replace(/^[\s\-\*]+/, '').trim();
        return `<li style="margin-bottom: 0.5rem; list-style-type: none; position: relative; padding-left: 1.5rem;">
          <span style="position: absolute; left: 0; font-weight: bold;">-</span>
          ${cleanItem}
        </li>`;
      }).join('');
      return `<ul style="padding-left: 0; margin: 1rem 0;">${items}</ul>`;
    }
    
    // Normal paragraph
    const isHeaderLine = text.toUpperCase().startsWith('PROCESSO') || 
                         text.toUpperCase().startsWith('RECLAMANTE') || 
                         text.toUpperCase().startsWith('RECLAMADA') || 
                         text.toUpperCase().startsWith('VT:');
                         
    const indentStyle = isHeaderLine ? 'text-align: left; text-indent: 0;' : 'text-align: justify; text-indent: 2.5rem;';
    const boldFormattedText = text
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br />');
      
    return `<p style="${indentStyle} line-height: 1.6; margin: 1rem 0; font-family: 'Georgia', serif;">${boldFormattedText}</p>`;
  }).join('');

  const htmlDoc = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>${title}</title>
      <style>
        body {
          background-color: #fafbfd;
          color: #1e293b;
          font-family: 'Georgia', 'Times New Roman', serif;
          margin: 0;
          padding: 2srem;
          display: flex;
          justify-content: center;
        }
        .page {
          background-color: #ffffff;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          width: 100%;
          max-width: 800px;
          min-height: 297mm;
          padding: 5rem 4rem;
          box-sizing: border-box;
          margin: 2rem auto;
        }
        @media print {
          body {
            background-color: #ffffff;
            color: #000000;
            padding: 0;
          }
          .page {
            box-shadow: none;
            border: none;
            padding: 0;
            max-width: 100%;
            margin: 0;
          }
        }
      </style>
    </head>
    <body>
      <div class="page">
        ${paragraphs}
      </div>
    </body>
    </html>
  `;
  
  const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
}

export default function App() {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem('bypass_user');
      return saved ? JSON.parse(saved) as any as User : null;
    } catch (e) {
      return null;
    }
  });
  const [history, setHistory] = useState<any[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  // Storage key and type definition for Diretrizes Judiciais autosave
  const DIRECTIVES_STORAGE_KEY = 'judicial_directives_autosave';
  
  const [caseDetails, setCaseDetails] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('judicial_directives_autosave');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.caseDetails === 'string') return parsed.caseDetails;
      }
    } catch (e) {
      console.warn('Erro ao restaurar caseDetails do localStorage:', e);
    }
    return '';
  });

  const [isSumarissimo, setIsSumarissimo] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('judicial_directives_autosave');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.isSumarissimo === 'boolean') return parsed.isSumarissimo;
      }
    } catch (e) {
      console.warn('Erro ao restaurar isSumarissimo do localStorage:', e);
    }
    return false;
  });

  const [isRevelia, setIsRevelia] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('judicial_directives_autosave');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.isRevelia === 'boolean') return parsed.isRevelia;
      }
    } catch (e) {
      console.warn('Erro ao restaurar isRevelia do localStorage:', e);
    }
    return false;
  });

  const [isProcedenteTotal, setIsProcedenteTotal] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('judicial_directives_autosave');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.isProcedenteTotal === 'boolean') return parsed.isProcedenteTotal;
      }
    } catch (e) {
      console.warn('Erro ao restaurar isProcedenteTotal do localStorage:', e);
    }
    return false;
  });

  const [lastAutosaveTime, setLastAutosaveTime] = useState<Date | null>(() => {
    try {
      const saved = localStorage.getItem('judicial_directives_autosave');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.updatedAt && typeof parsed.updatedAt === 'number') return new Date(parsed.updatedAt);
      }
    } catch (e) {
      // ignore
    }
    return null;
  });

  const [autosaveStatus, setAutosaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const isDirectivesInitialMount = useRef(true);
  const autosaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [generatedDraft, setGeneratedDraft] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  const [draftComplete, setDraftComplete] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<{role: 'user' | 'model', text: string}[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string; text: string; size?: string }[]>([]);
  const [analysis, setAnalysis] = useState<{
    numero_processo: string;
    reclamante: string;
    reclamada: string;
    vt: string;
    materia_principal: string;
    alegacoes_inicial: string;
    pedidos_inicial: string;
    alegacoes_contestacao: string;
    pedidos_contestacao: string;
    provas_produzidas: string;
    jurisprudencia: { trt4: string; tst: string; stf: string };
    prazos_processuais?: PrazoProcessual[];
  } | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [extractionError, setExtractionError] = useState<string | null>(null);

  // Active tab in analysis panel
  const [activeAnalysisTab, setActiveAnalysisTab] = useState<string>('documentos');

  // Prazos processuais e datas importantes states
  const [isDeadlinesCollapsed, setIsDeadlinesCollapsed] = useState(false);
  const [deadlineFilter, setDeadlineFilter] = useState<string>('todos');
  const [manualScannedDeadlines, setManualScannedDeadlines] = useState<PrazoProcessual[]>([]);
  const [isScanningDeadlines, setIsScanningDeadlines] = useState(false);
  const [scanSuccessFeedback, setScanSuccessFeedback] = useState<string | null>(null);

  // Heuristic analysis fallback from raw petition text or attachments
  const combinedSourceText = useMemo(() => {
    return [caseDetails, ...uploadedFiles.map(f => f.text)].join('\n\n');
  }, [caseDetails, uploadedFiles]);

  const fallbackAnalysis = useMemo(() => {
    return extractSectionsFromRawText(combinedSourceText);
  }, [combinedSourceText]);

  // Integrated active analysis data: prioritizes AI extraction, falls back cleanly to petition text
  const activeAnalysisData = useMemo(() => {
    if (analysis) {
      return {
        numero_processo: analysis.numero_processo || fallbackAnalysis.numero_processo,
        reclamante: analysis.reclamante || fallbackAnalysis.reclamante,
        reclamada: analysis.reclamada || fallbackAnalysis.reclamada,
        vt: analysis.vt || fallbackAnalysis.vt,
        materia_principal: analysis.materia_principal || fallbackAnalysis.materia_principal,
        alegacoes_inicial: analysis.alegacoes_inicial || fallbackAnalysis.alegacoes_inicial,
        pedidos_inicial: analysis.pedidos_inicial || fallbackAnalysis.pedidos_inicial,
        alegacoes_contestacao: analysis.alegacoes_contestacao || fallbackAnalysis.alegacoes_contestacao,
        pedidos_contestacao: analysis.pedidos_contestacao || fallbackAnalysis.pedidos_contestacao,
        provas_produzidas: analysis.provas_produzidas || fallbackAnalysis.provas_produzidas,
        jurisprudencia: analysis.jurisprudencia || fallbackAnalysis.jurisprudencia,
        prazos_processuais: (analysis.prazos_processuais && analysis.prazos_processuais.length > 0) ? analysis.prazos_processuais : fallbackAnalysis.prazos_processuais
      };
    }
    return combinedSourceText.trim() ? fallbackAnalysis : null;
  }, [analysis, combinedSourceText, fallbackAnalysis]);

  // Aggregate all deadlines from AI extraction, petition text, and uploaded records
  const detectedDeadlines = useMemo(() => {
    const list: PrazoProcessual[] = [];
    const seen = new Set<string>();

    const pushItem = (item: PrazoProcessual) => {
      const key = `${item.data.toLowerCase()}::${item.descricao.toLowerCase().slice(0, 30)}`;
      if (!seen.has(key)) {
        seen.add(key);
        list.push(item);
      }
    };

    // 1. Incorporate structured deadlines from AI extraction if available
    if (analysis?.prazos_processuais && Array.isArray(analysis.prazos_processuais)) {
      analysis.prazos_processuais.forEach((p, idx) => {
        if (p && (p.data || p.descricao)) {
          pushItem({
            id: p.id || `ai-${idx}`,
            data: p.data || 'Data nos autos',
            descricao: p.descricao || 'Prazo processual relevante',
            tipo: (p.tipo as any) || 'prazo',
            status: (p.status as any) || 'alerta',
            origem: 'Análise Estruturada por IA'
          });
        }
      });
    }

    // 2. Scan caseDetails & uploadedFiles for any dates/deadlines in real-time
    const combinedText = [
      caseDetails,
      ...uploadedFiles.map(f => f.text)
    ].join('\n\n');

    if (combinedText.trim()) {
      const textExtracted = extractDeadlinesFromText(combinedText);
      textExtracted.forEach(pushItem);
    }

    // 3. Include manually scanned deadlines
    manualScannedDeadlines.forEach(pushItem);

    const statusWeight: Record<string, number> = {
      urgente: 0,
      alerta: 1,
      informativo: 2,
      cumprido: 3
    };

    return list.sort((a, b) => (statusWeight[a.status] ?? 9) - (statusWeight[b.status] ?? 9));
  }, [analysis?.prazos_processuais, caseDetails, uploadedFiles, manualScannedDeadlines]);

  const handleManualScanDeadlines = () => {
    setIsScanningDeadlines(true);
    setScanSuccessFeedback(null);
    try {
      const combined = [caseDetails, ...uploadedFiles.map(f => f.text)].join('\n\n');
      const found = extractDeadlinesFromText(combined);
      setManualScannedDeadlines(found);
      setScanSuccessFeedback(`${found.length} prazo(s) e data(s) identificado(s)!`);
      setTimeout(() => setScanSuccessFeedback(null), 4000);
    } finally {
      setIsScanningDeadlines(false);
    }
  };

  const handleInsertDeadlineToCaseDetails = (prazo: PrazoProcessual) => {
    const formattedNote = `\n- [${prazo.tipo.toUpperCase()}]: ${prazo.data} - ${prazo.descricao}`;
    setCaseDetails(prev => (prev ? prev.trim() + '\n' + formattedNote : formattedNote.trim()));
  };

  // Autosave effect for Diretrizes Judiciais (persisting to localStorage with debounce)
  useEffect(() => {
    if (isDirectivesInitialMount.current) {
      isDirectivesInitialMount.current = false;
      return;
    }

    setAutosaveStatus('saving');

    if (autosaveTimeoutRef.current) {
      clearTimeout(autosaveTimeoutRef.current);
    }

    autosaveTimeoutRef.current = setTimeout(() => {
      try {
        const payload = {
          caseDetails,
          isSumarissimo,
          isRevelia,
          isProcedenteTotal,
          updatedAt: Date.now()
        };

        if (!caseDetails.trim() && !isSumarissimo && !isRevelia && !isProcedenteTotal) {
          localStorage.removeItem(DIRECTIVES_STORAGE_KEY);
          setLastAutosaveTime(null);
          setAutosaveStatus('idle');
        } else {
          localStorage.setItem(DIRECTIVES_STORAGE_KEY, JSON.stringify(payload));
          setLastAutosaveTime(new Date());
          setAutosaveStatus('saved');
        }
      } catch (err) {
        console.error('Falha no auto-salvamento das diretrizes judiciais:', err);
      }
    }, 350);

    return () => {
      if (autosaveTimeoutRef.current) {
        clearTimeout(autosaveTimeoutRef.current);
      }
    };
  }, [caseDetails, isSumarissimo, isRevelia, isProcedenteTotal]);

  // Synchronous flush before page unload/refresh to guarantee no data loss
  useEffect(() => {
    const handleBeforeUnload = () => {
      try {
        const payload = {
          caseDetails,
          isSumarissimo,
          isRevelia,
          isProcedenteTotal,
          updatedAt: Date.now()
        };
        if (!caseDetails.trim() && !isSumarissimo && !isRevelia && !isProcedenteTotal) {
          localStorage.removeItem(DIRECTIVES_STORAGE_KEY);
        } else {
          localStorage.setItem(DIRECTIVES_STORAGE_KEY, JSON.stringify(payload));
        }
      } catch (e) {
        // ignore on unload
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [caseDetails, isSumarissimo, isRevelia, isProcedenteTotal]);

  const handleClearDirectives = () => {
    setCaseDetails('');
    setIsSumarissimo(false);
    setIsRevelia(false);
    setIsProcedenteTotal(false);
    try {
      localStorage.removeItem(DIRECTIVES_STORAGE_KEY);
    } catch (e) {
      console.warn('Erro ao remover diretrizes do localStorage:', e);
    }
    setLastAutosaveTime(null);
    setAutosaveStatus('idle');
  };

  const getDeadlineTypeConfig = (tipo?: string) => {
    switch (tipo) {
      case 'audiencia':
        return {
          label: 'Audiência',
          icon: <Calendar className="w-3.5 h-3.5 text-indigo-600" />,
          dateBadge: 'bg-indigo-50 text-indigo-900 border-indigo-200',
          tagBadge: 'bg-indigo-100/70 text-indigo-800 border-indigo-300'
        };
      case 'prazo':
        return {
          label: 'Prazo Fatal',
          icon: <Clock className="w-3.5 h-3.5 text-rose-600" />,
          dateBadge: 'bg-rose-50 text-rose-900 border-rose-200',
          tagBadge: 'bg-rose-100/70 text-rose-800 border-rose-300'
        };
      case 'prescricao':
        return {
          label: 'Prescrição',
          icon: <Scale className="w-3.5 h-3.5 text-purple-600" />,
          dateBadge: 'bg-purple-50 text-purple-900 border-purple-200',
          tagBadge: 'bg-purple-100/70 text-purple-800 border-purple-300'
        };
      case 'distribuicao':
        return {
          label: 'Ajuizamento',
          icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />,
          dateBadge: 'bg-emerald-50 text-emerald-900 border-emerald-200',
          tagBadge: 'bg-emerald-100/70 text-emerald-800 border-emerald-300'
        };
      case 'pericia':
        return {
          label: 'Perícia',
          icon: <FileCheck className="w-3.5 h-3.5 text-cyan-600" />,
          dateBadge: 'bg-cyan-50 text-cyan-900 border-cyan-200',
          tagBadge: 'bg-cyan-100/70 text-cyan-800 border-cyan-300'
        };
      default:
        return {
          label: 'Marco dos Autos',
          icon: <Clock className="w-3.5 h-3.5 text-slate-500" />,
          dateBadge: 'bg-slate-50 text-slate-800 border-slate-200',
          tagBadge: 'bg-slate-100 text-slate-700 border-slate-300'
        };
    }
  };

  const renderDeadlinesCard = () => {
    const filteredDeadlines = detectedDeadlines.filter(item => {
      if (deadlineFilter === 'todos') return true;
      return item.tipo === deadlineFilter;
    });

    const categoryCounts = detectedDeadlines.reduce((acc, curr) => {
      const t = curr.tipo || 'outro';
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const hasDeadlines = detectedDeadlines.length > 0;

    return (
      <div className="bg-gradient-to-br from-amber-50/70 via-white to-amber-50/30 border border-amber-300/80 rounded-lg p-3.5 shadow-sm text-xs transition-all duration-200 mb-3">
        {/* Card Header */}
        <div className="flex items-center justify-between pb-2 border-b border-amber-200/60">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-amber-600/10 flex items-center justify-center text-amber-800 shrink-0">
              <CalendarClock className="w-3.5 h-3.5 text-amber-700" />
            </div>
            <div>
              <span className="font-bold text-slate-900 tracking-wider uppercase text-[10.5px] flex items-center gap-1.5">
                Prazos e Datas Importantes
                {hasDeadlines && (
                  <span className="bg-amber-100 text-amber-900 border border-amber-300 px-1.5 py-0.2 rounded font-mono font-bold text-[9.5px]">
                    {detectedDeadlines.length}
                  </span>
                )}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-slate-500 hover:text-amber-800 hover:bg-amber-100/70 rounded transition-colors"
              onClick={handleManualScanDeadlines}
              disabled={isScanningDeadlines}
              title="Reescanear texto da petição e autos em busca de datas e prazos"
            >
              <RefreshCw className={cn("w-3 h-3", isScanningDeadlines && "animate-spin text-amber-600")} />
            </Button>
            {hasDeadlines && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded transition-colors"
                onClick={() => setIsDeadlinesCollapsed(!isDeadlinesCollapsed)}
                title={isDeadlinesCollapsed ? "Expandir detalhes dos prazos" : "Recolher card de prazos"}
              >
                {isDeadlinesCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
              </Button>
            )}
          </div>
        </div>

        {/* Scan feedback notice */}
        {scanSuccessFeedback && (
          <div className="mt-2 text-[10px] text-amber-900 bg-amber-100/80 border border-amber-300 px-2.5 py-1 rounded font-medium flex items-center gap-1.5 animate-in fade-in">
            <CheckCircle2 className="w-3 h-3 text-amber-700" />
            {scanSuccessFeedback}
          </div>
        )}

        {/* When Collapsed: compact ticker pills */}
        {hasDeadlines && isDeadlinesCollapsed && (
          <div className="flex items-center gap-1.5 overflow-x-auto pt-2 pb-0.5 text-[10px] no-scrollbar">
            {detectedDeadlines.slice(0, 4).map((d, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 bg-white border border-slate-200 px-2 py-0.5 rounded text-slate-700 font-medium whitespace-nowrap shadow-xs"
              >
                <span className="font-bold text-amber-800 font-mono">{d.data}</span>
                <span className="text-slate-400">•</span>
                <span className="text-slate-600 truncate max-w-[110px]">{d.descricao}</span>
              </span>
            ))}
            {detectedDeadlines.length > 4 && (
              <button
                type="button"
                onClick={() => setIsDeadlinesCollapsed(false)}
                className="text-amber-800 hover:underline font-bold text-[9.5px] whitespace-nowrap px-1"
              >
                +{detectedDeadlines.length - 4} mais
              </button>
            )}
          </div>
        )}

        {/* When Expanded: full list with filters */}
        {hasDeadlines && !isDeadlinesCollapsed && (
          <div className="mt-2.5 space-y-2">
            {/* Filter pills if multiple categories */}
            {Object.keys(categoryCounts).length > 1 && (
              <div className="flex items-center gap-1 overflow-x-auto pb-1.5 border-b border-amber-200/40 text-[9.5px]">
                <button
                  type="button"
                  onClick={() => setDeadlineFilter('todos')}
                  className={cn(
                    "px-2 py-0.5 rounded font-bold transition-all uppercase whitespace-nowrap",
                    deadlineFilter === 'todos'
                      ? "bg-amber-700 text-white shadow-xs"
                      : "bg-white/80 text-slate-600 hover:bg-amber-100/50 border border-slate-200"
                  )}
                >
                  Todos ({detectedDeadlines.length})
                </button>
                {categoryCounts['audiencia'] && (
                  <button
                    type="button"
                    onClick={() => setDeadlineFilter('audiencia')}
                    className={cn(
                      "px-2 py-0.5 rounded font-bold transition-all uppercase whitespace-nowrap",
                      deadlineFilter === 'audiencia'
                        ? "bg-indigo-700 text-white shadow-xs"
                        : "bg-white/80 text-indigo-700 hover:bg-indigo-50 border border-indigo-200"
                    )}
                  >
                    Audiências ({categoryCounts['audiencia']})
                  </button>
                )}
                {categoryCounts['prazo'] && (
                  <button
                    type="button"
                    onClick={() => setDeadlineFilter('prazo')}
                    className={cn(
                      "px-2 py-0.5 rounded font-bold transition-all uppercase whitespace-nowrap",
                      deadlineFilter === 'prazo'
                        ? "bg-rose-700 text-white shadow-xs"
                        : "bg-white/80 text-rose-700 hover:bg-rose-50 border border-rose-200"
                    )}
                  >
                    Prazos Fatais ({categoryCounts['prazo']})
                  </button>
                )}
                {categoryCounts['prescricao'] && (
                  <button
                    type="button"
                    onClick={() => setDeadlineFilter('prescricao')}
                    className={cn(
                      "px-2 py-0.5 rounded font-bold transition-all uppercase whitespace-nowrap",
                      deadlineFilter === 'prescricao'
                        ? "bg-purple-700 text-white shadow-xs"
                        : "bg-white/80 text-purple-700 hover:bg-purple-50 border border-purple-200"
                    )}
                  >
                    Prescrição ({categoryCounts['prescricao']})
                  </button>
                )}
                {categoryCounts['distribuicao'] && (
                  <button
                    type="button"
                    onClick={() => setDeadlineFilter('distribuicao')}
                    className={cn(
                      "px-2 py-0.5 rounded font-bold transition-all uppercase whitespace-nowrap",
                      deadlineFilter === 'distribuicao'
                        ? "bg-emerald-700 text-white shadow-xs"
                        : "bg-white/80 text-emerald-700 hover:bg-emerald-50 border border-emerald-200"
                    )}
                  >
                    Ajuizamento ({categoryCounts['distribuicao']})
                  </button>
                )}
                {categoryCounts['pericia'] && (
                  <button
                    type="button"
                    onClick={() => setDeadlineFilter('pericia')}
                    className={cn(
                      "px-2 py-0.5 rounded font-bold transition-all uppercase whitespace-nowrap",
                      deadlineFilter === 'pericia'
                        ? "bg-cyan-700 text-white shadow-xs"
                        : "bg-white/80 text-cyan-700 hover:bg-cyan-50 border border-cyan-200"
                    )}
                  >
                    Perícia ({categoryCounts['pericia']})
                  </button>
                )}
              </div>
            )}

            {/* Deadlines items list */}
            <div className="space-y-1.5 max-h-[220px] overflow-y-auto pr-1">
              {filteredDeadlines.map((prazo) => {
                const cfg = getDeadlineTypeConfig(prazo.tipo);
                return (
                  <div
                    key={prazo.id}
                    className="p-2.5 bg-white border border-slate-200/90 hover:border-amber-400 rounded-md shadow-xs transition-all group"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={cn("px-2 py-0.5 rounded font-mono font-bold text-[10.5px] border flex items-center gap-1 shadow-2xs", cfg.dateBadge)}>
                          {cfg.icon}
                          {prazo.data}
                        </span>
                        <span className={cn("px-1.5 py-0.2 rounded text-[9px] font-bold uppercase tracking-wider border", cfg.tagBadge)}>
                          {cfg.label}
                        </span>
                        {prazo.status === 'urgente' && (
                          <span className="px-1.5 py-0.2 rounded text-[8.5px] font-bold uppercase bg-red-100 text-red-800 border border-red-200">
                            Urgente
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => handleInsertDeadlineToCaseDetails(prazo)}
                        className="opacity-80 group-hover:opacity-100 transition-opacity text-[9.5px] text-amber-800 hover:text-amber-950 font-bold uppercase flex items-center gap-1 bg-amber-50 hover:bg-amber-100 px-1.5 py-0.5 rounded border border-amber-200 shrink-0"
                        title="Inserir este prazo/data nas instruções da sentença"
                      >
                        <PlusCircle className="w-2.5 h-2.5 text-amber-700" />
                        Diretrizes
                      </button>
                    </div>

                    <p className="mt-1 text-[11px] font-semibold text-slate-800 leading-snug">
                      {prazo.descricao}
                    </p>

                    {prazo.contexto && (
                      <p className="mt-0.5 text-[9.5px] text-slate-500 italic line-clamp-1 border-l-2 border-slate-200 pl-1.5">
                        "{prazo.contexto.trim()}"
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state prompt */}
        {!hasDeadlines && (
          <div className="mt-2 p-3 bg-white/80 border border-dashed border-amber-200 rounded-md text-center">
            <p className="text-[11px] text-slate-500 font-medium">
              Nenhum prazo processual ou data importante identificado automaticamente ainda.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1.5 h-6 text-[10px] font-bold uppercase text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-300 rounded px-2.5 gap-1"
              onClick={handleManualScanDeadlines}
              disabled={isScanningDeadlines}
            >
              <Search className="w-2.5 h-2.5 text-amber-700" />
              {isScanningDeadlines ? "Escanear..." : "Identificar Prazos na Petição"}
            </Button>
          </div>
        )}
      </div>
    );
  };
  
  // Analisar Minuta states
  const [showAnalyzeMinutaModal, setShowAnalyzeMinutaModal] = useState(false);
  const [minutaText, setMinutaText] = useState('');
  const [isAnalyzingMinuta, setIsAnalyzingMinuta] = useState(false);
  const [minutaAnalysisResult, setMinutaAnalysisResult] = useState('');
  const [minutaAnalysisError, setMinutaAnalysisError] = useState<string | null>(null);
  const [isExtractingMinutaFile, setIsExtractingMinutaFile] = useState(false);
  const [minutaFileName, setMinutaFileName] = useState('');
  const minutaFileInputRef = useRef<HTMLInputElement>(null);
  
  // Custom layout states: full width paper and collapsible left panel
  const [isFullWidthPaper, setIsFullWidthPaper] = useState(true);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(false);
  
  // Google login invitation state (shows up as an elegant overlay prompt if not logged in on load)
  const [showLoginOffer, setShowLoginOffer] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [emailLoginError, setEmailLoginError] = useState<string | null>(null);

  const openLoginModal = () => {
    setAuthError(null);
    setEmailLoginError(null);
    setShowLoginOffer(true);
  };

  const handleEmailLogin = (emailToLogin?: string) => {
    const targetEmail = (emailToLogin || emailInput).trim().toLowerCase();
    if (!targetEmail) {
      setEmailLoginError("Por favor, informe seu e-mail.");
      return;
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(targetEmail)) {
      setEmailLoginError("Por favor, insira um e-mail válido.");
      return;
    }

    const isGiliani = targetEmail === 'gilianiromano@gmail.com';
    const mockUser = {
      uid: isGiliani ? 'gilianiromano-uid' : 'mock-uid-' + targetEmail.replace(/[^a-zA-Z0-9]/g, ''),
      email: targetEmail,
      displayName: isGiliani ? 'Giliani Romano' : targetEmail.split('@')[0],
      emailVerified: true
    } as any;

    localStorage.setItem('bypass_user', JSON.stringify(mockUser));
    setUser(mockUser);
    fetchHistory(mockUser.uid);
    setShowLoginOffer(false);
    setEmailLoginError(null);
    setEmailInput('');
  };

  const handleLogout = async () => {
    const hasBypass = localStorage.getItem('bypass_user');
    if (hasBypass) {
      localStorage.removeItem('bypass_user');
      setUser(null);
      const localHistoryJson = localStorage.getItem('local_sentences');
      const localHistory = localHistoryJson ? JSON.parse(localHistoryJson) : [];
      setHistory(localHistory);
    } else {
      await logout();
      setUser(null);
    }
  };

  const handleLogin = async () => {
    setIsSigningIn(true);
    setAuthError(null);
    try {
      await signInWithGoogle();
      setShowLoginOffer(false);
    } catch (err: any) {
      console.error("Auth error:", err);
      let localizedMsg = "Ocorreu um erro ao fazer login.";
      if (err?.code === 'auth/popup-blocked') {
        localizedMsg = "O navegador bloqueou a janela pop-up de login. Por favor, autorize pop-ups para este site ou utilize o botão no topo direito para abrir o aplicativo em uma aba externa dedicada.";
      } else if (err?.code === 'auth/cancelled-popup-request' || err?.code === 'auth/popup-closed-by-user') {
        localizedMsg = "A janela de login com o Google foi fechada antes do login ser finalizado.";
      } else if (err?.code === 'auth/network-request-failed') {
        localizedMsg = "Erro de conexão de rede ou cookies de terceiros bloqueados pelo navegador. Verifique seu acesso à internet e as permissões de cookies.";
      } else if (err?.code === 'auth/unauthorized-domain') {
        localizedMsg = "Este domínio não está autorizado no Console do Firebase. Para corrigir o erro de login com o Google, acesse o Console do Firebase (https://console.firebase.google.com/project/gen-lang-client-0896186269/authentication/settings) e adicione os domínios do aplicativo (tais como 'ais-dev-2zikplwnlljfvii77s4htf-418145609941.us-east1.run.app' e 'ais-pre-2zikplwnlljfvii77s4htf-418145609941.us-east1.run.app') na lista de 'Domínios Autorizados'.";
      } else if (err?.code === 'auth/operation-not-allowed') {
        localizedMsg = "O método de login por Google não está habilitado no Console do seu projeto Firebase. Para corrigir o erro de login com o Google, acesse o Console (https://console.firebase.google.com/project/gen-lang-client-0896186269/authentication/providers), clique em 'Adicionar Provedor' e ative o 'Google'.";
      } else if (err?.message && (err.message.includes('api-key-not-valid') || err.message.includes('API key') || err.message.includes('invalid-api-key') || err.message.includes('apiKey'))) {
        localizedMsg = "Chave de API do Firebase inválida ou ausente. Para usar o salvamento em nuvem, atualize o Firebase. Por enquanto, você pode utilizar o aplicativo offline e localmente de forma 100% direta e segura!";
      } else if (err?.message) {
        localizedMsg = err.message;
      }
      setAuthError(localizedMsg);
      setShowLoginOffer(true);
    } finally {
      setIsSigningIn(false);
    }
  };
  
  // Custom reading experience settings
  const [paperStyle, setPaperStyle] = useState<'standard' | 'cream' | 'dark'>('standard');
  const [paperFontSize, setPaperFontSize] = useState<'sm' | 'md' | 'lg'>('md');
  const [paperFont, setPaperFont] = useState<'serif' | 'sans' | 'mono'>('serif');
  const [isDragging, setIsDragging] = useState<boolean>(false);
  
  // Rotating loader phrase state
  const [loadingPhraseIndex, setLoadingPhraseIndex] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatSessionRef = useRef<any>(null);

  // Interval rotation for loading phrases
  useEffect(() => {
    let interval: any;
    if (isGenerating || isAnalyzing) {
      interval = setInterval(() => {
        setLoadingPhraseIndex((prev) => (prev + 1) % LOADING_STEPS.length);
      }, 4200);
    } else {
      setLoadingPhraseIndex(0);
    }
    return () => clearInterval(interval);
  }, [isGenerating, isAnalyzing]);

  useEffect(() => {
    const savedBypass = localStorage.getItem('bypass_user');
    if (savedBypass) {
      try {
        const bypassUser = JSON.parse(savedBypass);
        setUser(bypassUser);
        fetchHistory(bypassUser.uid);
        setShowLoginOffer(false);
      } catch (e) {
        localStorage.removeItem('bypass_user');
      }
    }

    if (isFirebaseConfigured && auth) {
      const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
        const hasBypass = localStorage.getItem('bypass_user');
        if (hasBypass) {
          if (!currentUser) {
            // Keep the bypass user active
            return;
          }
          // If a real Firebase user signs in, remove the local bypass
          localStorage.removeItem('bypass_user');
        }
        
        setUser(currentUser);
        if (currentUser) {
          fetchHistory(currentUser.uid);
          setShowLoginOffer(false);
        } else {
          const localHistoryJson = localStorage.getItem('local_sentences');
          const localHistory = localHistoryJson ? JSON.parse(localHistoryJson) : [];
          setHistory(localHistory);
          setShowLoginOffer(false);
        }
      });
      return () => unsubscribe();
    } else {
      const hasBypass = localStorage.getItem('bypass_user');
      if (!hasBypass) {
        setUser(null);
        const localHistoryJson = localStorage.getItem('local_sentences');
        const localHistory = localHistoryJson ? JSON.parse(localHistoryJson) : [];
        setHistory(localHistory);
        setShowLoginOffer(false);
      }
    }
  }, []);

  const formatItemDate = (item: any) => {
    if (item.createdAt?.toDate) {
      try {
        const date = item.createdAt.toDate();
        return `${date.toLocaleDateString('pt-BR')} ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      } catch (e) {
        // Fallback
      }
    }
    if (item.createdAtStr) {
      try {
        const date = new Date(item.createdAtStr);
        return `${date.toLocaleDateString('pt-BR')} ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      } catch (e) {
        // Fallback
      }
    }
    if (item.createdAt) {
      try {
        const date = new Date(item.createdAt);
        return `${date.toLocaleDateString('pt-BR')} ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      } catch (e) {
        // Fallback
      }
    }
    return '';
  };

  const fetchHistory = async (userId: string) => {
    setIsLoadingHistory(true);
    const isBypass = userId === 'gilianiromano-uid' || userId.startsWith('mock-uid-');
    if (isBypass || !isFirebaseConfigured || !db) {
      const storageKey = isBypass ? `local_sentences_${userId}` : 'local_sentences';
      const localHistoryJson = localStorage.getItem(storageKey);
      const localHistory = localHistoryJson ? JSON.parse(localHistoryJson) : [];
      setHistory(localHistory);
      setIsLoadingHistory(false);
      return;
    }
    const path = 'sentences';
    try {
      const q = query(
        collection(db, path),
        where("userId", "==", userId),
        orderBy("createdAt", "desc")
      );
      const querySnapshot = await getDocs(q);
      const docs = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setHistory(docs);
    } catch (err: any) {
      console.error("Error fetching history:", err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const saveSentence = async (draft: string, type: 'standard' | 'ed' = 'standard') => {
    let title = analysis?.numero_processo || (analysis?.reclamante ? `Processo: ${analysis.reclamante}` : 'Minuta s/ título');
    if (type === 'ed') {
      title = analysis?.numero_processo ? `ED - ${analysis.numero_processo}` : (analysis?.reclamante ? `ED: ${analysis.reclamante}` : 'ED s/ título');
    }
    const newLocalRecord = {
      id: 'local_' + Date.now(),
      generatedText: draft,
      caseDetails: caseDetails,
      title: title,
      createdAtStr: new Date().toISOString(),
      metadata: {
        numero_processo: analysis?.numero_processo || '',
        reclamante: analysis?.reclamante || '',
        reclamada: analysis?.reclamada || '',
      }
    };

    const isBypass = user && (user.uid === 'gilianiromano-uid' || user.uid.startsWith('mock-uid-'));
    if (user && isFirebaseConfigured && !isBypass) {
      const path = 'sentences';
      try {
        await addDoc(collection(db, path), {
          userId: user.uid,
          generatedText: draft,
          caseDetails: caseDetails,
          title: title,
          createdAt: Timestamp.now(),
          metadata: {
            numero_processo: analysis?.numero_processo || '',
            reclamante: analysis?.reclamante || '',
            reclamada: analysis?.reclamada || '',
          }
        });
        fetchHistory(user.uid);
      } catch (err: any) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    } else {
      const storageKey = isBypass ? `local_sentences_${user.uid}` : 'local_sentences';
      const localHistoryJson = localStorage.getItem(storageKey);
      const localHistory = localHistoryJson ? JSON.parse(localHistoryJson) : [];
      localHistory.unshift(newLocalRecord);
      localStorage.setItem(storageKey, JSON.stringify(localHistory));
      setHistory(localHistory);
    }
  };

  const deleteFromHistory = async (id: string) => {
    if (id.startsWith('local_')) {
      const storageKey = (user && (user.uid === 'gilianiromano-uid' || user.uid.startsWith('mock-uid-'))) 
        ? `local_sentences_${user.uid}` 
        : 'local_sentences';
      const localHistoryJson = localStorage.getItem(storageKey);
      if (localHistoryJson) {
        const localHistory = JSON.parse(localHistoryJson);
        const filtered = localHistory.filter((item: any) => item.id !== id);
        localStorage.setItem(storageKey, JSON.stringify(filtered));
        setHistory(filtered);
      }
      return;
    }
    const path = `sentences/${id}`;
    try {
      await deleteDoc(doc(db, 'sentences', id));
      setHistory(prev => prev.filter(item => item.id !== id));
    } catch (err: any) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const getGeminiModelResponse = async (options: {
    contents: any;
    systemInstruction?: string;
    temperature?: number;
    responseMimeType?: string;
    isStream?: boolean;
    onStreamChunk?: (text: string) => void;
  }): Promise<string> => {
    if (options.isStream) {
      const response = await fetch('/api/gemini/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: options.contents,
          systemInstruction: options.systemInstruction,
          temperature: options.temperature ?? 0.1,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const rawErr = errorData.error || `Erro HTTP ${response.status}: ${response.statusText}`;
        throw new Error(formatFriendlyErrorMessage(rawErr));
      }

      if (!response.body) {
        throw new Error('Sem resposta de stream do servidor');
      }

      return readGeminiStream(response.body, options.onStreamChunk);
    } else {
      const response = await fetch('/api/gemini/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: options.contents,
          systemInstruction: options.systemInstruction,
          temperature: options.temperature ?? 0.1,
          responseMimeType: options.responseMimeType,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const rawErr = errorData.error || `Erro HTTP ${response.status}: ${response.statusText}`;
        throw new Error(formatFriendlyErrorMessage(rawErr));
      }

      const data = await response.json();
      return data.text || '';
    }
  };

  const handleSilentExtraction = async () => {
    if (isAnalyzing || isGenerating) return;
    const sources = uploadedFiles.length ? uploadedFiles : [{ name: 'Diretrizes / texto informado', text: caseDetails }];
    if (!sources.some(f => f.text.trim())) return;
    setIsAnalyzing(true);
    setAnalysis(null);
    setError(null);
    setExtractionError(null);
    try {
      const data = await extractCase(sources, getGeminiModelResponse, cleanAndParseJSON, setProcessingStatus);
      setAnalysis(data);
      setActiveAnalysisTab('alegacoes');
    } catch (err: any) {
      const message = formatFriendlyErrorMessage(err);
      setExtractionError(message);
      setError('Análise não concluída: ' + message);
    } finally {
      setIsAnalyzing(false);
      setProcessingStatus('');
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      const scrollElement = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  }, [generatedDraft, chatHistory]);

  const extractTextFromFile = async (file: File): Promise<string> => {
    return readDocument(file, getGeminiModelResponse, setProcessingStatus);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setIsExtracting(true);
    setError(null);
    setExtractionError(null);

    try {
      const newFiles: { name: string; text: string; size: string }[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const text = await extractTextFromFile(file);
        const formattedSize = file.size > 1024 * 1024 
          ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` 
          : `${(file.size / 1024).toFixed(0)} KB`;
          
        newFiles.push({ name: file.name, text, size: formattedSize });
      }
      setUploadedFiles(prev => [...prev, ...newFiles]);
      setAnalysis(null);
      setChatHistory([]);
      setGeneratedDraft('');
    } catch (err: any) {
      console.error('Error extracting text:', err);
      setError('Erro ao ler documentos: ' + (err.message || 'Verifique se o arquivo está corrompido.'));
    } finally {
      setIsExtracting(false);
      setProcessingStatus('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Drag-and-drop mechanics
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isGenerating || isAnalyzing || isExtracting) return;
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    setIsExtracting(true);
    setError(null);
    setExtractionError(null);

    try {
      const newFiles: { name: string; text: string; size: string }[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const text = await extractTextFromFile(file);
        const formattedSize = file.size > 1024 * 1024 
          ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` 
          : `${(file.size / 1024).toFixed(0)} KB`;
        newFiles.push({ name: file.name, text, size: formattedSize });
      }
      setUploadedFiles(prev => [...prev, ...newFiles]);
      setAnalysis(null);
      setChatHistory([]);
      setGeneratedDraft('');
    } catch (err: any) {
      console.error('Error pulling drops:', err);
      setError('Erro ao processar arquivo solto: ' + (err.message || 'Tente novamente.'));
    } finally {
      setIsExtracting(false);
      setProcessingStatus('');
    }
  };

  const removeFile = (index: number) => {
    if (isGenerating || isAnalyzing || isExtracting) return;
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
    setExtractionError(null);
    setAnalysis(null);
    setChatHistory([]);
    setGeneratedDraft('');
  };

  const handleGenerate = async (type: 'standard' | 'ed' = 'standard') => {
    if (!caseDetails.trim() && uploadedFiles.length === 0) return;

    if (isGenerating || isAnalyzing || isExtracting) return;
    setIsGenerating(true);
    setError(null);
    setGeneratedDraft('');
    setDraftComplete(false);
    setProcessingStatus('Preparando leitura integral dos autos');
    try {
      let systemInstruction = type === 'ed' ? SYSTEM_INSTRUCTION_ED : SYSTEM_INSTRUCTION;
      systemInstruction += `\n\nATENÇÃO IMPERATIVA - VEDAÇÃO ABSOLUTA A MINUTA SINTÉTICA (DEVER DE PROFUNDIDADE E ROBUSTEZ):
Esta sentença NÃO PODE ser sintética, telegráfica ou resumida. É DEVER FUNCIONAL indeclinável do magistrado proferir decisão exaustiva, com profunda valoração de cada elemento de prova constante dos autos (art. 93, IX, da CF e art. 489, § 1º, do CPC).
Você DEVE:
1. Para CADA pedido deduzido na inicial, analisar em detalhes a causa de pedir, os fatos articulados e a impugnação da contestação.
2. Analisar exaustivamente cada documento dos autos, indicando expressamente os IDs e páginas/folhas do processo (ex: cartões de ponto ID. xxxxxxx, fls. y; recibos ID. aaaaaaa, fl. b; laudo pericial ID. ccccccc, fls. d-e).
3. Transcrever trechos literais dos depoimentos das testemunhas e das partes com indicação do ID/página, confrontando contradições e demonstrando o convencimento do Juízo.
4. Aplicar com rigor a distribuição do ônus da prova (art. 818 da CLT c/c art. 373 do CPC) e a subsunção fática aos precedentes vinculantes (STF e TST), fundamentando de forma robusta e irrefutável.
5. Fixar detalhadamente todos os parâmetros de liquidação das parcelas deferidas (base de cálculo, divisores, reflexos específicos e deduções).`;

      const isCaseSumarissimo = isSumarissimo || caseDetails.toLowerCase().includes('sumaríssimo') || caseDetails.toLowerCase().includes('sumarissimo');
      if (isCaseSumarissimo && type !== 'ed') {
        systemInstruction += `\n\nATENÇÃO IMPERATIVA: Este processo é de RITO SUMARÍSSIMO. Portanto, você DEVE substituir integralmente o relatório detalhado pelo seguinte texto padrão exato, observando a formatação estabelecida de título de capítulo em negrito e caixa alta:

**I – RELATÓRIO**

Dispensado o relatório, por se tratar de demanda submetida ao rito sumaríssimo, nos termos do art. 852-I, "caput", da Consolidação das Leis do Trabalho (CLT).

Não inclua nenhum outro resumo, histórico de andamentos ou a frase "É o relatório." após este texto dispensatório. Prossiga diretamente para a fundamentação jurídica de mérito.`;
      }

      const isCaseRevelia = isRevelia || caseDetails.toLowerCase().includes('revelia') || caseDetails.toLowerCase().includes('revel da reclamada') || caseDetails.toLowerCase().includes('revelia da reclamada');
      const isCaseProcedenteTotal = isProcedenteTotal || caseDetails.toLowerCase().includes('procedência total') || caseDetails.toLowerCase().includes('procedência de todos os pedidos') || caseDetails.toLowerCase().includes('totalmente procedente') || caseDetails.toLowerCase().includes('procedentes todos os pedidos');

      if (isCaseRevelia && type !== 'ed') {
        systemInstruction += `\n\nATENÇÃO IMPERATIVA: Ocorreu a REVELIA da reclamada neste processo. 
Por consequência fática e jurídica, aplique as seguintes duas regras estritas:
1. No tópico de JUSTIÇA GRATUITA, você DEVE OMITIR integralmente o segundo parágrafo ("Cabia ao reclamado o ônus de provar que o reclamante não ostentava a condição de pobreza..."). Use apenas o primeiro parágrafo:
"Defiro o benefício da justiça gratuita à parte autora, na forma do art. 790, § 3º, da CLT, com redação dada pela Lei n. 13.467/2017, em razão da declaração de pobreza juntada (fl. XX) e dos termos dos artigos 99, § 3º, e 374, IV, do CPC (aplicados supletivamente – art. 15 do CPC)." (Substituindo fl. XX ou ID pela folha/ID correta se identificada).

2. No tópico de HONORÁRIOS ADVOCATÍCIOS, você DEVE adotar exclusivamente o seguinte texto padrão exato (não use sucumbência recíproca ou qualquer outro parágrafo):
"Condeno a reclamada ao pagamento de honorários advocatícios no importe de 10% sobre o valor da condenação que resultar da liquidação do julgado, nos termos da Súmula nº 37 do TRT4 (com redação dada pela Resolução Administrativa nº 30/2023), forte no art. 791-A, da CLT."`;
      }

      if (isCaseProcedenteTotal && !isCaseRevelia && type !== 'ed') {
        systemInstruction += `\n\nATENÇÃO IMPERATIVA: Há PROCEDÊNCIA DE TODOS OS PEDIDOS (procedência total) da ação. 
Portanto, no tópico de HONORÁRIOS ADVOCATÍCIOS, você DEVE adotar exclusivamente o seguinte texto padrão exato (não use sucumbência recíproca ou qualquer outro parágrafo):
"Condeno a reclamada ao pagamento de honorários advocatícios no importe de 10% sobre o valor da condenação que resultar da liquidação do julgado, nos termos da Súmula nº 37 do TRT4 (com redação dada pela Resolução Administrativa nº 30/2023), forte no art. 791-A, da CLT."`;
      }

      const fullResponse = await draftInChapters({
        files: uploadedFiles.length ? uploadedFiles : [{ name: 'Texto informado pelo usuário', text: caseDetails }],
        instructions: caseDetails || 'Gere a minuta com base nos arquivos enviados.',
        systemInstruction,
        generate: getGeminiModelResponse,
        parse: cleanAndParseJSON,
        progress: setProcessingStatus,
        onDraft: setGeneratedDraft,
      });
      setGeneratedDraft(fullResponse);
      setDraftComplete(true);
      setChatHistory([{ role: 'user', text: caseDetails }, { role: 'model', text: fullResponse }]);

      saveSentence(fullResponse, type);

    } catch (err: any) {
      console.error('Error generating document:', err);
      setError('Falha ao gerar minuta: ' + formatFriendlyErrorMessage(err));
    } finally {
      setIsGenerating(false);
      setProcessingStatus('');
    }
  };

  const handleDownload = () => {
    if (generatedDraft) {
      let filename = "Minuta_Sentenca.docx";
      
      if (analysis) {
        const proc = analysis.numero_processo || "Processo";
        const recl = (analysis.reclamada || "Reclamada").toUpperCase();
        const mat = analysis.materia_principal || "Sentença";
        const safeName = `${proc} - ${recl} - ${mat}`.replace(/[\\/:*?"<>|]/g, '_');
        filename = `${safeName}.docx`;
      }
      
      exportToDocx(ensureSentencaHeading(generatedDraft), filename);
    }
  };

  const handleMinutaFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    setIsExtractingMinutaFile(true);
    setMinutaAnalysisError(null);
    try {
      const text = await extractTextFromFile(file);
      setMinutaText(text);
      setMinutaFileName(file.name);
    } catch (err: any) {
      console.error('Erro ao ler minuta:', err);
      setMinutaAnalysisError('Erro ao ler arquivo de minuta: ' + (err.message || 'Formato inválido.'));
    } finally {
      setIsExtractingMinutaFile(false);
      if (minutaFileInputRef.current) minutaFileInputRef.current.value = '';
    }
  };

  const handleAnalyzeMinuta = async () => {
    if (!minutaText.trim()) {
      setMinutaAnalysisError("Por favor, digite, cole ou importe uma minuta para realizar a análise.");
      return;
    }

    setIsAnalyzingMinuta(true);
    setMinutaAnalysisError(null);
    setMinutaAnalysisResult('');

    try {
      let userPrompt = `Abaixo está a MINUTA DE SENTENÇA que deve ser analisada:\n\n=== MINUTA DE SENTENÇA INÍCIO ===\n${minutaText}\n=== MINUTA DE SENTENÇA FIM ===\n\n`;

      if (uploadedFiles.length > 0) {
        const fileContents = uploadedFiles.map(f => `--- AUTOS DO PROCESSO: ARQUIVO "${f.name}" ---\n${f.text}`).join('\n\n');
        userPrompt += `Confronte-a minuciosamente com as provas, fatos e pedidos contidos nos seguintes AUTOS DO PROCESSO:\n\n${fileContents}`;
      } else {
        userPrompt += `Atenção: Não há arquivos de autos de processo carregados pelo usuário. Realize a análise com foco na coerência jurídica intrínseca, na valoração formal e lógica descrita e, principalmente, na aderência rigorosa às Diretrizes do Gabinete (regras de Improcedência Total, Prescrição Quinquenal, Formatação de Títulos/Subtítulos, e Cabeçalho).`;
      }

      const response = await getGeminiModelResponse({
        contents: userPrompt,
        systemInstruction: SYSTEM_INSTRUCTION_ANALYSIS,
        temperature: 0.1,
        isStream: true,
        onStreamChunk: (chunk) => {
          setMinutaAnalysisResult(chunk);
        }
      });

      setMinutaAnalysisResult(response);
    } catch (err: any) {
      console.error("Erro na análise da minuta:", err);
      setMinutaAnalysisError("Ocorreu um erro ao analisar a minuta: " + formatFriendlyErrorMessage(err));
    } finally {
      setIsAnalyzingMinuta(false);
    }
  };

  // appendDirective removed

  // Stepper calculations based on current document status
  const currentStep = () => {
    if (generatedDraft) return 4;
    if (caseDetails.trim()) return 3;
    if (analysis) return 2;
    if (uploadedFiles.length > 0) return 1;
    return 0;
  };

  return (
    <div className="flex flex-col h-screen w-full bg-[#f4f6f9] font-sans text-slate-800 overflow-hidden selection:bg-amber-100 selection:text-amber-900">
      
      {isExtracting && <div role="status" className="bg-amber-50 text-amber-900 px-6 py-2 text-sm">{processingStatus || 'Lendo documentos...'}</div>}
      {/* Premium Legal Header */}
      <header className="h-20 bg-slate-900 text-white border-b border-slate-950 flex items-center justify-between px-8 shrink-0 shadow-md relative z-10">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-gradient-to-br from-amber-500 to-amber-700 rounded-lg flex items-center justify-center text-slate-900 font-bold shadow-lg shadow-amber-950/20 ring-1 ring-amber-400">
              <Landmark className="w-6 h-6 text-slate-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-lg tracking-wide bg-gradient-to-r from-white via-slate-100 to-amber-300 bg-clip-text text-transparent">
                  Giliani Assistente
                </span>
              </div>
              <p className="text-xs text-slate-400 font-medium tracking-tight">
                Gabinete Digital
              </p>
            </div>
          </div>
        </div>

        {/* Stepper Flow Banner Inside Header for Space Efficiency */}
        <div className="hidden xl:flex items-center gap-8 bg-slate-800/60 border border-slate-700/50 rounded-xl px-5 py-2.5">
          <div className="flex items-center gap-2 text-xs">
            <div className={cn(
              "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border transition-colors",
              currentStep() >= 1 ? "bg-amber-500 border-amber-400 text-slate-950" : "border-slate-600 text-slate-400"
            )}>
              1
            </div>
            <span className={cn("font-medium", currentStep() >= 1 ? "text-slate-100" : "text-slate-500")}>Autos Anexados</span>
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-slate-600" />
          <div className="flex items-center gap-2 text-xs">
            <div className={cn(
              "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border transition-colors",
              currentStep() >= 2 ? "bg-amber-500 border-amber-400 text-slate-950" : "border-slate-600 text-slate-400"
            )}>
              2
            </div>
            <span className={cn("font-medium", currentStep() >= 2 ? "text-slate-100" : "text-slate-500")}>Análise</span>
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-slate-600" />
          <div className="flex items-center gap-2 text-xs">
            <div className={cn(
              "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border transition-colors",
              currentStep() >= 3 ? "bg-amber-500 border-amber-400 text-slate-950" : "border-slate-600 text-slate-400"
            )}>
              3
            </div>
            <span className={cn("font-medium", currentStep() >= 3 ? "text-slate-100" : "text-slate-500")}>Diretrizes</span>
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-slate-600" />
          <div className="flex items-center gap-2 text-xs">
            <div className={cn(
              "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border transition-colors",
              currentStep() >= 4 ? "bg-amber-500 border-amber-400 text-slate-950" : "border-slate-600 text-slate-400"
            )}>
              4
            </div>
            <span className={cn("font-medium", currentStep() >= 4 ? "text-slate-100" : "text-slate-500")}>Redação</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {user ? (
            <div className="flex items-center gap-4">
              <div className="flex flex-col items-end">
                <span className="text-xs font-bold text-slate-200">{user.displayName || user.email}</span>
                <span className="text-[9px] text-amber-500 font-bold uppercase tracking-widest flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
                  Gabinete Conectado
                </span>
              </div>
              <Button 
                variant="ghost" 
                size="sm" 
                className="h-9 text-xs font-semibold uppercase gap-2 text-slate-300 hover:text-red-400 hover:bg-slate-800 border border-slate-700/60 rounded-lg px-3"
                onClick={handleLogout}
              >
                <LogOut className="w-4 h-4 text-slate-400" /> Sair
              </Button>
            </div>
          ) : (
            <Button 
              variant="outline" 
              size="sm" 
              className="h-9 text-xs font-bold uppercase gap-2 border-amber-500/20 text-amber-400 bg-slate-900 shadow-inner hover:bg-slate-800 hover:text-amber-300 rounded-lg"
              onClick={openLoginModal}
              disabled={isSigningIn}
            >
              {isSigningIn ? (
                <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
              ) : (
                <LogIn className="w-4 h-4 text-amber-400" />
              )}
              {isSigningIn ? "Conectando..." : "Entrar / Conectar"}
            </Button>
          )}
        </div>
      </header>

      {error && (
        <div className="px-8 pt-4">
          <Alert variant="destructive" className="bg-red-50 border-red-200 text-red-900 rounded-xl shadow-sm">
            <AlertTitle className="font-bold flex items-center gap-2">⚠️ Atenção</AlertTitle>
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        </div>
      )}

      <section className="flex-1 p-6 bg-[#f4f6f9] flex justify-center overflow-hidden">
        <div className="w-full max-w-full grid grid-cols-1 lg:grid-cols-12 gap-6 h-full">
          
          {/* LEFT PANEL: Automação e Dossiê */}
          <div className={cn(
            "flex flex-col gap-4 overflow-hidden h-full transition-all duration-300",
            isLeftCollapsed ? "hidden lg:hidden" : "lg:col-span-5"
          )}>
            <Card className="flex flex-col h-[70%] bg-white border border-slate-250 shadow-sm rounded-xl overflow-hidden transition-all duration-200 hover:shadow-md">
              <CardHeader className="bg-slate-50 border-b border-slate-200 py-3.5 px-5 flex flex-row items-center justify-between shrink-0">
                <CardTitle className="text-xs font-bold text-slate-800 flex items-center gap-2 uppercase tracking-wide">
                  <Landmark className="w-4 h-4 text-amber-700" />
                  Análise de Autos
                </CardTitle>
                <div className="flex items-center gap-2">
                  <AnimatePresence>
                    {extractionError && (
                      <motion.div 
                        initial={{ opacity: 0, x: 10, scale: 0.95 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        exit={{ opacity: 0, x: 10, scale: 0.95 }}
                        className="hidden sm:flex text-[10px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2 py-1 font-semibold max-w-[150px] truncate items-center gap-1 shadow-sm"
                        title={extractionError}
                      >
                        <AlertCircle className="w-3 h-3 text-red-500 shrink-0" />
                        <span className="truncate">{extractionError}</span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className={cn(
                      "h-8 text-xs uppercase font-bold gap-1.5 rounded-lg shadow-sm transition-all duration-300",
                      extractionError 
                        ? "border-red-300 text-red-700 bg-red-50 hover:bg-red-100" 
                        : "border-amber-500/20 text-amber-800 bg-amber-50 hover:bg-amber-100"
                    )}
                    onClick={handleSilentExtraction}
                    disabled={isAnalyzing || uploadedFiles.length === 0}
                  >
                    {isAnalyzing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : extractionError ? (
                      <AlertCircle className="w-3.5 h-3.5 text-red-600 animate-pulse animate-bounce" />
                    ) : (
                      <Search className="w-3.5 h-3.5" />
                    )}
                    {extractionError ? "Erro na Análise" : "Analisar"}
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="h-8 text-xs uppercase font-bold text-slate-700 hover:text-amber-800 hover:bg-amber-50/50 border border-slate-200 gap-1.5 rounded-lg"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isExtracting}
                  >
                    {isExtracting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5 text-slate-500" />}
                    Anexar
                  </Button>
                </div>
                <input type="file" accept=".pdf,.docx,.txt" multiple disabled={isGenerating || isAnalyzing || isExtracting} className="hidden" ref={fileInputRef} onChange={handleFileUpload} />
              </CardHeader>
              <CardContent className="flex-1 p-0 flex flex-col overflow-hidden">
                <Tabs value={activeAnalysisTab} onValueChange={setActiveAnalysisTab} className="flex-1 flex flex-col overflow-hidden">
                  <TabsList className="bg-slate-50 border-b border-slate-200 w-full justify-start rounded-none h-11 px-3 gap-1 overflow-x-auto shrink-0">
                    <TabsTrigger value="documentos" className="text-xs py-1 h-8 data-[state=active]:bg-white data-[state=active]:shadow-sm rounded-md font-semibold text-slate-600 data-[state=active]:text-slate-900">
                      Anexos ({uploadedFiles.length})
                    </TabsTrigger>
                    <TabsTrigger value="alegacoes" className="text-xs py-1 h-8 data-[state=active]:bg-white data-[state=active]:shadow-sm rounded-md font-semibold text-slate-600 data-[state=active]:text-slate-900">Inicial</TabsTrigger>
                    <TabsTrigger value="pedidos" className="text-xs py-1 h-8 data-[state=active]:bg-white data-[state=active]:shadow-sm rounded-md font-semibold text-slate-600 data-[state=active]:text-slate-900">Pedidos</TabsTrigger>
                    <TabsTrigger value="defesa" className="text-xs py-1 h-8 data-[state=active]:bg-white data-[state=active]:shadow-sm rounded-md font-semibold text-slate-600 data-[state=active]:text-slate-900">Defesa</TabsTrigger>
                    <TabsTrigger value="provas" className="text-xs py-1 h-8 data-[state=active]:bg-white data-[state=active]:shadow-sm rounded-md font-semibold text-slate-600 data-[state=active]:text-slate-900">Provas</TabsTrigger>
                    <TabsTrigger value="juris" className="text-xs py-1 h-8 data-[state=active]:bg-white data-[state=active]:shadow-sm rounded-md font-semibold text-slate-600 data-[state=active]:text-slate-900">Jurisprudência</TabsTrigger>
                    <TabsTrigger value="historico" className="text-xs py-1 h-8 data-[state=active]:bg-white data-[state=active]:shadow-sm rounded-md font-semibold text-amber-700 data-[state=active]:text-amber-900 gap-1 shrink-0">
                      <History className="w-3.5 h-3.5 text-amber-600" /> Histórico
                    </TabsTrigger>
                  </TabsList>
                  
                  <div className="flex-1 p-5 overflow-y-auto bg-white relative">
                    
                    {/* Tab: Documentos & Drag & Drop Upload Zone */}
                    <TabsContent value="documentos" className="m-0 focus-visible:ring-0 h-full flex flex-col">
                      <div 
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        className={cn(
                          "border-2 border-dashed rounded-xl p-6 text-center flex flex-col items-center justify-center transition-all cursor-pointer",
                          isDragging 
                            ? "border-amber-500 bg-amber-50/50 scale-[0.99] text-amber-800" 
                            : "border-slate-300 hover:border-amber-500/50 bg-[#fafbfc]/80 text-slate-500"
                        )}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <div className={cn(
                          "w-12 h-12 rounded-full flex items-center justify-center mb-3 shadow-md transition-transform",
                          isDragging ? "bg-amber-100 text-amber-700 scale-110" : "bg-white text-slate-400 group-hover:scale-105"
                        )}>
                          <FileUp className="w-6 h-6" />
                        </div>
                        <h4 className="font-bold text-slate-700 text-sm">Arrastar e soltar autos aqui</h4>
                        <p className="text-xs mt-1 text-slate-400 max-w-xs mx-auto">
                          Arraste arquivos PDF
                        </p>
                      </div>

                      {/* Attached list */}
                      {uploadedFiles.length > 0 ? (
                        <div className="mt-5 space-y-2.5 flex-1 overflow-y-auto pr-1">
                          <h5 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Peças nos Autos Virtual ({uploadedFiles.length})</h5>
                          {uploadedFiles.map((f, i) => (
                            <div key={i} className="group flex items-center justify-between p-3 bg-[#fafafa] border border-slate-200 rounded-lg hover:border-slate-300 transition-colors">
                              <div className="flex items-center gap-3 overflow-hidden">
                                <div className={cn(
                                  "w-9 h-9 rounded-md flex items-center justify-center font-bold text-xs ring-1",
                                  f.name.endsWith('.pdf') ? "bg-red-50 text-red-700 ring-red-200" :
                                  f.name.endsWith('.docx') ? "bg-blue-50 text-blue-700 ring-blue-200" :
                                  "bg-slate-100 text-slate-700 ring-slate-200"
                                )}>
                                  {f.name.substring(f.name.lastIndexOf('.') + 1).toUpperCase()}
                                </div>
                                <div className="flex flex-col text-left overflow-hidden">
                                  <span className="text-xs font-bold text-slate-800 truncate" title={f.name}>{f.name}</span>
                                  <span className="text-[10px] text-slate-500 flex items-center gap-1.5">
                                    <Clock className="w-3 h-3 text-slate-400" />
                                    {f.size || 'KBs desconhecido'} • Analisado com sucesso
                                  </span>
                                </div>
                              </div>
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="h-8 w-8 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                                onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex-1 flex flex-col items-center justify-center py-8 text-slate-400">
                          <Book className="w-12 h-12 opacity-25 mb-2" />
                          <p className="text-xs uppercase font-bold tracking-widest text-[#94a3b8] text-center">Nenhum documento anexado ao gabinete ainda</p>
                        </div>
                      )}
                    </TabsContent>

                    {/* Tab: Historico */}
                    <TabsContent value="historico" className="m-0 focus-visible:ring-0">
                      <div className="space-y-3">
                        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                          <h4 className="text-xs font-bold text-amber-800 uppercase flex items-center gap-1.5">
                            <BookOpen className="w-4 h-4" /> Histórico de Sentenças
                          </h4>
                          <span className="text-[10px] font-mono bg-slate-100 font-bold text-slate-500 px-2 py-0.5 rounded">
                            {history.length} salvas
                          </span>
                        </div>
                        
                        {isLoadingHistory ? (
                          <div className="flex flex-col items-center justify-center p-12 text-slate-500 gap-2">
                            <Loader2 className="w-6 h-6 animate-spin text-amber-600" />
                            <span className="text-[10px] uppercase font-bold tracking-wider">Carregando Sentenças...</span>
                          </div>
                        ) : history.length === 0 ? (
                          <div className="p-8 text-center text-slate-400">
                            <Clock className="w-8 h-8 mx-auto mb-2 opacity-20" />
                            <p className="text-xs uppercase font-bold opacity-40">Nenhuma sentença salva ainda</p>
                            {!user && (
                              <p className="text-[10px] mt-1 text-slate-400">As sentenças serão salvas localmente neste navegador.</p>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-2.5 max-h-[350px] overflow-y-auto pr-1">
                            {!user && (
                              <div className="p-2.5 border border-amber-200/50 rounded-lg bg-amber-50/20 text-slate-600 text-[10px] font-medium leading-relaxed flex items-center justify-between gap-1 mb-2">
                                <span>⚡ Usando gabinete offline (salvo localmente).</span>
                                <button className="text-[9px] hover:underline font-bold text-amber-800 uppercase" onClick={openLoginModal}>
                                  Ativar nuvem
                                </button>
                              </div>
                            )}
                            {history.map((item) => (
                              <div key={item.id} className="group relative bg-[#fafbfc] hover:bg-amber-50/25 border border-slate-200 p-3.5 rounded-lg hover:border-amber-300 hover:shadow-sm transition-all text-left">
                                <div className="flex flex-col gap-1 pr-6">
                                  <span 
                                    className="text-xs font-bold text-slate-800 line-clamp-1 cursor-pointer hover:text-amber-700 transition-colors"
                                    onClick={() => {
                                      setGeneratedDraft(item.generatedText);
                                      if (item.metadata) {
                                        setAnalysis({
                                          numero_processo: item.metadata.numero_processo || '',
                                          reclamante: item.metadata.reclamante || '',
                                          reclamada: item.metadata.reclamada || '',
                                          vt: '',
                                          materia_principal: '',
                                          alegacoes_inicial: '',
                                          pedidos_inicial: '',
                                          alegacoes_contestacao: '',
                                          pedidos_contestacao: '',
                                          provas_produzidas: '',
                                          jurisprudencia: { trt4: '', tst: '', stf: '' }
                                        });
                                      }
                                      openDraftInNewTab(item.title || "Sentença", item.generatedText);
                                    }}
                                  >
                                    {item.title}
                                  </span>
                                  <span className="text-[10px] text-slate-400 flex items-center gap-1">
                                    <Clock className="w-3 h-3 text-slate-400" /> 
                                    {formatItemDate(item)}
                                  </span>
                                </div>
                                <div className="flex gap-2 mt-3 pt-2.5 border-t border-slate-200/50">
                                  <Button 
                                    variant="ghost" 
                                    size="sm" 
                                    className="h-7 px-2.5 text-[10px] font-bold uppercase bg-white border border-slate-200 hover:border-amber-300 text-slate-700 hover:bg-amber-50 hover:text-amber-900 rounded-md"
                                    onClick={() => {
                                      setGeneratedDraft(item.generatedText);
                                      if (item.metadata) {
                                        setAnalysis({
                                          numero_processo: item.metadata.numero_processo || '',
                                          reclamante: item.metadata.reclamante || '',
                                          reclamada: item.metadata.reclamada || '',
                                          vt: '',
                                          materia_principal: '',
                                          alegacoes_inicial: '',
                                          pedidos_inicial: '',
                                          alegacoes_contestacao: '',
                                          pedidos_contestacao: '',
                                          provas_produzidas: '',
                                          jurisprudencia: { trt4: '', tst: '', stf: '' }
                                        });
                                      }
                                      openDraftInNewTab(item.title || "Sentença", item.generatedText);
                                    }}
                                  >
                                    Abrir em Outra Guia (Histórico)
                                  </Button>
                                  <Button 
                                    variant="ghost" 
                                    size="sm" 
                                    className="h-7 px-2.5 text-[10px] font-bold uppercase text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md ml-auto"
                                    onClick={() => deleteFromHistory(item.id)}
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </TabsContent>
                    
                    {/* Empty lists logic */}
                    {!analysis && !isAnalyzing && (
                      <div className="h-full flex flex-col items-center justify-center py-16" />
                    )}
                    
                    {/* Loading State Overlay */}
                    {isAnalyzing && (
                      <div className="absolute inset-0 bg-white/90 z-25 flex flex-col items-center justify-center text-amber-800 p-8 text-center">
                        <Loader2 className="w-10 h-10 animate-spin text-amber-600 mb-4" />
                        <h4 className="text-xs font-bold uppercase tracking-widest text-slate-700 animate-pulse">Examinando Autos Digitais</h4>
                        <AnimatePresence mode="wait">
                          <motion.p 
                            key={loadingPhraseIndex}
                            initial={{ opacity: 0, y: 5 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -5 }}
                            className="text-xs text-slate-500 font-medium italic mt-2.5 max-w-xs"
                          >
                            {processingStatus || LOADING_STEPS[loadingPhraseIndex]}
                          </motion.p>
                        </AnimatePresence>
                      </div>
                    )}

                    {/* Active Analysis UI / Tab Contents */}
                    <div className="space-y-4 animate-in fade-in duration-300">
                      {/* Deadlines Summary Card at the top */}
                      {renderDeadlinesCard()}

                      {/* Process Folder Summary Widget */}
                      {activeAnalysisData && (
                        <div className="p-4 bg-slate-50 border border-slate-250 rounded-lg text-xs leading-relaxed shadow-inner">
                          <div className="flex justify-between border-b border-slate-200 pb-2 mb-2">
                            <span className="text-slate-500 font-bold uppercase flex items-center gap-1.5 tracking-wider text-[10px]">
                              <Shield className="w-3.5 h-3.5 text-amber-700" /> PROCESSO PRINCIPAL:
                            </span>
                            <span className="text-slate-900 font-mono font-bold bg-white px-2 py-0.5 border border-slate-200 rounded">
                              {activeAnalysisData.numero_processo}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                            <div className="flex flex-col">
                              <span className="text-slate-500 uppercase font-bold text-[9px] tracking-wide">Autor (Reclamante)</span>
                              <span className="text-slate-800 font-bold truncate">{activeAnalysisData.reclamante}</span>
                            </div>
                            <div className="flex flex-col">
                              <span className="text-slate-500 uppercase font-bold text-[9px] tracking-wide">Réu (Reclamada)</span>
                              <span className="text-slate-800 font-bold truncate">{activeAnalysisData.reclamada}</span>
                            </div>
                            <div className="flex flex-col col-span-2 border-t border-slate-200/50 pt-2">
                              <span className="text-slate-500 uppercase font-bold text-[9px] tracking-wide">Foro / Vara Distrital</span>
                              <span className="text-slate-700 truncate">{activeAnalysisData.vt || "Vara de Origem Não Identificada"}</span>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Tab Content: Alegações da Inicial */}
                      <TabsContent value="alegacoes" className="m-0 focus-visible:ring-0">
                        <div>
                          <div className="flex items-center justify-between pb-1.5 border-b border-amber-100 mb-2.5">
                            <h4 className="text-xs font-bold text-amber-800 uppercase flex items-center gap-1">
                              <span className="w-1.5 h-3 bg-amber-600 rounded"></span> Alegações da Inicial
                            </h4>
                            {!analysis && combinedSourceText.trim() && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[9.5px] uppercase font-bold text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded"
                                onClick={handleSilentExtraction}
                                disabled={isAnalyzing || isGenerating || isExtracting}
                              >
                                {isAnalyzing ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : "Extrair com IA"}
                              </Button>
                            )}
                          </div>
                          {activeAnalysisData?.alegacoes_inicial ? (
                            <div className="prose prose-slate prose-sm text-slate-700 text-[12px] leading-relaxed max-w-none">
                              <ReactMarkdown
                                components={{
                                  li: ({ node, ...props }) => (
                                    <li {...props} className="relative list-none pl-4 before:content-['•'] before:absolute before:left-0 before:text-amber-500 font-medium my-1" />
                                  ),
                                  ul: ({ node, ...props }) => <ul {...props} className="pl-0 space-y-1" />
                                }}
                              >
                                {activeAnalysisData.alegacoes_inicial}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <div className="py-8 text-center text-slate-400">
                              <FileText className="w-8 h-8 mx-auto opacity-25 mb-1.5" />
                              <p className="text-xs font-semibold uppercase text-slate-500">Nenhuma alegação identificada</p>
                              <p className="text-[10.5px] text-slate-400 mt-1">Anexe os autos do processo ou digite as alegações nas instruções.</p>
                            </div>
                          )}
                        </div>
                      </TabsContent>

                      {/* Tab Content: Rol de Pedidos */}
                      <TabsContent value="pedidos" className="m-0 focus-visible:ring-0">
                        <div>
                          <div className="flex items-center justify-between pb-1.5 border-b border-amber-100 mb-2.5">
                            <h4 className="text-xs font-bold text-amber-800 uppercase flex items-center gap-1">
                              <span className="w-1.5 h-3 bg-amber-600 rounded"></span> Rol do Pedido Inicial
                            </h4>
                            {!analysis && combinedSourceText.trim() && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[9.5px] uppercase font-bold text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded"
                                onClick={handleSilentExtraction}
                                disabled={isAnalyzing || isGenerating || isExtracting}
                              >
                                {isAnalyzing ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : "Extrair com IA"}
                              </Button>
                            )}
                          </div>
                          {activeAnalysisData?.pedidos_inicial ? (
                            <div className="prose prose-slate prose-sm text-slate-700 text-[12px] leading-relaxed max-w-none">
                              <ReactMarkdown
                                components={{
                                  li: ({ node, ...props }) => (
                                    <li {...props} className="relative list-none pl-4 before:content-['✓'] before:absolute before:left-0 before:text-emerald-500 font-semibold my-1" />
                                  ),
                                  ul: ({ node, ...props }) => <ul {...props} className="pl-0 space-y-1" />
                                }}
                              >
                                {activeAnalysisData.pedidos_inicial}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <div className="py-8 text-center text-slate-400">
                              <FileCheck className="w-8 h-8 mx-auto opacity-25 mb-1.5" />
                              <p className="text-xs font-semibold uppercase text-slate-500">Nenhum pedido identificado</p>
                              <p className="text-[10.5px] text-slate-400 mt-1">Anexe a petição inicial para identificação dos pedidos.</p>
                            </div>
                          )}
                        </div>
                      </TabsContent>

                      {/* Tab Content: Defesa */}
                      <TabsContent value="defesa" className="m-0 focus-visible:ring-0 space-y-4">
                        <div>
                          <div className="flex items-center justify-between pb-1.5 border-b border-amber-100 mb-2.5">
                            <h4 className="text-xs font-bold text-amber-800 uppercase flex items-center gap-1">
                              <span className="w-1.5 h-3 bg-amber-600 rounded"></span> Contestação (Resistência Fática)
                            </h4>
                            {!analysis && combinedSourceText.trim() && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[9.5px] uppercase font-bold text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded"
                                onClick={handleSilentExtraction}
                                disabled={isAnalyzing || isGenerating || isExtracting}
                              >
                                {isAnalyzing ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : "Extrair com IA"}
                              </Button>
                            )}
                          </div>
                          {activeAnalysisData?.alegacoes_contestacao ? (
                            <div className="prose prose-slate prose-sm text-slate-700 text-[12px] leading-relaxed max-w-none mb-4">
                              <ReactMarkdown
                                components={{
                                  li: ({ node, ...props }) => (
                                    <li {...props} className="relative list-none pl-4 before:content-['•'] before:absolute before:left-0 before:text-red-500 font-medium my-1" />
                                  ),
                                  ul: ({ node, ...props }) => <ul {...props} className="pl-0 space-y-1" />
                                }}
                              >
                                {activeAnalysisData.alegacoes_contestacao}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <p className="text-[11px] text-slate-400 italic mb-4">
                              Contestação não identificada nos arquivos anexados.
                            </p>
                          )}

                          <h4 className="text-xs font-bold text-purple-800 uppercase mb-2 pb-1 border-b border-purple-100 flex items-center gap-1">
                            <span className="w-1.5 h-3 bg-purple-600 rounded"></span> Impugnações de Pedidos
                          </h4>
                          {activeAnalysisData?.pedidos_contestacao ? (
                            <div className="prose prose-slate prose-sm text-slate-700 text-[12px] leading-relaxed max-w-none">
                              <ReactMarkdown
                                components={{
                                  li: ({ node, ...props }) => (
                                    <li {...props} className="relative list-none pl-4 before:content-['✕'] before:absolute before:left-0 before:text-purple-500 font-medium my-1" />
                                  ),
                                  ul: ({ node, ...props }) => <ul {...props} className="pl-0 space-y-1" />
                                }}
                              >
                                {activeAnalysisData.pedidos_contestacao}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <p className="text-[11px] text-slate-400 italic">
                              Nenhuma impugnação específica aos pedidos catalogada.
                            </p>
                          )}
                        </div>
                      </TabsContent>

                      {/* Tab Content: Provas */}
                      <TabsContent value="provas" className="m-0 focus-visible:ring-0">
                        <div>
                          <div className="flex items-center justify-between pb-1.5 border-b border-amber-100 mb-2.5">
                            <h4 className="text-xs font-bold text-amber-800 uppercase flex items-center gap-1">
                              <span className="w-1.5 h-3 bg-amber-600 rounded"></span> Resenha do Acervo Probatório
                            </h4>
                            {!analysis && combinedSourceText.trim() && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[9.5px] uppercase font-bold text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded"
                                onClick={handleSilentExtraction}
                                disabled={isAnalyzing || isGenerating || isExtracting}
                              >
                                {isAnalyzing ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : "Extrair com IA"}
                              </Button>
                            )}
                          </div>
                          {activeAnalysisData?.provas_produzidas ? (
                            <div className="prose prose-slate prose-sm text-slate-700 text-[12px] leading-relaxed max-w-none">
                              <ReactMarkdown
                                components={{
                                  li: ({ node, ...props }) => (
                                    <li {...props} className="relative list-none pl-4 before:content-[Doc.] before:absolute before:left-0 before:text-slate-400 font-medium my-1.5" />
                                  ),
                                  ul: ({ node, ...props }) => <ul {...props} className="pl-0 space-y-1" />
                                }}
                              >
                                {activeAnalysisData.provas_produzidas}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <div className="py-8 text-center text-slate-400">
                              <Book className="w-8 h-8 mx-auto opacity-25 mb-1.5" />
                              <p className="text-xs font-semibold uppercase text-slate-500">Nenhum acervo probatório catalogado</p>
                              <p className="text-[10.5px] text-slate-400 mt-1">Anexe os autos em PDF para catalogação das provas e depoimentos.</p>
                            </div>
                          )}
                        </div>
                      </TabsContent>

                      {/* Tab Content: Jurisprudência */}
                      <TabsContent value="juris" className="m-0 focus-visible:ring-0 space-y-3">
                        <h4 className="text-xs font-bold text-amber-800 uppercase pb-1 border-b border-amber-100 flex items-center gap-1 shrink-0">
                          <span className="w-1.5 h-3 bg-amber-600 rounded"></span> Súmulas e Entendimentos
                        </h4>
                        
                        <div className="bg-amber-50/40 p-4 rounded-lg border border-amber-100">
                          <h4 className="text-[11px] font-bold text-amber-800 uppercase mb-2 flex items-center gap-2">
                            <Gavel className="w-3.5 h-3.5" /> Regional TRT 4ª Região
                          </h4>
                          <div className="prose prose-amber prose-sm text-[11px] text-amber-900 leading-relaxed max-w-none">
                            <ReactMarkdown
                              components={{
                                li: ({ node, ...props }) => (
                                  <li {...props} className="relative list-none pl-3.5 before:content-['▪'] before:absolute before:left-0 before:text-amber-500 font-medium" />
                                ),
                                ul: ({ node, ...props }) => <ul {...props} className="pl-0 space-y-1" />
                              }}
                            >
                              {(typeof activeAnalysisData?.jurisprudencia === 'object' && activeAnalysisData?.jurisprudencia?.trt4)
                                ? activeAnalysisData.jurisprudencia.trt4
                                : (typeof activeAnalysisData?.jurisprudencia === 'string' ? activeAnalysisData.jurisprudencia : '- Súmula nº 37 do TRT4 (Honorários Advocatícios na Justiça do Trabalho - 10% sobre o valor da condenação liquefeita).')}
                            </ReactMarkdown>
                          </div>
                        </div>

                        <div className="bg-[#fafbfc] p-4 rounded-lg border border-slate-200">
                          <h4 className="text-[11px] font-bold text-slate-700 uppercase mb-2 flex items-center gap-2">
                            <Scale className="w-3.5 h-3.5" /> Superior Tribunal do Trabalho (TST)
                          </h4>
                          <div className="prose prose-slate prose-sm text-[11px] text-slate-600 leading-relaxed max-w-none">
                            <ReactMarkdown
                              components={{
                                li: ({ node, ...props }) => (
                                  <li {...props} className="relative list-none pl-3.5 before:content-['▪'] before:absolute before:left-0 before:text-slate-400 font-medium" />
                                ),
                                ul: ({ node, ...props }) => <ul {...props} className="pl-0 space-y-1" />
                              }}
                            >
                              {(typeof activeAnalysisData?.jurisprudencia === 'object' && activeAnalysisData?.jurisprudencia?.tst)
                                ? activeAnalysisData.jurisprudencia.tst
                                : '- Súmula 368 do TST (Descontos Previdenciários e Fiscais); OJ 400 da SDI-1 (Não incidência de imposto de renda sobre juros de mora).'}
                            </ReactMarkdown>
                          </div>
                        </div>

                        <div className="bg-slate-50 p-4 rounded-lg border border-slate-300">
                          <h4 className="text-[11px] font-bold text-slate-900 uppercase mb-2 flex items-center gap-2">
                            <Landmark className="w-3.5 h-3.5" /> Supremo Federal (STF)
                          </h4>
                          <div className="prose prose-slate prose-sm text-[11px] text-slate-700 leading-relaxed max-w-none">
                            <ReactMarkdown
                              components={{
                                li: ({ node, ...props }) => (
                                  <li {...props} className="relative list-none pl-3.5 before:content-['▪'] before:absolute before:left-0 before:text-slate-700 font-medium" />
                                ),
                                ul: ({ node, ...props }) => <ul {...props} className="pl-0 space-y-1" />
                              }}
                            >
                              {(typeof activeAnalysisData?.jurisprudencia === 'object' && activeAnalysisData?.jurisprudencia?.stf)
                                ? activeAnalysisData.jurisprudencia.stf
                                : '- Tema 1046 do STF (Validade de Acordos e Convenções Coletivas de Trabalho); ADI 5766 (Condição suspensiva de honorários na gratuidade da justiça).'}
                            </ReactMarkdown>
                          </div>
                        </div>
                      </TabsContent>
                    </div>
                  </div>
                </Tabs>
              </CardContent>
            </Card>

            {/* Directives and Guidelines */}
            <Card className="flex-1 bg-white border border-slate-250 shadow-sm rounded-xl overflow-hidden flex flex-col min-h-[30%]">
              <CardHeader className="py-2.5 px-4 bg-slate-50 border-b border-slate-200 flex flex-row items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <Label htmlFor="case-data" className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                    <FileEdit className="w-4 h-4 text-amber-700" /> Diretrizes Judiciais e Instruções
                  </Label>

                  {/* Autosave badge indicator */}
                  {autosaveStatus === 'saving' && (
                    <span className="inline-flex items-center gap-1 text-[9.5px] text-amber-700 bg-amber-50 border border-amber-200/80 px-2 py-0.5 rounded font-medium animate-pulse">
                      <Loader2 className="w-2.5 h-2.5 animate-spin text-amber-600" /> Salvando...
                    </span>
                  )}
                  {autosaveStatus === 'saved' && (
                    <span 
                      className="inline-flex items-center gap-1 text-[9.5px] text-emerald-700 bg-emerald-50 border border-emerald-200/80 px-2 py-0.5 rounded font-medium"
                      title={lastAutosaveTime ? `Salvo automaticamente no navegador às ${lastAutosaveTime.toLocaleTimeString()}` : 'Salvo no navegador'}
                    >
                      <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" /> 
                      {lastAutosaveTime ? `Salvo às ${lastAutosaveTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Salvo'}
                    </span>
                  )}
                  {autosaveStatus === 'idle' && lastAutosaveTime && (
                    <span 
                      className="inline-flex items-center gap-1 text-[9.5px] text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded font-medium"
                      title={`Restaurado do auto-salvamento anterior (${lastAutosaveTime.toLocaleTimeString()})`}
                    >
                      <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" /> Restaurado
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2.5">
                  {(caseDetails.trim() || isSumarissimo || isRevelia || isProcedenteTotal) && (
                    <button
                      type="button"
                      onClick={handleClearDirectives}
                      className="text-[10px] text-slate-400 hover:text-rose-600 transition-colors flex items-center gap-1 font-medium hover:underline"
                      title="Limpar texto e opções das diretrizes judiciais"
                    >
                      <Trash2 className="w-3 h-3" /> Limpar
                    </button>
                  )}
                  <span className="text-[10px] text-slate-400 font-medium hidden sm:inline" title="Todas as alterações nas diretrizes são preservadas no navegador">
                    Auto-salvamento ativo
                  </span>
                </div>
              </CardHeader>
              <CardContent className="p-3.5 flex-1 flex flex-col overflow-hidden">
                <div className="relative flex-1">
                  <Textarea 
                    id="case-data" 
                    placeholder="Instruções de ajuste da fundamentação fática... (Ex: 'Acolher pedido de horas extras sob fundamento testemunhal do autor; Fixar a prescrição para 15/05/2019')" 
                    className="w-full h-full min-h-[80px] resize-none focus-visible:ring-amber-500/10 focus-visible:border-amber-500 border-slate-250 rounded-xl text-xs bg-[#fafbfc]/35 p-3 leading-relaxed shadow-inner"
                    value={caseDetails}
                    onChange={(e) => setCaseDetails(e.target.value)}
                  />
                </div>
                
                <div className="flex items-center justify-between border-t border-slate-100 pt-3 mt-3 shrink-0">
                  <div className="flex flex-col">
                    <span className="text-[10.5px] font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                      <Scale className="w-3.5 h-3.5 text-amber-500" /> Rito Sumaríssimo (Art. 852-I da CLT)
                    </span>
                    <span className="text-[9.5px] text-slate-400">Ative para dispensar o relatório detalhado automaticamente</span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer select-none">
                    <input 
                      type="checkbox" 
                      checked={isSumarissimo} 
                      onChange={(e) => setIsSumarissimo(e.target.checked)} 
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-350 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                  </label>
                </div>

                <div className="flex items-center justify-between border-t border-slate-100 pt-3 mt-3 shrink-0">
                  <div className="flex flex-col">
                    <span className="text-[10.5px] font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 text-red-500" /> Revelia da Reclamada
                    </span>
                    <span className="text-[9.5px] text-slate-400">Omitir 2º parágrafo da Gratuidade e fixar Honorários de 10%</span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer select-none">
                    <input 
                      type="checkbox" 
                      checked={isRevelia} 
                      onChange={(e) => setIsRevelia(e.target.checked)} 
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-350 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                  </label>
                </div>

                <div className="flex items-center justify-between border-t border-slate-100 pt-3 mt-3 shrink-0">
                  <div className="flex flex-col">
                    <span className="text-[10.5px] font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-500" /> Procedência de Todos os Pedidos
                    </span>
                    <span className="text-[9.5px] text-slate-400">Fixar Honorários de 10% sobre o valor da condenação</span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer select-none">
                    <input 
                      type="checkbox" 
                      checked={isProcedenteTotal} 
                      onChange={(e) => setIsProcedenteTotal(e.target.checked)} 
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-350 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                  </label>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* RIGHT PANEL: Editor e Papel Administrativo */}
          <div className={cn(
            "flex flex-col overflow-hidden h-full transition-all duration-300",
            isLeftCollapsed ? "lg:col-span-12" : "lg:col-span-7"
          )}>
            <Card className="flex flex-col h-full bg-slate-900 border border-slate-950 shadow-xl rounded-xl overflow-hidden transition-all duration-200">
            
            {/* Header with primary actions aligned */}
            <CardHeader className="bg-slate-950 border-b border-slate-800/80 py-4 flex flex-row items-center justify-start space-y-0 px-6 shrink-0 z-10 shadow-sm flex-wrap gap-2.5">
              <Button 
                className="h-9 px-4 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-lg text-xs font-bold shadow-lg shadow-amber-500/10 hover:shadow-amber-500/20 active:scale-95 transition-all gap-1.5" 
                onClick={() => handleGenerate('standard')} 
                disabled={isGenerating || isAnalyzing || isExtracting || (!caseDetails.trim() && uploadedFiles.length === 0)}
              >
                {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 text-slate-950" />}
                MINUTAR SENTENÇA
              </Button>
              <Button 
                className="h-9 px-4 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold shadow-lg shadow-amber-600/10 hover:shadow-amber-600/20 active:scale-95 transition-all gap-1.5" 
                onClick={() => handleGenerate('ed')} 
                disabled={isGenerating || isAnalyzing || isExtracting || (!caseDetails.trim() && uploadedFiles.length === 0)}
              >
                {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5 text-white" />}
                MINUTAR SENTENÇA DE ED
              </Button>
              <Button 
                className="h-9 px-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-amber-400 rounded-lg text-xs font-bold shadow-lg shadow-slate-800/10 hover:shadow-slate-800/20 active:scale-95 transition-all gap-1.5" 
                onClick={() => setShowAnalyzeMinutaModal(true)} 
                disabled={isGenerating}
              >
                <Search className="w-3.5 h-3.5 text-amber-400" />
                ANALISAR MINUTA
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                className="gap-2 border-slate-800 bg-[#bfdbfe] hover:bg-[#93c5fd] text-slate-950 rounded-lg text-xs font-bold shadow-sm transition-colors py-2 h-9"
                onClick={handleDownload}
                disabled={!generatedDraft || isGenerating}
              >
                <Download className="w-3.5 h-3.5 text-slate-950" />
                EXPORTAR .DOCX
              </Button>
            </CardHeader>

            {/* Premium Secondary Formatting Toolbar */}
            <div className="bg-slate-950/45 border-b border-slate-800/60 py-3 px-6 flex items-center justify-between shrink-0 flex-wrap gap-3 z-10">
              <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 tracking-wider uppercase">
                <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                <span>Exibição e Formato</span>
              </div>

              <div className="flex items-center gap-2.5 flex-wrap">
                <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 gap-0.5 shadow-inner">
                  {/* Paper controls */}
                  <button 
                    type="button"
                    onClick={() => setPaperStyle('standard')} 
                    className={cn(
                      "px-2 py-1 text-[10px] font-bold rounded-md uppercase transition-all",
                      paperStyle === 'standard' ? "bg-white text-slate-900 shadow-sm" : "text-slate-400 hover:text-white"
                    )}
                    title="Papel Branco"
                  >
                    Branco
                  </button>
                  <button 
                    type="button"
                    onClick={() => setPaperStyle('cream')} 
                    className={cn(
                      "px-2 py-1 text-[10px] font-bold rounded-md uppercase transition-all",
                      paperStyle === 'cream' ? "bg-amber-100 text-amber-900 shadow-sm font-semibold" : "text-slate-400 hover:text-white"
                    )}
                    title="Papel de Época Conforto"
                  >
                    Marfim
                  </button>
                  <button 
                    type="button"
                    onClick={() => setPaperStyle('dark')} 
                    className={cn(
                      "px-2 py-1 text-[10px] font-bold rounded-md uppercase transition-all",
                      paperStyle === 'dark' ? "bg-slate-950 text-slate-100 shadow-sm" : "text-slate-400 hover:text-white"
                    )}
                    title="Leitura Noturna"
                  >
                    Noite
                  </button>
                </div>

                <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 gap-0.5 shadow-inner">
                  {/* Font pairing */}
                  <button 
                    type="button"
                    onClick={() => setPaperFont('serif')} 
                    className={cn(
                      "px-1.5 py-1 text-[10px] rounded transition-all font-serif",
                      paperFont === 'serif' ? "bg-slate-800 text-amber-400" : "text-slate-400 hover:text-white"
                    )}
                    title="Preparo Clássico (Georgia)"
                  >
                    Ag
                  </button>
                  <button 
                    type="button"
                    onClick={() => setPaperFont('sans')} 
                    className={cn(
                      "px-1.5 py-1 text-[10px] rounded transition-all font-sans font-bold",
                      paperFont === 'sans' ? "bg-slate-800 text-amber-400" : "text-slate-400 hover:text-white"
                    )}
                    title="Preparo Moderno (Inter)"
                  >
                    Ag
                  </button>
                  <button 
                    type="button"
                    onClick={() => setPaperFont('mono')} 
                    className={cn(
                      "px-1.5 py-1 text-[10px] rounded transition-all font-mono",
                      paperFont === 'mono' ? "bg-slate-800 text-amber-400" : "text-slate-400 hover:text-white"
                    )}
                    title="Preparo Técnico"
                  >
                    Aa
                  </button>
                </div>

                <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 gap-0.5 shadow-inner">
                  {/* Size toggler */}
                  <button 
                    type="button"
                    onClick={() => setPaperFontSize('sm')} 
                    className={cn(
                      "px-1.5 py-1 text-[9px] rounded font-bold uppercase transition-all",
                      paperFontSize === 'sm' ? "bg-slate-800 text-amber-400" : "text-slate-400 hover:text-white"
                    )}
                  >
                    A-
                  </button>
                  <button 
                    type="button"
                    onClick={() => setPaperFontSize('md')} 
                    className={cn(
                      "px-1.5 py-1 text-[9px] rounded font-bold uppercase transition-all",
                      paperFontSize === 'md' ? "bg-slate-800 text-amber-400" : "text-slate-400 hover:text-white"
                    )}
                  >
                    A
                  </button>
                  <button 
                    type="button"
                    onClick={() => setPaperFontSize('lg')} 
                    className={cn(
                      "px-1.5 py-1 text-[9px] rounded font-bold uppercase transition-all",
                      paperFontSize === 'lg' ? "bg-slate-800 text-amber-400" : "text-slate-400 hover:text-white"
                    )}
                  >
                    A+
                  </button>
                </div>

                <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 gap-0.5 shadow-inner" title="Largura da página">
                  <button 
                    type="button"
                    onClick={() => setIsFullWidthPaper(false)} 
                    className={cn(
                      "px-1.5 py-1 text-[9px] font-bold rounded-md uppercase transition-all",
                      !isFullWidthPaper ? "bg-white text-slate-900 shadow-sm" : "text-slate-400 hover:text-white"
                    )}
                  >
                    A4
                  </button>
                  <button 
                    type="button"
                    onClick={() => setIsFullWidthPaper(true)} 
                    className={cn(
                      "px-1.5 py-1 text-[9px] font-bold rounded-md uppercase transition-all",
                      isFullWidthPaper ? "bg-white text-slate-900 shadow-sm" : "text-slate-400 hover:text-white"
                    )}
                  >
                    Cheia
                  </button>
                </div>

                <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 gap-0.5 shadow-inner" title="Painel de Dados">
                  <button 
                    type="button"
                    onClick={() => setIsLeftCollapsed(false)} 
                    className={cn(
                      "px-1.5 py-1 text-[9px] font-bold rounded-md uppercase transition-all",
                      !isLeftCollapsed ? "bg-white text-slate-900 shadow-sm" : "text-slate-400 hover:text-white"
                    )}
                  >
                    Dividir
                  </button>
                  <button 
                    type="button"
                    onClick={() => setIsLeftCollapsed(true)} 
                    className={cn(
                      "px-1.5 py-1 text-[9px] font-bold rounded-md uppercase transition-all",
                      isLeftCollapsed ? "bg-white text-slate-900 shadow-sm" : "text-slate-400 hover:text-white"
                    )}
                  >
                    Foco
                  </button>
                </div>
              </div>
            </div>

            {/* Document sheet container with paper mockup style */}
            <CardContent className="flex-1 p-0 relative min-h-0 bg-slate-950 flex justify-center">
              <ScrollArea className="h-full w-full p-6" ref={scrollRef}>
                {generatedDraft ? (
                    <div 
                      className={cn(
                        "relative mx-auto my-4 p-10 md:p-14 border rounded shadow-2xl transition-all h-auto min-h-[842px] text-justify w-full",
                        isFullWidthPaper ? "max-w-full" : "max-w-[595pt]",
                        paperStyle === 'standard' ? "bg-white text-slate-900 border-slate-200" : 
                        paperStyle === 'cream' ? "bg-[#FAF7F0] text-slate-900 border-amber-200/40" : 
                        "bg-[#1A1A24] text-slate-100 border-slate-800"
                      )}
                      style={{ 
                        fontFamily: paperFont === 'serif' ? "'Georgia', 'Times New Roman', serif" : 
                                    paperFont === 'sans' ? "'Geist Variable', sans-serif" : 
                                    "monospace",
                        fontSize: paperFontSize === 'sm' ? "12px" : 
                                  paperFontSize === 'md' ? "14.5px" : 
                                  "17.5px",
                      }}
                    >
                      <div className="text-inherit leading-relaxed relative z-10 w-full" style={{ fontSize: 'inherit' }}>
                        <ReactMarkdown
                          components={{
                            li: ({ node, ...props }) => (
                              <li {...props} className="relative list-none pl-6 before:content-['-'] before:absolute before:left-0 before:text-slate-800 before:font-black dark:before:text-slate-200" />
                            ),
                            ul: ({ node, ...props }) => (
                              <ul {...props} className="pl-0 space-y-2" />
                            ),
                            // Markdown styling match
                            h1: ({node, ...props}) => {
                              const textStr = (props.children as any)?.toString() || '';
                              const cleanText = textStr.trim().toUpperCase();
                              const isSentenca = cleanText === 'SENTENÇA' || cleanText === 'SENTENCA' || cleanText.includes('SENTENÇA DE EMBARGOS') || cleanText.includes('SENTENCA DE EMBARGOS');
                              if (isSentenca) {
                                return <h1 {...props} className="text-inherit font-black text-center tracking-wide text-xl uppercase mt-8 mb-6 block w-full text-center" style={{ textAlign: 'center' }} />;
                              }
                              return <h1 {...props} className="text-inherit font-bold uppercase border-b pb-1 border-slate-300/30 tracking-tight mt-6 mb-2" />;
                            },
                            h2: ({node, ...props}) => {
                              const textStr = (props.children as any)?.toString() || '';
                              const cleanText = textStr.trim().toUpperCase();
                              const isSentenca = cleanText === 'SENTENÇA' || cleanText === 'SENTENCA' || cleanText.includes('SENTENÇA DE EMBARGOS') || cleanText.includes('SENTENCA DE EMBARGOS');
                              if (isSentenca) {
                                return <h2 {...props} className="text-inherit font-black text-center tracking-wide text-lg uppercase mt-6 mb-4 block w-full text-center" style={{ textAlign: 'center' }} />;
                              }
                              return <h2 {...props} className="text-inherit font-bold uppercase pb-0.5 tracking-tight mt-5 mb-1.5" />;
                            },
                            p: ({node, ...props}) => {
                              const textStr = (props.children as any)?.toString() || '';
                              const cleanText = textStr.trim().toUpperCase();
                              const isSentenca = cleanText === 'SENTENÇA' || cleanText === 'SENTENCA' || cleanText === '**SENTENÇA**' || cleanText.includes('SENTENÇA DE EMBARGOS') || cleanText.includes('SENTENCA DE EMBARGOS');
                              if (isSentenca) {
                                return (
                                  <p {...props} className="text-center font-bold text-inherit leading-relaxed text-lg uppercase my-6 tracking-wide block w-full text-center" style={{ textIndent: 0, textAlign: 'center' }} />
                                );
                              }
                              return <p {...props} className="text-justify my-3 text-inherit leading-relaxed indent-8" />;
                            },
                            strong: ({node, ...props}) => {
                              const textStr = (props.children as any)?.toString() || '';
                              const cleanText = textStr.trim().toUpperCase();
                              const isSentenca = cleanText === 'SENTENÇA' || cleanText === 'SENTENCA' || cleanText.includes('SENTENÇA DE EMBARGOS') || cleanText.includes('SENTENCA DE EMBARGOS');
                              if (isSentenca) {
                                return (
                                  <strong {...props} className="text-center font-black text-inherit text-lg uppercase block w-full my-4 text-center" style={{ textAlign: 'center' }} />
                                );
                              }
                              return <strong {...props} className="font-bold" />;
                            }
                          }}
                        >
                          {ensureSentencaHeading(generatedDraft)}
                        </ReactMarkdown>
                      </div>
                    </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full min-h-[500px]" />
                )}
              </ScrollArea>

              {/* Advanced Loading Mask */}
              {isGenerating && (
                <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-[3px] flex items-center justify-center transition-all duration-300 z-50">
                  <div className="bg-slate-900 px-8 py-6 shadow-2xl border border-slate-800 flex flex-col items-center gap-4 text-amber-500 rounded-2xl max-w-sm text-center">
                    <Loader2 className="w-10 h-10 animate-spin text-amber-500" />
                    <div>
                      <h4 className="font-extrabold text-sm tracking-widest uppercase text-slate-100">PREPARANDO MINUTA</h4>
                      <p className="mt-2 text-xs text-slate-300" role="status">{processingStatus}</p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>

            {/* Success signature footer */}
            {generatedDraft && !isGenerating && draftComplete && (
              <footer className="h-11 bg-slate-950 border-t border-slate-800/80 flex items-center justify-between px-6 shrink-0 z-10 select-none shadow">
                <div className="flex items-center gap-4 text-xs font-semibold text-slate-400">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span> Minuta Lavrada Com Sucesso</span>
                  <span className="text-slate-600">|</span>
                  <span className="font-mono text-[10px] text-amber-500/80">{generatedDraft.length} caracteres gerados</span>
                </div>
                <span className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-widest">Justiça do Trabalho</span>
              </footer>
            )}
            </Card>
          </div>

        </div>
      </section>

      {/* Login Offer Modal under AnimatePresence */}
      <AnimatePresence>
        {showLoginOffer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden"
            >
              <div className="p-6 text-center">
                <div className="w-14 h-14 bg-amber-50 rounded-full flex items-center justify-center mx-auto mb-4 border border-amber-200">
                  <History className="w-7 h-7 text-amber-600" />
                </div>
                <h3 className="text-lg font-bold text-slate-800 mb-2">Ative seu Histórico de Minutas</h3>
                <p className="text-xs text-slate-500 mb-4 leading-relaxed">
                  Faça login com sua conta do Google para ativar o salvamento automático das suas análises e minutas de sentença no Gabinete Digital.
                </p>

                {/* Google Verification / Testing Warning Block */}
                <div className="mb-4 text-[10.5px] text-amber-800 bg-amber-50/70 border border-amber-250/50 rounded-xl p-3.5 leading-relaxed text-left space-y-1">
                  <div className="flex items-center gap-1.5 font-bold text-amber-900">
                    <Sparkles className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                    Bypass de Erro 403 (App não verificado)
                  </div>
                  <p className="text-slate-600 font-normal leading-normal">
                    Se você receber o bloqueio <strong>"O app não concluiu o processo de verificação do Google"</strong>, utilize o <strong>Acesso Rápido</strong> por e-mail abaixo. Ele ignora o bloqueio do Google e ativa seu gabinete completo na hora!
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  {authError && (
                    <div className="mb-3 text-[11px] text-red-600 bg-red-50 border border-red-100 rounded-lg p-2.5 leading-relaxed text-left">
                      <strong>Erro de login:</strong> {authError}
                      <p className="mt-1.5 text-[10px] text-slate-500 leading-normal">
                        * Dica: Se o login persistir em não abrir, certifique-se de habilitar pop-ups no navegador ou clique no botão de abrir em nova aba no canto superior direito do painel para usar o ambiente fora do iframe.
                      </p>
                    </div>
                  )}
                  <Button
                    onClick={handleLogin}
                    disabled={isSigningIn}
                    className="w-full bg-slate-900 text-white hover:bg-slate-800 py-2.5 rounded-lg flex items-center justify-center gap-2 font-semibold text-xs shadow-md shadow-slate-900/10 transition-all active:scale-[0.98]"
                  >
                    {isSigningIn ? (
                      <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                    ) : (
                      <LogIn className="w-4 h-4 text-amber-400" />
                    )}
                    {isSigningIn ? "Conectando..." : "Entrar com Google"}
                  </Button>

                  <div className="relative my-3">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-slate-100"></span>
                    </div>
                    <div className="relative flex justify-center text-[10px] uppercase tracking-wider font-semibold">
                      <span className="bg-white px-2.5 text-slate-400">Ou use Acesso Rápido</span>
                    </div>
                  </div>

                  <div className="bg-slate-50/80 border border-slate-100 rounded-xl p-3 text-left space-y-2.5">
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Acesso via E-mail</label>
                      <div className="flex gap-1.5 mt-1">
                        <input
                          type="email"
                          placeholder="Digite seu e-mail"
                          value={emailInput}
                          onChange={(e) => {
                            setEmailInput(e.target.value);
                            setEmailLoginError(null);
                          }}
                          className="flex-1 text-xs border border-slate-200 bg-white rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-500/30 focus:border-amber-500 text-slate-800"
                        />
                        <Button
                          type="button"
                          onClick={() => handleEmailLogin()}
                          className="bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold px-3 py-1.5 rounded-lg text-xs shrink-0"
                        >
                          Entrar
                        </Button>
                      </div>
                      {emailLoginError && (
                        <p className="text-[10px] text-red-500 mt-1 font-medium">{emailLoginError}</p>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleEmailLogin('gilianiromano@gmail.com')}
                      className="w-full bg-amber-50 hover:bg-amber-100 border border-amber-100/80 text-amber-900 text-[10px] font-bold py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 transition-all active:scale-[0.98]"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-amber-600 animate-pulse" />
                      Entrar como gilianiromano@gmail.com
                    </button>
                  </div>

                  <Button
                    variant="ghost"
                    onClick={() => {
                      setShowLoginOffer(false);
                      setAuthError(null);
                      setEmailLoginError(null);
                      setEmailInput('');
                    }}
                    disabled={isSigningIn}
                    className="w-full text-xs font-semibold text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg py-2.5 h-10 mt-1"
                  >
                    Continuar sem Histórico
                  </Button>
                </div>
              </div>
              <div className="bg-slate-50 px-6 py-3 border-t border-slate-100 flex items-center justify-center gap-1.5 text-[10px] text-slate-400 font-medium">
                <Shield className="w-3.5 h-3.5 text-slate-400" /> Seus dados de gabinete estão protegidos e não são compartilhados.
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Analisar Minuta Modal */}
      <AnimatePresence>
        {showAnalyzeMinutaModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="bg-slate-900 text-slate-100 rounded-2xl max-w-4xl w-full max-h-[90vh] shadow-2xl border border-slate-800 flex flex-col overflow-hidden"
            >
              {/* Modal Header */}
              <div className="px-6 py-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-amber-500/10 text-amber-500 rounded-lg flex items-center justify-center border border-amber-500/20">
                    <Search className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">Análise de Minuta de Sentença</h3>
                    <p className="text-[11px] text-slate-400">Verificação de consistência, julgamento de pedidos, valoração de provas e diretrizes</p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (!isAnalyzingMinuta) {
                      setShowAnalyzeMinutaModal(false);
                    }
                  }}
                  disabled={isAnalyzingMinuta}
                  className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-all disabled:opacity-50"
                >
                  <span className="text-xl font-bold">&times;</span>
                </button>
              </div>

              {/* Modal Body */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6 min-h-0">
                {minutaAnalysisResult ? (
                  /* RESULTS VIEW */
                  <div className="space-y-4 flex flex-col h-full min-h-0">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-amber-500 uppercase tracking-widest flex items-center gap-2">
                        <FileCheck className="w-4 h-4 text-amber-500" /> Relatório de Auditoria Jurídica
                      </h4>
                      {isAnalyzingMinuta && (
                        <span className="flex items-center gap-1.5 text-xs text-amber-500/80">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Atualizando parecer em tempo real...
                        </span>
                      )}
                    </div>
                    
                    <div className="flex-1 min-h-[300px] max-h-[55vh] bg-slate-950 p-6 border border-slate-800 rounded-xl overflow-y-auto text-justify text-slate-100 prose prose-invert max-w-none">
                      <ReactMarkdown
                        components={{
                          h1: ({node, ...props}) => <h1 {...props} className="text-lg font-bold text-slate-100 border-b border-slate-800 pb-2 mt-6 mb-4 uppercase tracking-wide" />,
                          h2: ({node, ...props}) => <h2 {...props} className="text-sm font-bold text-amber-500 mt-5 mb-3 uppercase tracking-wider" />,
                          h3: ({node, ...props}) => <h3 {...props} className="text-xs font-bold text-slate-300 mt-4 mb-2" />,
                          p: ({node, ...props}) => <p {...props} className="text-xs text-slate-300 leading-relaxed my-2" />,
                          ul: ({node, ...props}) => <ul {...props} className="list-disc pl-5 my-2 text-xs text-slate-300 space-y-1" />,
                          li: ({node, ...props}) => <li {...props} className="leading-relaxed" />,
                          strong: ({node, ...props}) => <strong {...props} className="font-semibold text-white bg-slate-800/40 px-1 py-0.5 rounded" />
                        }}
                      >
                        {minutaAnalysisResult}
                      </ReactMarkdown>
                    </div>

                    {minutaAnalysisError && (
                      <div className="text-xs text-red-400 bg-red-950/45 border border-red-900 p-3 rounded-lg flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{minutaAnalysisError}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  /* INPUT VIEW */
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full">
                    {/* Left/Main Column: Text input and file import */}
                    <div className="lg:col-span-8 flex flex-col space-y-4">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-1.5">
                          <FileEdit className="w-3.5 h-3.5 text-amber-500" /> Texto da Minuta de Sentença
                        </label>
                        <button
                          type="button"
                          onClick={() => minutaFileInputRef.current?.click()}
                          className="text-xs text-amber-500 hover:text-amber-400 font-bold flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 shadow hover:border-slate-700 transition-all cursor-pointer"
                        >
                          {isExtractingMinutaFile ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileUp className="w-3 h-3" />}
                          Importar Arquivo (.docx, .txt)
                        </button>
                        <input
                          type="file"
                          accept=".docx,.txt"
                          className="hidden"
                          ref={minutaFileInputRef}
                          onChange={handleMinutaFileUpload}
                        />
                      </div>

                      <div className="relative flex-1 min-h-[250px] bg-slate-950 rounded-xl border border-slate-800 overflow-hidden shadow-inner flex flex-col">
                        {minutaFileName && (
                          <div className="px-4 py-2 bg-slate-950 border-b border-slate-800/80 flex items-center justify-between text-[11px] font-semibold text-slate-400 shrink-0">
                            <span className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-emerald-500"></span> 
                              Importado de: <strong className="text-slate-200">{minutaFileName}</strong>
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setMinutaText('');
                                setMinutaFileName('');
                              }}
                              className="text-red-400 hover:text-red-300 font-bold"
                            >
                              Limpar
                            </button>
                          </div>
                        )}
                        <textarea
                          className="flex-1 w-full bg-transparent text-slate-100 p-4 font-sans text-xs leading-relaxed focus:outline-none resize-none placeholder:text-slate-600 min-h-[300px]"
                          placeholder="Cole o texto da minuta de sentença a ser analisada aqui, ou use o botão acima para importar um arquivo .docx..."
                          value={minutaText}
                          onChange={(e) => setMinutaText(e.target.value)}
                        />
                      </div>
                    </div>

                    {/* Right/Sidebar Column: Guidelines and Autos Info */}
                    <div className="lg:col-span-4 space-y-4">
                      {/* Process/Autos Status Card */}
                      <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3 shadow">
                        <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Autos do Processo</h4>
                        {uploadedFiles.length > 0 ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 text-emerald-500 font-bold text-xs">
                              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                              Processo Associado
                            </div>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                              A minuta será confrontada com as alegações, pedidos e provas contidos nos <strong>{uploadedFiles.length} arquivo(s)</strong> carregados no painel lateral de Documentos.
                            </p>
                            <div className="max-h-[80px] overflow-y-auto border-t border-slate-800/80 pt-2 space-y-1">
                              {uploadedFiles.map((f, idx) => (
                                <div key={idx} className="text-[10px] text-slate-400 truncate flex items-center gap-1">
                                  <span className="text-slate-600">•</span> {f.name}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 text-amber-500 font-bold text-xs">
                              <AlertCircle className="w-3.5 h-3.5" />
                              Nenhum processo carregado
                            </div>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                              Você pode realizar a análise isolada da minuta (auditoria de diretrizes e correção jurídica lógica), mas para confrontar com as alegações e provas das partes, anexe os autos (PDF) na aba <strong>Anexos</strong> do painel principal antes de rodar a análise.
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Criteria verified Card */}
                      <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3 shadow text-xs">
                        <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Critérios Avaliados</h4>
                        <ul className="space-y-2 text-[11px] text-slate-400">
                          <li className="flex items-start gap-1.5">
                            <span className="text-amber-500 mt-0.5">✓</span>
                            <span><strong>Julgamento Completo:</strong> Cobertura de todas as preliminares e pedidos.</span>
                          </li>
                          <li className="flex items-start gap-1.5">
                            <span className="text-amber-500 mt-0.5">✓</span>
                            <span><strong>Suficiência de Provas:</strong> Coerência com depoimentos e laudos dos autos.</span>
                          </li>
                          <li className="flex items-start gap-1.5">
                            <span className="text-amber-500 mt-0.5">✓</span>
                            <span><strong>Regras de Improcedência:</strong> Supressão de juros, compensações e recolhimentos.</span>
                          </li>
                          <li className="flex items-start gap-1.5">
                            <span className="text-amber-500 mt-0.5">✓</span>
                            <span><strong>Prescrição Quinquenal:</strong> Aplicação condicional criteriosa.</span>
                          </li>
                          <li className="flex items-start gap-1.5">
                            <span className="text-amber-500 mt-0.5">✓</span>
                            <span><strong>Formatação e IDs:</strong> Padronização de títulos e referências probatórias.</span>
                          </li>
                        </ul>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="px-6 py-4 bg-slate-950 border-t border-slate-800 flex items-center justify-between shrink-0">
                <div>
                  {minutaAnalysisError && !minutaAnalysisResult && (
                    <div className="text-xs text-red-400 flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>{minutaAnalysisError}</span>
                    </div>
                  )}
                  {isAnalyzingMinuta && !minutaAnalysisResult && (
                    <div className="text-xs text-amber-500 flex items-center gap-1.5">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Iniciando auditoria jurídica da minuta...</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {minutaAnalysisResult ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setMinutaAnalysisResult('');
                          setMinutaFileName('');
                          setMinutaAnalysisError(null);
                        }}
                        className="bg-transparent border-slate-800 hover:bg-slate-800 text-slate-300 text-xs py-2 h-9 rounded-lg font-bold"
                      >
                        Nova Análise
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(minutaAnalysisResult);
                        }}
                        className="bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs py-2 h-9 rounded-lg font-bold flex items-center gap-1.5"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Copiar Relatório
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          setShowAnalyzeMinutaModal(false);
                        }}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs py-2 h-9 rounded-lg font-bold"
                      >
                        Fechar
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setShowAnalyzeMinutaModal(false);
                        }}
                        disabled={isAnalyzingMinuta}
                        className="text-slate-400 hover:text-white text-xs hover:bg-slate-800 h-9 rounded-lg"
                      >
                        Cancelar
                      </Button>
                      <Button
                        onClick={handleAnalyzeMinuta}
                        disabled={isAnalyzingMinuta || !minutaText.trim() || isExtractingMinutaFile}
                        className="bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-bold px-5 py-2 h-9 rounded-lg flex items-center gap-1.5 shadow shadow-amber-500/10 hover:shadow-amber-500/20 active:scale-95 transition-all"
                      >
                        {isAnalyzingMinuta ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                        {isAnalyzingMinuta ? "Analisando..." : "Analisar Minuta"}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

