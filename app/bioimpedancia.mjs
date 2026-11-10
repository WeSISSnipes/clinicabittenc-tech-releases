import { parseExams, DATE_BR } from './exams.mjs';

// The Galileu link is recognised and kept in the private session only. Nothing is fetched: the
// static local server does not reach the internet and the access conditions of the report site were
// not verified. The professional pastes the report export or attaches its PDF.
const ALLOWED_HOSTS = new Set(['galileuonline.com.br', 'www.galileuonline.com.br']);

export function parseGalileuLink(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw Error('Endereço inválido.'); }
  if (url.protocol !== 'https:') throw Error('Use somente endereços https.');
  if (!ALLOWED_HOSTS.has(url.hostname)) throw Error('Endereço fora do domínio de bioimpedância autorizado. Nenhum outro endereço é aceito.');
  const query = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : url.search.replace(/^\?/, '');
  const params = new URLSearchParams(query);
  const relatorio = params.get('relatorio') || params.get('bia');
  if (!relatorio) throw Error('O endereço não contém identificador de relatório.');
  return Object.freeze({ host: url.hostname, relatorio, evolucao: params.get('evolucao') || null, obtido: false });
}
// Shown in the interface and written to the session; never to logs, documents or the repository.
export const describeGalileu = link => `${link.host} · relatório ····${String(link.relatorio).slice(-4)}${link.evolucao ? ' · evolução informada' : ''}`;

export async function fetchGalileu() {
  throw Error('A busca automática do relatório não está implementada e o aplicativo não acessa a internet. Anexe o PDF exportado ou cole os dados do relatório.');
}

const METHOD = /bioimped[âa]ncia|\bbia\b|inbody|galileu|tetrapolar|octopolar/i;
const DXA = /\bdxa\b|\bdexa\b|densitometria/i;

// A data do exame é a da avaliação — nunca a de nascimento, que aparece antes no cabeçalho, nem a
// da avaliação anterior citada só como comparação ("… comparado com 30/07/2026"). Pegar a primeira
// data do texto trocava a data do exame pela data de nascimento da pessoa.
const DATA_QUALQUER = /\b\d{2}\/\d{2}\/\d{4}\b/g;
export function dataDaAvaliacao(text) {
  const t = String(text);
  const rotulada = /\bdata\s+d[aeo]\s+(?:avalia[çc][ãa]o|medi[çc][ãa]o|exame|coleta)\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/i.exec(t);
  if (rotulada) return rotulada[1];
  // "dd/mm/aaaa às hh:mm" é o carimbo da própria avaliação; a primeira ocorrência é a de hoje.
  const comHorario = /(\d{2}\/\d{2}\/\d{4})\s+(?:[àa]s\s+)?\d{1,2}:\d{2}/i.exec(t);
  if (comHorario) return comHorario[1];
  for (const achado of t.matchAll(DATA_QUALQUER)) {
    if (/nasc/i.test(t.slice(Math.max(0, achado.index - 30), achado.index))) continue;
    return achado[0];
  }
  return null;
}

// Peso e altura vêm rotulados no cabeçalho do relatório, como texto de verdade. O leitor genérico
// de exames não os reconhecia porque dividem a linha com outros campos.
const CABECALHO_MEDIDAS = [
  ['Peso', /\bPeso\s*:\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(kg)\b/i],
  ['Altura', /\bAltura\s*:\s*(\d{2,3}(?:[.,]\d{1,2})?)\s*(cm)\b/i],
];
// Linhas que só identificam a avaliação; não são resultado e viravam "não lidos" sem necessidade.
const RUIDO_DE_CABECALHO = /^(?:avaliad[oa]|avaliador)\s*:|^\d{2}\/\d{2}\/\d{4}\s+(?:[àa]s\s+)?\d{1,2}:\d{2}/i;
// Unidade solta como "nome" do analito: o rótulo verdadeiro está numa imagem, que a leitura local
// não enxerga. Fica como pendência — nunca como um resultado chamado "cm".
const SO_UNIDADE = /^(?:cm|kg|kcal|%|l|ml|mm|anos)$/i;

// Method and date come from the report, never from the appointment. Body composition from
// bioimpedance is not compared with DXA.
export function parseBia(text, { consultaDate } = {}) {
  const { meta, items: brutos } = parseExams(text);
  const linhas = String(text).split(/\r?\n/);
  const items = brutos
    .filter(item => !(item.confianca === 'baixa' && RUIDO_DE_CABECALHO.test(item.locator?.quote || '')))
    .map(item => {
      if (item.analito && /^basal$/i.test(item.analito.trim()) && /taxa\s+metab[óo]lica/i.test(text)) return { ...item, analito: 'Taxa Metabólica Basal' };
      if (item.confianca !== 'baixa' && SO_UNIDADE.test(String(item.analito || '').trim())) {
        return { ...item, confianca: 'baixa', motivo: 'Valor sem nome legível no texto do PDF (o rótulo provavelmente é uma imagem). Use a leitura por IA ou informe manualmente.' };
      }
      return item;
    });
  const doCabecalho = [];
  for (const [nome, padrao] of CABECALHO_MEDIDAS) {
    const achado = padrao.exec(text);
    if (!achado || items.some(item => item.confianca !== 'baixa' && new RegExp(`^${nome}$`, 'i').test(String(item.analito || '').trim()))) continue;
    const indice = linhas.findIndex(linha => padrao.test(linha));
    doCabecalho.push({ analito: nome, valor: achado[1], unidade: achado[2].toLowerCase(), referencia: null, bruto: achado[0], confianca: 'normal', motivo: null, locator: { page: 1, line: indice + 1, quote: indice >= 0 ? linhas[indice].trim() : achado[0] } });
  }
  items.unshift(...doCabecalho);
  const avaliada = /\bavaliad[ao]\s*:\s*(.+?)\s+data\s+de\s+nascimento/i.exec(text);
  if (avaliada && !meta.paciente) meta.paciente = avaliada[1].trim();
  const avisos = [];
  const metodo = meta.metodo || (METHOD.exec(text)?.[0] ?? null);
  if (!metodo) avisos.push('O método não foi identificado no relatório. Confirme antes de registrar.');
  if (DXA.test(text)) avisos.push('O texto menciona densitometria/DXA. Resultados de bioimpedância e de DXA não são equivalentes e não devem ser comparados nem misturados.');
  const data = meta.data || dataDaAvaliacao(text);
  if (!data) avisos.push('O relatório não traz data. Confirme antes de registrar.');
  else if (consultaDate) {
    const found = DATE_BR.exec(data);
    const iso = found && `${found[3]}-${found[2]}-${found[1]}`;
    if (iso && iso !== consultaDate) avisos.push(`A data do relatório (${data}) é diferente da data do atendimento. Ela será registrada como data do exame.`);
  }
  return { meta: { ...meta, metodo, data }, items, avisos };
}

// Relatório de evolução e meta: série de medidas ao longo do tempo mais o alvo da próxima consulta.
// O formato real ainda não foi conferido contra um documento verdadeiro; linhas não reconhecidas
// ficam visíveis como pendência em vez de serem descartadas.
const SERIES = /^\s*(?<data>\d{2}\/\d{2}\/\d{4})\s*[-–—|:\t ]+\s*(?<resto>.+)$/;
// `\b` não serve aqui: depois de "%" no fim da linha não há caractere de palavra. A alternativa
// olha apenas para a letra seguinte, para "10 litros" não virar "10 L".
const MEASURE = /(?<valor>\d{1,4}(?:[.,]\d{1,2})?)\s*(?<unidade>kcal|kg|cm|%|l)(?!\p{L})/giu;
const GOAL = /\b(?:meta|alvo|objetivo)\b/i;

export function parseTarget(text, { consultaDate } = {}) {
  const linhas = String(text).split(/\r?\n/);
  const serie = [], metas = [], pendencias = [];
  const meta = {};
  linhas.forEach((raw, index) => {
    const linha = raw.trim();
    if (!linha) return;
    const locator = { line: index + 1, quote: linha };
    const data = SERIES.exec(linha);
    if (data) {
      const medidas = [...data.groups.resto.matchAll(MEASURE)].map(m => ({ valor: m.groups.valor, unidade: m.groups.unidade.toLowerCase() }));
      if (medidas.length) serie.push({ data: data.groups.data, medidas, bruto: linha, locator });
      else pendencias.push({ motivo: 'Linha com data, mas sem medida reconhecida.', bruto: linha, locator });
      return;
    }
    if (GOAL.test(linha)) {
      const medidas = [...linha.matchAll(MEASURE)].map(m => ({ valor: m.groups.valor, unidade: m.groups.unidade.toLowerCase() }));
      if (medidas.length) metas.push({ medidas, bruto: linha, locator });
      else pendencias.push({ motivo: 'Menção a meta sem valor identificado.', bruto: linha, locator });
      return;
    }
    const cabecalho = /^\s*(?:paciente|nome)\s*[:\-]\s*(.+)$/i.exec(linha);
    if (cabecalho) { meta.paciente ||= cabecalho[1].trim(); return; }
    if (METHOD.test(linha)) { meta.metodo ||= METHOD.exec(linha)[0]; return; }
    // Texto livre sem número é cabeçalho ou observação e não carrega medida. Já uma linha com valor
    // e unidade que não coube em nenhuma categoria pode ser dado perdido: fica como pendência.
    if ([...linha.matchAll(MEASURE)].length) pendencias.push({ motivo: 'Medida fora de uma linha com data ou de uma meta. Confira onde ela pertence.', bruto: linha, locator });
  });
  const avisos = [];
  if (!serie.length) avisos.push('Nenhuma medida com data foi reconhecida neste relatório. Confira o documento e informe os valores manualmente.');
  if (DXA.test(text)) avisos.push('O texto menciona densitometria/DXA. Séries de bioimpedância e de DXA não são comparáveis e não devem ser misturadas na mesma evolução.');
  const ultima = serie[serie.length - 1];
  if (ultima && consultaDate) {
    const f = DATE_BR.exec(ultima.data);
    if (f && `${f[3]}-${f[2]}-${f[1]}` !== consultaDate) avisos.push(`A última medida da série é de ${ultima.data}, diferente da data do atendimento. Confirme qual corresponde à consulta de hoje.`);
  }
  return { serie, metas, meta, pendencias, avisos };
}

const medidaTexto = m => `${m.valor} ${m.unidade === 'l' ? 'L' : m.unidade}`;
export function targetToProse(serie, metas) {
  if (!serie.length && !metas.length) return '';
  const partes = [];
  if (serie.length) partes.push(`Evolução: ${serie.map(p => `${p.data} ${p.medidas.map(medidaTexto).join(', ')}`).join('; ')}`);
  if (metas.length) partes.push(`Meta para a próxima consulta: ${metas.map(m => m.medidas.map(medidaTexto).join(', ')).join('; ')}`);
  return partes.join('. ') + '.';
}

// Interpretação produzida pelo serviço de bioimpedância. O aplicativo não a resume nem a reescreve:
// mostra o texto para conferência e o registra sempre com a autoria visível.
export function parseInterpretacao(text) {
  const limpo = String(text).replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  const avisos = ['Este texto é a leitura do serviço de bioimpedância, não a avaliação de quem atendeu. Confira cada afirmação antes de aprovar; ele não substitui a conclusão clínica.'];
  if (DXA.test(text)) avisos.push('O texto menciona densitometria/DXA. Não trate as duas técnicas como equivalentes.');
  if (/\bdiagn[óo]stic|\bprescri|\bdose\b|\bmedicament/i.test(text)) avisos.push('O texto contém termos de diagnóstico ou conduta. Nada disso entra no prontuário como decisão sem confirmação explícita de quem atendeu.');
  return { texto: limpo.join(' '), paragrafos: limpo, avisos };
}

export function biaToProse(items, meta = {}) {
  const usable = items.filter(item => item.confianca !== 'baixa' && !item.jaRegistrado);
  if (!usable.length) return '';
  const head = ['Bioimpedância'];
  if (meta.data) head.push(`de ${meta.data}`);
  if (meta.metodo) head.push(`(${meta.metodo})`);
  const body = usable.map(item => [item.analito, item.valor, item.unidade].filter(Boolean).join(' ')).join('; ');
  return `${head.join(' ')}: ${body}.`;
}
