// Exam transcription. Values, units and references are copied as written; nothing is converted,
// rounded or completed. A line that cannot be read stays visible as a pending item and never
// becomes a normal result.
const META = [
  ['laboratorio', /^\s*laborat[óo]rio\s*[:\-]\s*(.+)$/i],
  ['data', /^\s*(?:data(?:\s+d[ae]\s+(?:coleta|exame))?|coleta)\s*[:\-]\s*(.+)$/i],
  ['metodo', /^\s*m[ée]todo\s*[:\-]\s*(.+)$/i],
  ['solicitante', /^\s*(?:solicitante|requisitante)\s*[:\-]\s*(.+)$/i],
  ['paciente', /^\s*(?:paciente|nome)\s*[:\-]\s*(.+)$/i],
];
const RESULT = /^\s*(?<analito>[^:|]{2,80}?)\s*[:|]\s*(?<resto>\S.*)$/;
// Cabeçalho e rodapé de laudo não carregam resultado. Sem isso, uma linha como
// "Impresso em: 00/00/0000 00:00 — Página 1/15" era lida como um analito chamado "Impresso em".
const CHROME = /^(?:impresso\s+em|p[áa]gina\b|data\s+da\s+ficha|ficha|conv[êe]nio|assinatura\s+digital|laudado\s+e\s+assinado|liberado\s+em|exame\s+realizado\s+em|m[ée]dico|solicitante|cliente|data\s+de\s+nascimento|sexo|idade|protocolo|requisi[çc][ãa]o|unidade\s+de\s+atendimento)\b/i;
// Uma unidade de laboratório é um símbolo conhecido, não qualquer texto que venha depois do número.
const UNIT = /^(?:%|mg\/dL|mg\/L|g\/dL|g\/L|g|mg|µg\/dL|ug\/dL|mcg\/dL|µg\/L|ug\/L|ng\/mL|ng\/dL|ng\/L|pg\/mL|pg|fL|µUI\/mL|uUI\/mL|mUI\/L|mUI\/mL|UI\/mL|UI\/L|U\/L|U\/mL|mmol\/L|µmol\/L|umol\/L|nmol\/L|mEq\/L|mOsm\/kg|mm\/h|mmHg|mm³|mm3|\/mm³|\/mm3|\/µL|\/uL|10\^?[36]\/[µu]L|mil\/mm³|milh[õo]es\/mm³|kg|kg\/m²|cm|kcal|kcal\/24h|kcal\/dia|anos|L|mL|mL\/min(?:\/1[.,]73\s*m²)?|c[óo]pias\/mL|segundos|s)$/i;
const VALUE = /^(?<sinal>[<>≤≥]\s*)?(?<numero>\d{1,6}(?:[.,]\d{1,4})?)\s*(?<resto>.*)$/;
const REFERENCE = /\(\s*(?:vr|v\.r\.|ref(?:er[êe]ncia)?\.?)\s*[:\s]\s*(?<ref>[^)]+)\)/i;
export const DATE_BR = /\b(\d{2})\/(\d{2})\/(\d{4})\b/;
// Um laudo real pode nomear o analito numa linha de título separada e escrever só a palavra
// genérica "RESULTADO:" na linha do valor. Sem isso, "RESULTADO" virava o próprio nome do
// analito — um resultado sem identificação, aceito como se fosse confiável.
const ANCHOR = /^\s*RESULTADOS?\b.*\bREFER[ÊE]NCIAS?\b/i;
const COLUMN_HEADER = /^\s*(?:valores?\s+de\s+refer[êe]ncias?|resultados?|refer[êe]ncias?|unidades?|material)\s*$/i;
const GENERIC_LABEL = /^resultados?$/i;
// Uma palavra como "idade" é ruído de cabeçalho quando vem com dois-pontos ("Idade: 45 anos", um
// dado da pessoa, não um resultado) mas é um título de seção legítimo num painel de bioimpedância
// ("Idade" numa linha, o valor "62 anos" na linha seguinte). O dois-pontos já distingue os casos:
// isHeading exige ausência de dois-pontos, então não precisa repetir a exclusão de CHROME aqui.
const isHeading = line => {
  if (line.includes(':') || line.length < 3 || line.length > 90 || ANCHOR.test(line) || COLUMN_HEADER.test(line)) return false;
  const letras = line.match(/\p{L}/gu) || [];
  if (letras.length < 3) return false;
  return letras.filter(c => c === c.toUpperCase()).length / letras.length > 0.6;
};

function lerValor(resto) {
  const reference = REFERENCE.exec(resto);
  const semRef = resto.replace(REFERENCE, '').trim();
  const value = VALUE.exec(semRef);
  if (!value) return null;
  const bruta = value.groups.resto.replace(/[.;,]\s*$/, '').trim();
  const unidade = UNIT.test(bruta) ? bruta : null;
  const motivo = unidade ? null
    : bruta ? `Não reconheci “${bruta}” como unidade de exame. Confira a linha no documento original.`
    : 'Unidade ausente na linha. Confirme antes de incorporar.';
  return {
    valor: (value.groups.sinal ? value.groups.sinal.replace(/\s+/g, '') : '') + value.groups.numero,
    unidade,
    referencia: reference ? reference.groups.ref.trim() : null,
    confianca: unidade ? 'normal' : 'baixa',
    motivo,
  };
}

export function parseExams(text, { page = 1 } = {}) {
  const meta = {}, items = [];
  const lines = String(text).split(/\r?\n/);
  let titulo = null, cabecalhoAnterior = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    let viaMeta = false;
    for (const [key, pattern] of META) {
      const found = pattern.exec(line);
      if (found && !meta[key]) { meta[key] = found[1].trim(); viaMeta = true; break; }
    }
    if (viaMeta) continue;
    const locator = { page, line: index + 1, quote: line };
    // Um painel de bioimpedância pode nomear a seção em duas linhas seguidas ("Taxa Metabólica" +
    // "Basal") antes do valor. Não juntamos as duas: um título curto logo após outro título pode
    // ser coisa não relacionada (ex.: letreiro seguido do nome do primeiro exame). Fica só a mais
    // recente — "Basal" sozinho, incompleto mas não errado, é mais seguro que juntar títulos que
    // não têm relação nenhuma.
    if (isHeading(line)) { titulo = line; cabecalhoAnterior = true; continue; }
    const eraCabecalho = cabecalhoAnterior; cabecalhoAnterior = false;
    // isHeading só aceita título em maiúsculas. Um painel de bioimpedância pode nomear a seção em
    // letra normal ("Idade"), às vezes com uma palavra que também é ruído de outro tipo de laudo
    // ("idade" faz parte de CHROME) — por isso essa checagem roda antes do filtro de ruído. Só
    // vale tratar como título quando a linha não tem dois-pontos (isso é uma linha de valor
    // própria, tratada abaixo) nem dígito, e a linha seguinte é mesmo um valor limpo reconhecido.
    if (!line.includes(':') && !/\d/.test(line)) {
      let proximo = index + 1;
      while (proximo < lines.length && !lines[proximo].trim()) proximo++;
      if (proximo < lines.length) {
        const proximaLinha = lines[proximo].trim();
        const lido = lerValor(proximaLinha);
        if (lido?.confianca === 'normal') { items.push({ analito: line, ...lido, bruto: proximaLinha, locator: { page, line: proximo + 1, quote: proximaLinha } }); index = proximo; continue; }
      }
    }
    if (CHROME.test(line)) continue;
    // Titles and separators carry no result. Anything else stays visible, even unreadable.
    if (!/\d/.test(line) && (line === line.toUpperCase() || line.split(/\s+/).length <= 3)) continue;
    const parts = RESULT.exec(line);
    if (!parts) {
      // Um valor solto (sem dois-pontos) logo depois de um título em maiúsculas herda o nome
      // desse título — o mesmo padrão de painel de bioimpedância, sem rótulo repetido a cada número.
      if (eraCabecalho && titulo) {
        const lido = lerValor(line);
        if (lido) { items.push({ analito: titulo, ...lido, bruto: line, locator }); continue; }
      }
      items.push({ analito: null, bruto: line, confianca: 'baixa', motivo: 'Linha não reconhecida como resultado. Confira no documento original.', locator });
      continue;
    }
    const capturado = parts.groups.analito.trim();
    const analito = (titulo && GENERIC_LABEL.test(capturado)) ? titulo : capturado;
    const resto = parts.groups.resto.trim();
    const lido = lerValor(resto);
    if (!lido) { items.push({ analito, bruto: line, confianca: 'baixa', motivo: 'Valor numérico não identificado. Confira no documento original.', locator }); continue; }
    items.push({ analito, ...lido, bruto: line, locator });
  }
  return { meta, items };
}

// Segunda estratégia de leitura: laudos que usam um bloco por analito, com o nome em uma linha, o
// método em outra e o valor logo abaixo de um cabeçalho de colunas. Calibrada contra um laudo real
// de um laboratório; outros formatos continuarão caindo em pendência em vez de serem lidos errado.
const METHOD_LINE = /^\s*m[ée]todo\s*[:\-]\s*(.+)$/i;
const COLLECTED = /(?:recebido|coletado|coleta)[^:]*:\s*(\d{2}\/\d{2}\/\d{4})/i;
const VALUE_LINE = /^\s*(?<sinal>[<>≤≥]\s*)?(?<numero>\d{1,6}(?:[.,]\d{1,4})?)\s+(?<resto>\S.*)$/;
export function parseExamBlocks(text, { page = 1 } = {}) {
  const linhas = String(text).split(/\r?\n/);
  const items = [];
  const meta = {};
  let titulo = null, metodo = null;
  linhas.forEach((raw, index) => {
    const linha = raw.trim();
    if (!linha) return;
    const coleta = COLLECTED.exec(linha);
    if (coleta && !meta.data) meta.data = coleta[1];
    const metodoLinha = METHOD_LINE.exec(linha);
    if (metodoLinha) { metodo = metodoLinha[1].trim(); meta.metodo ||= metodo; return; }
    if (isHeading(linha)) { titulo = linha; return; }
    if (!ANCHOR.test(linha)) return;
    // O valor está na próxima linha não vazia depois do cabeçalho de colunas.
    const proxima = linhas.slice(index + 1).find(l => l.trim());
    if (!proxima || !titulo) return;
    const locator = { page, line: index + 2, quote: proxima.trim() };
    const valor = VALUE_LINE.exec(proxima.trim());
    if (!valor) { items.push({ analito: titulo, bruto: proxima.trim(), confianca: 'baixa', motivo: 'Valor não identificado abaixo do cabeçalho de resultado.', locator }); return; }
    const [unidadeBruta, ...restoRef] = valor.groups.resto.split(/\s+/);
    const unidade = UNIT.test(unidadeBruta) ? unidadeBruta : null;
    items.push({
      analito: titulo,
      valor: (valor.groups.sinal ? valor.groups.sinal.replace(/\s+/g, '') : '') + valor.groups.numero,
      unidade,
      referencia: restoRef.join(' ').trim() || null,
      metodo,
      bruto: proxima.trim(),
      confianca: unidade ? 'normal' : 'baixa',
      motivo: unidade ? null : `Não reconheci “${unidadeBruta}” como unidade de exame. Confira a linha no documento original.`,
      locator,
    });
  });
  return { meta, items };
}

const confiantes = items => items.filter(item => item.confianca !== 'baixa').length;
// Duas estratégias, uma escolha explícita: fica a que leu mais resultados com unidade reconhecida.
// Misturar as duas duplicaria o mesmo analito lido de dois jeitos.
export function parsePages(pages) {
  const estrategias = [['bloco', parseExamBlocks], ['linha', parseExams]].map(([nome, ler]) => {
    const meta = {}, items = [];
    pages.forEach((text, index) => {
      const parsed = ler(text, { page: index + 1 });
      for (const [key, value] of Object.entries(parsed.meta)) if (!(key in meta)) meta[key] = value;
      items.push(...parsed.items);
    });
    return { nome, meta, items };
  });
  const escolhida = estrategias.reduce((melhor, atual) => confiantes(atual.items) > confiantes(melhor.items) ? atual : melhor);
  return { ...escolhida, pages: pages.length, estrategia: escolhida.nome };
}

export const pendingExams = items => items.filter(item => item.confianca === 'baixa');

// Prose for the record. Only reviewed, readable items are written; pending lines stay out until
// the professional resolves them.
export function examsToProse(items, meta = {}) {
  const usable = items.filter(item => item.confianca !== 'baixa' && !item.jaRegistrado);
  if (!usable.length) return '';
  const head = ['Exames'];
  if (meta.data) head.push(`de ${meta.data}`);
  const origem = [meta.laboratorio, meta.metodo && `método ${meta.metodo}`].filter(Boolean).join(', ');
  if (origem) head.push(`(${origem})`);
  const body = usable.map(item => {
    const partes = [item.analito, item.valor];
    if (item.unidade) partes.push(item.unidade);
    const texto = partes.join(' ');
    return item.referencia ? `${texto} (referência ${item.referencia})` : texto;
  }).join('; ');
  return `${head.join(' ')}: ${body}.`;
}

const fold = value => String(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// Reprocessing the same PDF must not write the same result twice.
export function markAlreadyRecorded(items, recordText) {
  const haystack = fold(String(recordText).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
  return items.map(item => {
    if (!item.analito || item.confianca === 'baixa') return item;
    const needle = fold(`${item.analito} ${item.valor}${item.unidade ? ' ' + item.unidade : ''}`).replace(/\s+/g, ' ');
    return { ...item, jaRegistrado: haystack.includes(needle) };
  });
}

// The exam date is a property of the document, never of the appointment.
export function examDateWarnings(meta, consultaDate) {
  const warnings = [];
  if (!meta.data) warnings.push('O documento não traz data de coleta. Confirme a data antes de incorporar.');
  else if (consultaDate) {
    const found = DATE_BR.exec(meta.data);
    if (found) {
      const iso = `${found[3]}-${found[2]}-${found[1]}`;
      if (iso > consultaDate) warnings.push(`A data do exame (${meta.data}) é posterior à data do atendimento. Confira qual está correta.`);
      else if (iso !== consultaDate) warnings.push(`A data do exame (${meta.data}) é diferente da data do atendimento. Ela será registrada como data do exame, não da consulta.`);
    } else warnings.push('A data do documento não foi lida no formato dd/mm/aaaa. Confirme manualmente.');
  }
  return warnings;
}
