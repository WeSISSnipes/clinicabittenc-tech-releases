// Perfis de provedor. O aplicativo não se casa com nenhum: o que muda entre eles é endereço,
// cabeçalho, formato do corpo e onde fica o texto na resposta. Capacidade de ler PDF é declarada,
// nunca presumida — quando o provedor não aceita documento, o PDF não é enviado.
export const PROVIDERS = Object.freeze({
  gemini: {
    id: 'gemini',
    label: 'Google Gemini (Flash / Pro — Recomendado)',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    sufixo: '',
    versao: '',
    modeloPadrao: 'gemini-2.5-flash',
    aceitaPdfPadrao: true,
    chaveAnthropic: false,
    headers: chave => ({
      'content-type': 'application/json',
      'x-goog-api-key': chave,
    }),
    corpo: ({ sistema, texto, pdf }) => ({
      systemInstruction: { parts: [{ text: sistema }] },
      contents: [{
        role: 'user',
        parts: [
          ...(pdf ? [{ inlineData: { mimeType: 'application/pdf', data: pdf } }] : []),
          { text: texto },
        ],
      }],
      generationConfig: {
        temperature: 0.2,
      },
    }),
    extrair: dados => {
      const cand = (dados.candidates || [])[0];
      if (!cand) throw Error('O Gemini não devolveu nenhuma resposta.');
      if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') {
        throw Error('O provedor recusou a solicitação. Redija manualmente.');
      }
      return (cand.content?.parts || []).map(p => p.text || '').join('');
    },
    uso: dados => dados.usageMetadata && { entrada: dados.usageMetadata.promptTokenCount || 0, saida: dados.usageMetadata.candidatesTokenCount || 0 },
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    endpoint: 'https://api.anthropic.com/v1/messages',
    sufixo: '/messages',
    versao: '/v1',
    modeloPadrao: 'claude-haiku-4-5',
    aceitaPdfPadrao: true,
    chaveAnthropic: true,
    headers: chave => ({
      'content-type': 'application/json',
      'x-api-key': chave,
      'anthropic-version': '2023-06-01',
      // Chamada direta do navegador: quem opera o aplicativo é o dono da chave, em localhost.
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    corpo: ({ modelo, sistema, texto, pdf }) => ({
      model: modelo,
      // 8000, não 4000: em modelos com raciocínio estendido, uma parte do limite vira "pensamento"
      // interno antes do texto de resposta — um limite baixo pode devolver texto vazio sem erro
      // nenhum, especialmente ao transcrever um documento inteiro (muitos itens de resultado).
      max_tokens: 8000,
      system: sistema,
      messages: [{
        role: 'user',
        content: [
          ...(pdf ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } }] : []),
          { type: 'text', text: texto },
        ],
      }],
    }),
    extrair: dados => {
      if (dados.stop_reason === 'refusal') throw Error('O provedor recusou a solicitação. Redija manualmente.');
      return (dados.content || []).filter(bloco => bloco.type === 'text').map(bloco => bloco.text).join('');
    },
    uso: dados => dados.usage && { entrada: dados.usage.input_tokens, saida: dados.usage.output_tokens },
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek (endpoint no formato Anthropic)',
    endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    sufixo: '/messages',
    versao: '/v1',
    modeloPadrao: 'deepseek-flash',
    // A documentação do DeepSeek marca o bloco "document" como não suportado: o PDF não vai por
    // aqui, e a leitura do laudo depende do leitor local ou do texto colado.
    aceitaPdfPadrao: false,
    aceitaPdf: false,
    chaveAnthropic: false,
    headers: chave => ({ 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': '2023-06-01' }),
    corpo: ({ modelo, sistema, texto }) => ({
      model: modelo,
      max_tokens: 8000,
      system: sistema,
      messages: [{ role: 'user', content: [{ type: 'text', text: texto }] }],
    }),
    extrair: dados => {
      if (dados.stop_reason === 'refusal') throw Error('O provedor recusou a solicitação. Redija manualmente.');
      return (dados.content || []).filter(bloco => bloco.type === 'text').map(bloco => bloco.text).join('');
    },
    uso: dados => dados.usage && { entrada: dados.usage.input_tokens, saida: dados.usage.output_tokens },
  },
  openai: {
    id: 'openai',
    label: 'Compatível com OpenAI (DeepSeek, Qwen, Moonshot e outros)',
    endpoint: '',
    sufixo: '/chat/completions',
    versao: '/v1',
    modeloPadrao: '',
    aceitaPdfPadrao: false,
    chaveAnthropic: false,
    exigeEndpoint: true,
    headers: chave => ({ 'content-type': 'application/json', authorization: `Bearer ${chave}` }),
    corpo: ({ modelo, sistema, texto, pdf }) => ({
      model: modelo,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: sistema },
        {
          role: 'user',
          content: pdf
            ? [{ type: 'file', file: { filename: 'exames.pdf', file_data: `data:application/pdf;base64,${pdf}` } }, { type: 'text', text: texto }]
            : texto,
        },
      ],
    }),
    extrair: dados => {
      const escolha = (dados.choices || [])[0];
      if (!escolha) throw Error('O provedor não devolveu nenhuma resposta.');
      if (escolha.finish_reason === 'content_filter') throw Error('O provedor recusou a solicitação. Redija manualmente.');
      return escolha.message?.content ?? '';
    },
    uso: dados => dados.usage && { entrada: dados.usage.prompt_tokens, saida: dados.usage.completion_tokens },
  },
});

export const listaDeProvedores = () => Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, endpoint: p.endpoint, modeloPadrao: p.modeloPadrao, aceitaPdfPadrao: p.aceitaPdfPadrao, pdfFixo: p.aceitaPdf === false, exigeEndpoint: Boolean(p.exigeEndpoint) }));

// Uma chave colada no provedor errado é enviada para a empresa errada. O formato é conferido antes
// de qualquer requisição: é melhor recusar do que entregar a credencial a quem não deveria vê-la.
export function conferirChave(idProvedor, chave) {
  const limpa = String(chave).trim();
  if (!limpa) throw Error('Informe a chave da API antes de usar o provedor externo.');
  if (/\s/.test(limpa)) throw Error('A chave contém espaço ou quebra de linha. Cole apenas a chave.');
  const perfil = PROVIDERS[idProvedor];
  if (!perfil) throw Error('Provedor desconhecido.');
  const daAnthropic = limpa.startsWith('sk-ant-');
  if (perfil.chaveAnthropic === true && !daAnthropic)
    throw Error('Esta chave não parece ser da Anthropic, que usa o prefixo sk-ant-. Nada foi enviado. Troque o provedor na lista ou confira a chave.');
  if (perfil.chaveAnthropic === false && daAnthropic)
    throw Error(`Esta é uma chave da Anthropic (prefixo sk-ant-) e o provedor escolhido é ${perfil.label}. Nada foi enviado, para a chave não chegar a quem não deve recebê-la.`);
  return limpa;
}
// A documentação dos provedores costuma citar a URL base, não o endereço final. Aceitar as duas
// formas evita um POST num caminho que não existe, que o provedor devolveria como erro obscuro.
export function normalizarEndpoint(url, perfil) {
  if (!perfil.sufixo) return url;
  let caminho = url.pathname.replace(/\/+$/, '');
  if (caminho.endsWith(perfil.sufixo)) return url;
  if (perfil.versao && !/\/v\d+$/.test(caminho)) caminho += perfil.versao;
  url.pathname = caminho + perfil.sufixo;
  return url;
}

export function resolverProvedor({ id, endpoint = '', modelo = '' } = {}) {
  const perfil = PROVIDERS[id];
  if (!perfil) throw Error('Provedor desconhecido.');
  const escolhido = (modelo || perfil.modeloPadrao).trim();
  if (!escolhido) throw Error('Informe o modelo a usar.');
  let alvo = (endpoint || perfil.endpoint).trim();
  if (id === 'gemini' && (!endpoint.trim() || endpoint.trim() === perfil.endpoint)) {
    alvo = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(escolhido)}:generateContent`;
  }
  if (!alvo) throw Error('Informe o endereço da API deste provedor.');
  let url;
  try { url = new URL(alvo); } catch { throw Error('Endereço da API inválido.'); }
  if (url.protocol !== 'https:') throw Error('A API precisa ser https.');
  const alvoFinal = normalizarEndpoint(url, perfil);
  return { perfil, endpoint: alvoFinal.href, modelo: escolhido, host: alvoFinal.host };
}
