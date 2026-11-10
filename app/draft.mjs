// Draft preparation from the collected sources. Deterministic and local: it quotes, it never
// composes clinical reasoning. Every proposal carries the excerpt it came from, and nothing is
// applied to a field without an explicit acceptance.
const fold = value => String(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const SPEAKER = /^\s*([^:]{2,40}?)\s*:\s*(.+)$/;
const PATIENT = /paciente|pessoa|sr\.?|sra\.?/i;
const DOCTOR = /m[ée]dic|dra?\.?|nutri/i;
const DOSE = /\b\d{1,4}(?:[.,]\d{1,3})?\s*(mg|mcg|µg|g|ml|mL|ui|UI|comprimidos?|c[áa]psulas?|gotas?)\b/;
const NUMBER_NO_UNIT = /\b\d{1,4}[.,]\d{1,3}\b(?!\s*(?:mg|mcg|µg|g|ml|mL|ui|UI|%|kg|bpm|mmHg|comprimido|c[áa]psula|gota))/;
const NEGATION = /\b(n[ãa]o|nunca|parou|parei|suspend\w+|interromp\w+|deixei|deixou|sem)\b/i;
const UNCERTAIN = /\b(acho|talvez|n[ãa]o (?:sei|lembro|tenho certeza)|a confirmar|preciso conferir|pode ser|incerto)\b/i;
const MEDICATION = /\b(?:tomo|tomando|uso|usando|em uso de|receit\w+|prescrev\w+|medicament\w+|rem[ée]dio)\b/i;

// Splits the transcript into attributable utterances. Without speaker marks nothing is attributed.
export function utterances(text) {
  const out = [];
  String(text).split(/(?<=[.!?])\s+(?=[A-ZÁÂÃÀÉÊÍÓÔÕÚÇ])|\r?\n/).forEach((chunk, index) => {
    const raw = chunk.trim();
    if (!raw) return;
    const speaker = SPEAKER.exec(raw);
    const quem = speaker ? (DOCTOR.test(speaker[1]) ? 'profissional' : PATIENT.test(speaker[1]) ? 'pessoa atendida' : 'indefinido') : 'indefinido';
    out.push({ index, quem, rotulo: speaker ? speaker[1].trim() : null, texto: speaker ? speaker[2].trim() : raw });
  });
  return out;
}

let counter = 0;
const proposal = (campo, texto, evidencia, extra = {}) => ({ id: `p${++counter}`, campo, texto, evidencia, ...extra });

export function buildDraft({ transcript = '', currentEntry = '', exams = [], examsMeta = {}, bia = [], biaMeta = {}, patient = '', consultaDate = '' } = {}) {
  counter = 0;
  const falas = utterances(transcript);
  const propostas = [], pendencias = [];
  const add = (tipo, mensagem, trecho = null) => pendencias.push({ tipo, mensagem, trecho });

  if (!falas.some(f => f.quem !== 'indefinido')) add('atribuição', 'A transcrição não identifica quem falou. Nenhuma frase foi atribuída à pessoa atendida ou à profissional; confira a autoria antes de aceitar qualquer proposta.');

  // "Em uso de" candidates. A mentioned medication is not a medication in use.
  for (const fala of falas) {
    if (!MEDICATION.test(fala.texto) && !DOSE.test(fala.texto)) continue;
    const negada = NEGATION.test(fala.texto), incerta = UNCERTAIN.test(fala.texto);
    propostas.push(proposal('medications', fala.texto, { fonte: 'transcrição', quem: fala.quem, trecho: fala.texto },
      { requerConfirmacao: true, alerta: [
        negada && 'A frase contém negação ou interrupção. Não registre como medicamento em uso sem confirmar.',
        incerta && 'A frase expressa dúvida. Mantenha a dúvida registrada em vez de completá-la.',
        fala.quem !== 'profissional' && 'Fala atribuída à pessoa atendida ou sem autoria; menção não equivale a prescrição.',
      ].filter(Boolean) }));
    if (DOSE.test(fala.texto) && NUMBER_NO_UNIT.test(fala.texto.replace(DOSE, ''))) add('medicamentos', 'Há um número sem unidade próximo a uma dose. Confirme valor e unidade no original.', fala.texto);
    else if (!DOSE.test(fala.texto) && NUMBER_NO_UNIT.test(fala.texto)) add('medicamentos', 'Número sem unidade em uma frase sobre medicação. Confirme a unidade antes de registrar.', fala.texto);
    if (negada) add('negações', 'Frase com negação relacionada a medicação. Verifique se o item deve sair de “Em uso de”.', fala.texto);
  }

  // Evolution candidates: the day's entry already written stays as the base, quotes are offered as additions.
  if (currentEntry.trim()) propostas.push(proposal('evolution', currentEntry.trim(), { fonte: 'prontuário', quem: 'profissional', trecho: 'Entrada do dia já registrada no HTML' }, { base: true }));
  else add('cronologia', 'A entrada do dia não foi localizada no HTML. Confirme se o atendimento já foi registrado antes de gravar uma nova evolução.');
  for (const fala of falas.filter(f => f.quem === 'profissional' && !MEDICATION.test(f.texto) && f.texto.length > 20)) {
    propostas.push(proposal('evolution', fala.texto, { fonte: 'transcrição', quem: fala.quem, trecho: fala.texto }, { requerConfirmacao: true }));
  }

  // Identity has to hold across sources.
  if (patient.trim()) {
    const alvo = fold(patient);
    const primeiro = alvo.split(/\s+/)[0];
    if (primeiro.length > 2 && !fold(transcript).includes(primeiro) && !fold(currentEntry).includes(primeiro)) {
      add('identidade', 'A identificação confirmada não aparece na transcrição nem na entrada do dia. Confirme que todas as fontes são da mesma pessoa.');
    }
    if (examsMeta.paciente && fold(examsMeta.paciente).split(/\s+/)[0] !== primeiro) {
      add('identidade', `O documento de exames traz outro nome (${examsMeta.paciente}). Não incorpore resultados de outra pessoa.`);
    }
  } else add('identidade', 'Identificação não confirmada. Confirme pessoa, data e modalidade antes de preparar rascunhos.');

  for (const item of [...exams, ...bia].filter(i => i.confianca === 'baixa')) {
    add('leitura', `${item.analito ? `“${item.analito}”` : 'Uma linha'} não foi lida com segurança: ${item.motivo} Resultado ilegível não é resultado normal.`, item.bruto);
  }

  // Conflicts are shown, never resolved by precedence.
  const porAnalito = new Map();
  for (const item of [...exams.map(i => ({ ...i, fonte: 'exames' })), ...bia.map(i => ({ ...i, fonte: 'bioimpedância' }))]) {
    if (!item.analito || item.confianca === 'baixa') continue;
    const chave = fold(item.analito);
    const anterior = porAnalito.get(chave);
    if (anterior && (anterior.valor !== item.valor || anterior.unidade !== item.unidade)) {
      const metodos = [examsMeta.metodo, biaMeta.metodo].filter(Boolean);
      const nota = metodos.length === 2 && fold(metodos[0]) !== fold(metodos[1])
        ? ` Os documentos usam métodos diferentes (${metodos.join(' e ')}); medidas de métodos distintos não são comparáveis entre si.` : '';
      add('conflito', `“${item.analito}” aparece com valores diferentes em ${anterior.fonte} (${anterior.valor} ${anterior.unidade || ''}) e em ${item.fonte} (${item.valor} ${item.unidade || ''}). Confirme qual vale; nenhuma fonte tem prioridade automática.${nota}`);
    } else porAnalito.set(chave, item);
  }
  if (consultaDate && !/^\d{4}-\d{2}-\d{2}$/.test(consultaDate)) add('cronologia', 'Data do atendimento inválida.');

  return { propostas, pendencias };
}
