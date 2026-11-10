import { escapeHTML } from './core.mjs';

// Bloco do prontuário no formato usado pela profissional: ela copia este código e cola no sistema
// da clínica. Seção vazia é omitida — ausência de dado nunca vira frase negativa.
export const BLOCK_SECTIONS = Object.freeze([
  { key: 'queixa', title: 'Queixa/contexto atual', kind: 'prose' },
  { key: 'alimentacao', title: 'Alimentação e rotina', kind: 'list' },
  { key: 'atividade', title: 'Atividade física', kind: 'list' },
  { key: 'sintomas', title: 'Sintomas e intestino', kind: 'list' },
  { key: 'suplementos', title: 'Suplementos/medicações relatados', kind: 'list' },
  { key: 'antropometria', title: 'Antropometria e composição corporal', kind: 'list' },
  { key: 'laboratorio', title: 'Exames laboratoriais comentados', kind: 'list' },
  { key: 'conduta', title: 'Avaliação/conduta discutida', kind: 'list' },
  { key: 'proximo', title: 'Próximo atendimento', kind: 'prose' },
  { key: 'confirmar', title: 'Pontos que precisam ser confirmados', kind: 'list' },
]);

export const linhas = value => String(value ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

export function buildClinicalBlock(values = {}, { heading = '1. Prontuário clínico' } = {}) {
  const partes = [];
  for (const { key, title, kind } of BLOCK_SECTIONS) {
    const itens = linhas(values[key]);
    if (!itens.length) continue;
    if (kind === 'prose') partes.push(`<p><strong>${escapeHTML(title)}:</strong><br />${itens.map(escapeHTML).join('<br />')}</p>`);
    else partes.push(`<p><strong>${escapeHTML(title)}:</strong></p>`, `<ul>`, ...itens.map(i => `<li>${escapeHTML(i)}</li>`), `</ul>`);
  }
  if (!partes.length) throw Error('Preencha ao menos uma seção do bloco antes de gerar o código.');
  return [`<div>`, `<h2>${escapeHTML(heading)}</h2>`, ...partes, `</div>`].join('\n');
}

const medida = item => [item.analito, item.valor, item.unidade].filter(Boolean).join(' ');
// Semeia as seções a partir do que já foi lido e conferido. Nada é inventado: cada linha vem de uma
// extração aprovada ou de uma pendência já visível na tela.
export function seedSections({ exams = [], examsMeta = {}, bia = [], biaMeta = {}, target = null, pendencias = [], medications = '' } = {}) {
  const seed = {};
  const lidos = exams.filter(i => i.confianca !== 'baixa' && !i.jaRegistrado);
  if (lidos.length) {
    const origem = [examsMeta.data && `coleta de ${examsMeta.data}`, examsMeta.laboratorio].filter(Boolean).join(', ');
    seed.laboratorio = [origem && `Exames de ${origem}.`, ...lidos.map(i => `${medida(i)}${i.referencia ? ` (referência ${i.referencia})` : ''}.`)].filter(Boolean).join('\n');
  }
  const corporal = [];
  for (const item of bia.filter(i => i.confianca !== 'baixa')) corporal.push(`${medida(item)}${biaMeta.metodo ? ` (${biaMeta.metodo})` : ''}.`);
  if (target?.serie?.length) {
    const ultima = target.serie[target.serie.length - 1];
    corporal.push(`Evolução registrada até ${ultima.data}: ${ultima.medidas.map(m => `${m.valor} ${m.unidade}`).join(', ')}.`);
  }
  // "metas" tem duas formas possíveis: série manual (meta.medidas, uma lista) ou leitura por IA
  // (meta.atual/meta.meta, um indicador só) — cada uma vira uma frase no formato que já tem.
  for (const meta of target?.metas ?? []) {
    if (Array.isArray(meta.medidas)) corporal.push(`Meta para a próxima consulta: ${meta.medidas.map(m => `${m.valor} ${m.unidade}`).join(', ')}.`);
    else if (meta.indicador && meta.atual) corporal.push(`${meta.indicador} atual ${meta.atual}${meta.unidade || ''}${meta.meta ? `, meta ${meta.meta}${meta.unidade || ''}` : ''}.`);
  }
  if (corporal.length) seed.antropometria = corporal.join('\n');
  if (medications.trim()) seed.suplementos = linhas(medications).join('\n');
  if (pendencias.length) seed.confirmar = pendencias.join('\n');
  return seed;
}
