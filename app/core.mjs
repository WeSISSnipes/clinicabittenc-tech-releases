export const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const paragraph = value => `<p>${escapeHTML(value).replace(/\r?\n/g, '<br>')}</p>`;
export const regionNames = ['identificacao', 'hipoteses', 'conduta'];
export const CURRENT_START = '<!-- app:evolucao-atual:start -->';
export const CURRENT_END = '<!-- app:evolucao-atual:end -->';
export const INSERTION_MARKER = '<!-- app:evolucao -->';
export function detectRegions(html) {
  const result = {};
  for (const name of regionNames) {
    const a = `<!-- app:${name}:start -->`, b = `<!-- app:${name}:end -->`;
    if (html.split(a).length !== 2 || html.split(b).length !== 2) return null;
    const start = html.indexOf(a) + a.length, end = html.indexOf(b);
    if (end < start) return null;
    result[name] = { start, end };
  }
  // The received HTML already contains the current visit. Only one of the two modes may exist:
  // update the entry that is already there, or open the first one at an insertion point.
  const hasCurrent = html.split(CURRENT_START).length === 2 && html.split(CURRENT_END).length === 2;
  const hasInsertion = html.split(INSERTION_MARKER).length === 2;
  if (hasCurrent === hasInsertion) return null;
  if (hasCurrent) {
    const start = html.indexOf(CURRENT_START) + CURRENT_START.length, end = html.indexOf(CURRENT_END);
    if (end < start) return null;
    result.current = { start, end };
  } else {
    result.insertion = html.indexOf(INSERTION_MARKER);
    result.insertionMarker = INSERTION_MARKER.length;
  }
  try { validateRegions(html, result); return result; } catch { return null; }
}
export function validateRegions(html, regions) {
  if (!regions) throw Error('Delimite a evolução do dia já registrada ou, se ela ainda não existir, o ponto de inserção.');
  const hasCurrent = Boolean(regions.current), hasInsertion = Number.isInteger(regions.insertion);
  if (hasCurrent && hasInsertion) throw Error('A evolução atual e um ponto de inserção foram marcados ao mesmo tempo; isso duplicaria o atendimento. Escolha apenas um.');
  if (!hasCurrent && !hasInsertion) throw Error('Delimite a evolução do dia já registrada ou, se ela ainda não existir, o ponto de inserção.');
  if (hasInsertion && (regions.insertion < 0 || regions.insertion + (regions.insertionMarker || 0) > html.length)) throw Error('Ponto de inserção fora do documento.');
  const ranges = [...regionNames, 'current'].map(name => regions[name]).filter(Boolean).sort((a,b) => a.start-b.start);
  for (let i=0; i<ranges.length; i++) {
    const {start,end}=ranges[i];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start<0 || end<=start || end>html.length) throw Error('Intervalo inválido. Selecione novamente.');
    if (i && start<ranges[i-1].end) throw Error('As regiões se sobrepõem.');
    if (hasInsertion && regions.insertion>start && regions.insertion<end) throw Error('A evolução não pode ficar dentro de uma região substituída.');
  }
}
export function applyPatches(source, patches) {
  const sorted=[...patches].sort((a,b)=>a.start-b.start || a.end-b.end);
  let cursor=0, output='';
  for(const patch of sorted) {
    if(!Number.isInteger(patch.start)||!Number.isInteger(patch.end)||patch.start<cursor||patch.end<patch.start||patch.end>source.length) throw Error('Alterações sobrepostas ou fora do documento.');
    output+=source.slice(cursor,patch.start)+patch.text; cursor=patch.end;
  }
  return output+source.slice(cursor);
}
export function assertInert(html) {
  // Conservative export gate. The preview uses its own allowlist, never this check alone.
  if (/<\s*(script|iframe|object|embed|link|style|base|meta|form|svg|math|video|audio|img)\b/i.test(html) || /\s(?:on[\w:-]+|style|src|href|srcdoc|action|background)\s*=/i.test(html)) {
    throw Error('HTML contém conteúdo ativo ou recursos não suportados. Solicite HTML inerte na origem; o original não será modificado.');
  }
}
// One flowing paragraph per approved block. Exam results enter the record as prose, never as a table or a separate file.
export function currentEntryHTML(fields) {
  const day = fields.date.split('-').reverse().join('/');
  const blocks = [
    `<p><strong>Em uso de:</strong> ${escapeHTML(fields.medications)}</p>`,
    `<p><strong>${day} — ${escapeHTML(fields.internalType)}</strong></p>`,
    paragraph(fields.evolution),
  ];
  const prose = value => escapeHTML(String(value).trim()).replace(/\s*\r?\n\s*/g, ' ');
  if (fields.exams?.trim()) blocks.push(`<p><strong>Exames:</strong> ${prose(fields.exams)}</p>`);
  if (fields.bioimpedancia?.trim()) blocks.push(`<p><strong>Bioimpedância:</strong> ${prose(fields.bioimpedancia)}</p>`);
  if (fields.target?.trim()) blocks.push(`<p><strong>Evolução e meta:</strong> ${prose(fields.target)}</p>`);
  // A leitura vem do serviço de bioimpedância, não da profissional. A autoria fica escrita no
  // prontuário para que ninguém, depois, leia isso como conclusão de quem atendeu.
  if (fields.interpretacao?.trim()) blocks.push(`<p><strong>Leitura do relatório de bioimpedância (${escapeHTML(fields.interpretacaoFonte || 'serviço de bioimpedância')}), conferida:</strong> ${prose(fields.interpretacao)}</p>`);
  return `<section>${blocks.join('')}</section>`;
}
export function makeRecord(html, regions, fields) {
  validateRegions(html,regions); assertInert(html);
  if(!fields.identityConfirmed || !fields.regionsConfirmed) throw Error('Confirme identidade e preservação das regiões históricas.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fields.date) || new Date(fields.date+'T12:00:00Z').toISOString().slice(0,10)!==fields.date) throw Error('Data inválida.');
  if(!fields.patient?.trim() || !fields.medications?.trim() || !fields.evolution?.trim()) throw Error('Preencha identificação, Em uso de e evolução, sem inferir dados.');
  const patches=[];
  for(const name of regionNames) {
    if(fields[name]?.trim()) {
      if(!regions[name]) throw Error(`Delimite a região ${name} antes de atualizá-la.`);
      patches.push({...regions[name], text:paragraph(fields[name]), label:name});
    }
  }
  const body = currentEntryHTML(fields);
  if (regions.current) {
    // The markers stay outside the replaced range, so reprocessing the same sources rewrites this
    // entry instead of adding a second one.
    patches.push({start:regions.current.start, end:regions.current.end, text:`\n${body}\n`, label:'Evolução atual (substituída)'});
  } else {
    // First entry of the day: wrap it in the markers and consume the insertion marker, so the next
    // run finds an existing entry to update rather than a second insertion point.
    patches.push({start:regions.insertion, end:regions.insertion+(regions.insertionMarker||0), text:`${CURRENT_START}\n${body}\n${CURRENT_END}`, label:'Evolução atual (primeira gravação do dia)'});
  }
  return {html:applyPatches(html,patches), patches, mode: regions.current ? 'atualizar' : 'inserir'};
}
export function decodeUTF8(bytes) { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); }
export function textareaOffset(source, offset) {
  // Textareas normalize CRLF and CR to LF. Map the selection back to untouched source.
  let index=0, normalized=0;
  while(index<source.length && normalized<offset){if(source[index]==='\r'&&source[index+1]==='\n')index++;index++;normalized++;}
  if(normalized!==offset)throw Error('Posição fora do código original.');
  return index;
}
export async function digest(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), b=>b.toString(16).padStart(2,'0')).join(''); }
export function toBase64(bytes) { let text=''; for(const b of bytes) text+=String.fromCharCode(b); return btoa(text); }
export function fromBase64(text) { return Uint8Array.from(atob(text),c=>c.charCodeAt(0)); }
export async function sourceFile(bytes,name,meta={}) { decodeUTF8(bytes); return Object.freeze({name,base64:toBase64(bytes),sha256:await digest(bytes),...meta}); }
// Binary sources (exam PDFs) keep their bytes but are never decoded as UTF-8 text.
export async function binarySource(bytes,name,meta={}) { return Object.freeze({name,base64:toBase64(bytes),sha256:await digest(bytes),binary:true,...meta}); }
export async function verifySource(source) {
  if(!source || typeof source.base64!=='string' || typeof source.name!=='string') throw Error('Originais ausentes da sessão.');
  const bytes=fromBase64(source.base64);
  if(await digest(bytes)!==source.sha256) throw Error('Integridade do original inválida.');
  if(!source.binary) decodeUTF8(bytes);
  return Object.freeze({...source});
}
export const sourceText = source => decodeUTF8(fromBase64(source.base64));
export function safeName(value) { const name=value.normalize('NFD').replace(/\p{M}/gu,'').replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-|-$/g,'').slice(0,60); return name || 'consulta'; }
