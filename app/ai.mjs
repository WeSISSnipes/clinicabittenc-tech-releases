// Elaboração assistida. O modo simulado é local, determinístico e não envia nada pela rede.
// O modo externo fala com o provedor escolhido pela profissional, através de app/providers.mjs.
import { buildDraft } from './draft.mjs';
import { BLOCK_SECTIONS } from './bloco.mjs';
import { resolverProvedor, conferirChave } from './providers.mjs';

export const AI_MODES = Object.freeze({ simulated: 'simulado', external: 'externo' });

const REGRAS = `REGRAS ABSOLUTAS:
1. Use exclusivamente o que estiver nas FONTES. Não acrescente sintoma, diagnóstico, conduta, medicamento, dose, valor ou data que não esteja escrito lá.
2. Copie números, unidades, decimais e datas exatamente como aparecem. Não converta, não arredonde, não complete.
3. Menção não é prescrição. Medicamento citado pela pessoa atendida não vira "em uso" nem "prescrito" sem que a fonte diga isso.
4. Não transforme ausência de informação em negativa clínica. Se algo não foi registrado, não escreva que é normal, que está ausente ou que foi negado.
5. Tudo que estiver incerto, ambíguo, sem autoria clara ou em conflito entre fontes vira dúvida, escrita como dúvida. Nunca escolha uma versão por conta própria.
6. Não interprete exame nem bioimpedância. Transcreva o que foi medido.
7. Escreva em português do Brasil, impessoal e objetivo, sem adjetivos de avaliação.`;

const CHAVES = BLOCK_SECTIONS.map(s => `"${s.key}" — ${s.title}${s.kind === 'list' ? ' (uma linha por item)' : ' (texto corrido)'}`).join('\n');

export const SYSTEM_PROMPT = `Você redige o registro de uma consulta a partir de fontes já conferidas por quem atendeu.

${REGRAS}

Responda SOMENTE com um objeto JSON, sem cercas de código e sem texto fora dele, com estas chaves:
${CHAVES}

Omita a chave, ou deixe string vazia, para qualquer seção sem fonte. Seção vazia é preferível a seção inventada. Dúvidas e conflitos vão para "confirmar".`;

export const EXAM_SYSTEM_PROMPT = `Você transcreve um laudo de exames laboratoriais. Não interpreta, não conclui e não diz se um valor está bom ou ruim.

${REGRAS}

Responda SOMENTE com um objeto JSON, sem cercas de código e sem texto fora dele, com as chaves: laboratorio, data (dd/mm/aaaa), metodo, paciente, resultados e ilegiveis.
Cada item de resultados tem: analito, valor, unidade, referencia e pagina.
Cada item de ilegiveis é a descrição de um trecho que você não conseguiu ler com segurança.

Um resultado que você não conseguir ler com certeza NÃO entra em resultados: entra em ilegiveis. Resultado ilegível nunca vira resultado normal. Cabeçalho, rodapé, número de página e texto institucional não são resultados.`;

export const BIA_SYSTEM_PROMPT = `Você transcreve um relatório de bioimpedância. Muitos dos valores mais importantes aparecem só como desenho (medidor, anel colorido, silhueta), não como texto — leia-os visualmente na imagem da página, com o mesmo cuidado que teria lendo um número impresso. Não interpreta, não conclui e não diz se um valor está bom ou ruim.

${REGRAS}

Responda SOMENTE com um objeto JSON, sem cercas de código e sem texto fora dele, com as chaves: data (dd/mm/aaaa), metodo, paciente, resultados e ilegiveis.
"data" é a data da AVALIAÇÃO desta página — geralmente escrita com horário, como "dd/mm/aaaa às hh:mm", perto do topo. Nunca use a data de nascimento, nem a data de uma avaliação anterior citada só como comparação (por exemplo depois de "comparado com").
Cada item de resultados tem: analito, valor, unidade e pagina.
Procure especificamente, quando aparecerem: massa gorda (kg) e % de gordura, massa magra (kg e %), massa muscular (kg e %), razão músculo/gordura, água corporal total (litros e %), índice de hidratação, água na massa magra, água intracelular e extracelular (litros e %), ângulo de fase, idade celular, circunferência abdominal, peso, altura, IMC, idade, taxa metabólica basal.
Muitos painéis escrevem dois números juntos, como "50,0 Kg / 65,0 %" ou "20,0 litros / 45,0 %": o primeiro é o valor do indicador e o segundo é o seu PERCENTUAL do peso corporal (por exemplo "Massa magra" 50,0 kg e "Percentual de massa magra" 65,0 %; "Água corporal total" 20,0 litros e "Percentual de água corporal total" 45,0 %). Só é VARIAÇÃO em relação à avaliação anterior o número que tem sinal explícito (+ ou -), geralmente em cinza pequeno perto do medidor: registre como "Variação de <indicador>". Registre cada número como um item próprio, com a unidade que aparece ao lado dele, nunca fundidos numa linha só.
Copie o nome do indicador e a unidade EXATAMENTE como estão impressos, sem traduzir, sem "corrigir" e sem trocar por outro indicador parecido (por exemplo, "Razão Músculo Gordura" não é "Razão Cintura-Glúteo"). Se não conseguir ler um nome com certeza, ponha o trecho em ilegiveis.
Se o relatório mostrar uma comparação com uma consulta anterior (um número menor abaixo ou ao lado do valor principal, muitas vezes com seta e sinal de + ou -), registre essa variação como um item à parte, com o analito escrito como "Variação de <nome do valor original>" e o sinal exatamente como aparece. Se não houver comparação (primeira consulta), não invente uma.
Cada item de ilegiveis é a descrição de um trecho ou indicador que você não conseguiu ler com segurança. Um resultado que você não conseguir ler com certeza NÃO entra em resultados: entra em ilegiveis. Cabeçalho, rodapé, número de página, nome de quem avaliou e texto institucional não são resultados.
Cada analito aparece só uma vez em resultados, mesmo que o mesmo valor apareça repetido em mais de um lugar da página. Se método, data ou paciente não constarem no documento, use null nesse campo — nunca escreva uma frase como "não especificado" no lugar do valor. O campo paciente é o nome completo, como texto simples, nunca um objeto.`;

export const EVOLUTION_SYSTEM_PROMPT = `Você lê um relatório de evolução e meta de bioimpedância: uma tabela de metas (indicador, valor atual, meta, diferença) e, quando presentes, dois gráficos de tendência ao longo de várias avaliações — peso em kg (linha azul) e percentual de gordura (linha amarela).

${REGRAS}

Responda SOMENTE com um objeto JSON, sem cercas de código e sem texto fora dele, com as chaves: data (dd/mm/aaaa), paciente, prazo, metas e interpretacao_grafico.
"data" é a data da AVALIAÇÃO (escrita com horário, perto do topo) — nunca a data de nascimento. "prazo" é o prazo escrito no título da tabela, por exemplo "2 meses" em "Metas para 2 meses"; null se não houver.
Tanto a tabela quanto os gráficos podem ser só desenho: leia-os visualmente, linha por linha.
"metas" é uma lista com UM item por linha da tabela; cada item tem: indicador (o nome como impresso, sem a unidade — ex: "Peso", "% Gordura", "Massa Gorda", "Massa Magra", "IMC"), atual, meta, diferenca (a coluna "Dif", com o sinal), unidade e pagina. Todos os valores são TEXTO entre aspas, exatamente como impressos, com vírgula decimal e sinal (por exemplo "68,0", "-1,5", "+0") — nunca número JSON. Se a coluna de meta ou diferença estiver vazia na tabela (relatório de primeira consulta, sem comparação), deixe "meta" como null — não invente um valor.
"interpretacao_grafico" é uma frase curta e só com fatos que dá para conferir no gráfico: o valor inicial e o valor final de cada linha (peso e percentual de gordura) e o sentido geral entre a primeira e a última avaliação visível — queda, alta ou estável. Não descreva platôs, oscilações no meio do caminho, nem compare com a meta da tabela. Comece a frase exatamente com "Leitura aproximada do gráfico:", porque ler um ponto de uma linha não é uma medição exata como um número impresso. Se não houver gráfico, ou os pontos não forem legíveis com segurança, deixe interpretacao_grafico como null — não invente uma tendência.
O nome de quem avaliou, cabeçalho, rodapé e texto institucional não são metas.`;

// Um modelo responde "atual": 73.0 como número JSON com a mesma naturalidade que como texto. Exigir
// só texto descartava a tabela inteira sem dizer nada ("0 indicadores lidos"). Número vira texto com
// vírgula decimal; o pedido à IA continua exigindo texto, para preservar "68,0" como impresso.
const valorComoTexto = valor => (typeof valor === 'number' && Number.isFinite(valor) ? String(valor).replace('.', ',') : campoTexto(valor));
function parseMetaItem(bruto) {
  if (!bruto || typeof bruto !== 'object') return null;
  const indicador = campoTexto(bruto.indicador ?? bruto.nome), atual = valorComoTexto(bruto.atual ?? bruto.valor_atual ?? bruto.valor);
  if (!indicador || !atual) return null;
  return {
    indicador, atual,
    meta: valorComoTexto(bruto.meta ?? bruto.objetivo ?? bruto.alvo) || null,
    diferenca: valorComoTexto(bruto.diferenca ?? bruto.dif) || null,
    unidade: campoTexto(bruto.unidade) || null,
  };
}
export function parseEvolucaoResponse(raw) {
  const objeto = objetoDaResposta(raw);
  const meta = { data: campoTexto(objeto.data) || null, paciente: campoTexto(objeto.paciente) || null, prazo: campoTexto(objeto.prazo) || null };
  const lista = Array.isArray(objeto.metas) ? objeto.metas : [];
  const metas = lista.map(parseMetaItem).filter(Boolean);
  // Só contagens e nomes de campos, nunca conteúdo: o app usa isso para avisar quando algo foi
  // descartado, em vez de mostrar "0 indicadores" como se o documento não tivesse metas.
  return { meta, metas, interpretacao: campoTexto(objeto.interpretacao_grafico) || null, leitura: { chaves: Object.keys(objeto), recebidas: lista.length, descartadas: lista.length - metas.length } };
}

export function buildSourcesMessage(input = {}) {
  const partes = [];
  const juntar = (titulo, valor) => { if (valor && String(valor).trim()) partes.push(`### ${titulo}\n${String(valor).trim()}`); };
  juntar('Prontuário da pessoa atendida, incluindo o histórico', input.currentEntry);
  juntar('Transcrição da consulta', input.transcript);
  juntar('Em uso de, informado por quem atendeu', input.medications);
  juntar('Exames extraídos e conferidos', input.examsProse);
  juntar('Bioimpedância conferida', input.biaProse);
  juntar('Evolução e meta conferidas', input.targetProse);
  juntar('Leitura do relatório de bioimpedância, feita por terceiro e conferida', input.interpretacao);
  juntar('Pendências já identificadas, que devem aparecer em confirmar', (input.pendencias || []).join('\n'));
  if (!partes.length) throw Error('Nenhuma fonte conferida para enviar. Aprove as extrações antes.');
  return `FONTES:\n\n${partes.join('\n\n')}`;
}

const CERCA = new RegExp('^' + String.fromCharCode(96, 96, 96) + '(?:json)?\s*|\s*' + String.fromCharCode(96, 96, 96) + '$', 'g');
function objetoDaResposta(raw) {
  let objeto;
  try { objeto = JSON.parse(String(raw).trim().replace(CERCA, '')); }
  catch { throw Error('O provedor não devolveu JSON válido. Nada foi preenchido.'); }
  if (!objeto || typeof objeto !== 'object' || Array.isArray(objeto)) throw Error('O provedor não devolveu um objeto.');
  return objeto;
}

// A resposta é tratada como dado não confiável: só as chaves conhecidas passam, e só como texto.
export function parseSections(raw) {
  const objeto = objetoDaResposta(raw);
  const saida = {};
  for (const { key } of BLOCK_SECTIONS) {
    const valor = objeto[key];
    if (typeof valor === 'string' && valor.trim()) saida[key] = valor.trim();
  }
  if (!Object.keys(saida).length) throw Error('O provedor não devolveu nenhuma seção reconhecida.');
  return saida;
}

const campoTexto = valor => (typeof valor === 'string' ? valor.trim() : '');
// Resultado sem analito ou sem valor não é resultado: vira pendência, como na leitura local.
export function parseExamResponse(raw) {
  const objeto = objetoDaResposta(raw);
  const meta = {
    laboratorio: campoTexto(objeto.laboratorio) || null,
    data: campoTexto(objeto.data) || null,
    metodo: campoTexto(objeto.metodo) || null,
    paciente: campoTexto(objeto.paciente) || null,
  };
  const items = [];
  for (const bruto of Array.isArray(objeto.resultados) ? objeto.resultados : []) {
    const analito = campoTexto(bruto?.analito), valor = campoTexto(bruto?.valor);
    const locator = { page: Number.isFinite(bruto?.pagina) ? bruto.pagina : 1, line: 0, quote: `${analito} ${valor}`.trim() };
    if (!analito || !valor) {
      items.push({ analito: analito || null, valor: null, unidade: null, referencia: null, bruto: JSON.stringify(bruto).slice(0, 160), confianca: 'baixa', motivo: 'A transcrição automática devolveu um resultado incompleto.', locator });
      continue;
    }
    const unidade = campoTexto(bruto.unidade) || null;
    items.push({ analito, valor, unidade, referencia: campoTexto(bruto.referencia) || null, bruto: `${analito}: ${valor} ${unidade || ''}`.trim(), confianca: unidade ? 'normal' : 'baixa', motivo: unidade ? null : 'Unidade ausente. Confirme antes de incorporar.', locator });
  }
  for (const ilegivel of Array.isArray(objeto.ilegiveis) ? objeto.ilegiveis : []) {
    const descricao = campoTexto(ilegivel);
    if (descricao) items.push({ analito: null, valor: null, unidade: null, referencia: null, bruto: descricao, confianca: 'baixa', motivo: 'O provedor não conseguiu ler este trecho com segurança.', locator: { page: 1, line: 0, quote: descricao } });
  }
  if (!items.length) throw Error('O provedor não devolveu nenhum resultado nem pendência.');
  return { meta, items };
}

export function createDraftProvider({ mode = AI_MODES.simulated, apiKey = '', provedor = 'anthropic', endpoint = '', modelo = '', aceitaPdf = null, fetchImpl = globalThis.fetch } = {}) {
  if (mode === AI_MODES.simulated) {
    return Object.freeze({
      mode, label: 'Provedor simulado local',
      async generate(input) { return { ...buildDraft(input), provider: this.label, network: false }; },
    });
  }
  if (mode !== AI_MODES.external) throw Error('Modo de provedor desconhecido.');
  const alvo = resolverProvedor({ id: provedor, endpoint, modelo });
  const chave = conferirChave(provedor, apiKey);
  // Quando o perfil declara que o provedor não aceita documento, a marcação na tela não vale:
  // insistir só enviaria o laudo para receber um erro.
  const podePdf = alvo.perfil.aceitaPdf === false ? false
    : aceitaPdf === null ? alvo.perfil.aceitaPdfPadrao : Boolean(aceitaPdf);

  async function chamar({ sistema, texto, pdf }) {
    let resposta;
    try {
      resposta = await fetchImpl(alvo.endpoint, {
        method: 'POST',
        headers: alvo.perfil.headers(chave),
        body: JSON.stringify(alvo.perfil.corpo({ modelo: alvo.modelo, sistema, texto, pdf })),
      });
    } catch {
      throw Error(`Não foi possível falar com ${alvo.host}. Pode ser a conexão, o endereço da API, ou o provedor não permitir chamadas vindas do navegador. O trabalho na tela permanece intacto.`);
    }
    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => '');
      const motivo = resposta.status === 401 || resposta.status === 403 ? `A chave foi recusada por ${alvo.host}. Confira se ela é desse provedor.`
        : resposta.status === 404 ? `Endereço não encontrado em ${alvo.host}. Confira a URL do provedor.`
        : resposta.status === 429 ? `Limite de uso atingido em ${alvo.host}; tente novamente em instantes.`
        : resposta.status >= 500 ? `${alvo.host} falhou. Nada foi preenchido.`
        : `${alvo.host} recusou a requisição (${resposta.status}).`;
      throw Error(`${motivo} O trabalho na tela permanece intacto.${detalhe ? ` Detalhe: ${detalhe.slice(0, 200)}` : ''}`);
    }
    const dados = await resposta.json();
    const saida = alvo.perfil.extrair(dados);
    if (!saida.trim()) throw Error('O provedor devolveu resposta vazia.');
    return { texto: saida, uso: alvo.perfil.uso(dados) || null, modelo: dados.model || alvo.modelo };
  }

  return Object.freeze({
    mode, modelo: alvo.modelo, host: alvo.host, podePdf, network: true,
    label: `${alvo.perfil.label} · ${alvo.modelo}`,
    async redigir(input) {
      const { texto, uso, modelo } = await chamar({ sistema: SYSTEM_PROMPT, texto: buildSourcesMessage(input) });
      return { secoes: parseSections(texto), uso, modelo };
    },
    async lerExames({ pdfBase64 = '', textoExtraido = '' } = {}) {
      if (pdfBase64 && !podePdf) throw Error('Este provedor está marcado como não aceitando PDF. Marque a opção de envio de PDF, se ele aceitar, ou informe o texto do laudo.');
      if (!pdfBase64 && !textoExtraido.trim()) throw Error('Nem PDF nem texto de laudo para enviar.');
      const instrucao = pdfBase64
        ? 'Transcreva o laudo em anexo. Percorra todas as páginas.'
        : `Transcreva o laudo abaixo.\n\nLAUDO:\n\n${textoExtraido.trim()}`;
      const { texto, uso, modelo } = await chamar({ sistema: EXAM_SYSTEM_PROMPT, texto: instrucao, pdf: pdfBase64 || null });
      return { ...parseExamResponse(texto), uso, modelo };
    },
    async lerBioimpedancia({ pdfBase64 = '', textoExtraido = '' } = {}) {
      if (pdfBase64 && !podePdf) throw Error('Este provedor está marcado como não aceitando PDF. Marque a opção de envio de PDF, se ele aceitar, ou informe o texto do relatório.');
      if (!pdfBase64 && !textoExtraido.trim()) throw Error('Nem PDF nem texto de bioimpedância para enviar.');
      const instrucao = pdfBase64
        ? 'Transcreva o relatório de bioimpedância em anexo, inclusive os valores mostrados apenas em medidores e gráficos. Percorra todas as páginas.'
        : `Transcreva o relatório abaixo.\n\nRELATÓRIO:\n\n${textoExtraido.trim()}`;
      const { texto, uso, modelo } = await chamar({ sistema: BIA_SYSTEM_PROMPT, texto: instrucao, pdf: pdfBase64 || null });
      return { ...parseExamResponse(texto), uso, modelo };
    },
    async lerEvolucao({ pdfBase64 = '', textoExtraido = '' } = {}) {
      if (pdfBase64 && !podePdf) throw Error('Este provedor está marcado como não aceitando PDF. Marque a opção de envio de PDF, se ele aceitar, ou informe o texto do relatório.');
      if (!pdfBase64 && !textoExtraido.trim()) throw Error('Nem PDF nem texto de evolução e meta para enviar.');
      const instrucao = pdfBase64
        ? 'Leia o relatório de evolução e meta em anexo, incluindo a tabela de metas e os dois gráficos de tendência (peso e percentual de gordura).'
        : `Leia o relatório abaixo.\n\nRELATÓRIO:\n\n${textoExtraido.trim()}`;
      const { texto, uso, modelo } = await chamar({ sistema: EVOLUTION_SYSTEM_PROMPT, texto: instrucao, pdf: pdfBase64 || null });
      return { ...parseEvolucaoResponse(texto), uso, modelo };
    },
  });
}
