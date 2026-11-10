// Per-visit catalogue of sources. Clinical content and individual report addresses live only in the
// private session file; nothing here is logged or sent anywhere.
export const KINDS = {
  prontuario: 'Prontuário (HTML da consulta atual, com o histórico)',
  transcricao: 'Transcrição da conversa',
  exame: 'Exames (PDF ou texto)',
  bioimpedancia: 'Relatório de bioimpedância',
  referencia: 'Referência adicional, sem mesclagem',
};
export const KINDS_CURTOS = { prontuario: 'Prontuário', transcricao: 'Transcrição', exame: 'Exames', bioimpedancia: 'Bioimpedância', referencia: 'Referência' };
export const STATES = { pendente: 'Aguardando leitura', lido: 'Lido', parcial: 'Lido com pendências', bloqueado: 'Não lido' };

export function makeEntry({ kind, name, sha256 = null, date = '', method = '', state = 'pendente', note = '', link = null }) {
  if (!(kind in KINDS)) throw Error('Tipo de fonte desconhecido.');
  if (!(state in STATES)) throw Error('Estado de leitura desconhecido.');
  return { id: crypto.randomUUID(), kind, name, sha256, date, method, state, note, link, evidence: [] };
}
export const describeEntry = entry =>
  `${KINDS[entry.kind]} · ${entry.name} · ${entry.date || 'sem data informada'} · ${entry.method || 'método não informado'} · ${STATES[entry.state]}`;

// A source that was not read cannot silently become evidence for an approved field.
export function assertReadable(catalog) {
  const blocked = catalog.filter(entry => entry.state === 'bloqueado');
  if (blocked.length) throw Error(`Fontes não lidas continuam no catálogo: ${blocked.map(e => e.name).join(', ')}. Resolva ou remova antes de aprovar.`);
}
