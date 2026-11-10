// Integração direta e resiliente com a API do Google Gemini (2.5 Flash) para:
// 1. Transcrição completa diarizada ([Médico/Nutricionista] vs [Paciente]) com horários (MM:SS)
// 2. Geração do Bloco do Prontuário (10 seções)
// 3. Geração do Resumo Pós-Consulta ao paciente (6 campos, sem a palavra "retorno")
// 4. Mensagem breve de WhatsApp

import { readFile, writeFile } from 'node:fs/promises';
import { BLOCK_SECTIONS } from './app/bloco.mjs';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const MODELOS_CANDIDATOS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];

const SYSTEM_PROMPT = `Você é um assistente de documentação clínica em português do Brasil para consultas médicas (endocrinologia/metabologia) e de nutrição.
Você receberá o áudio de uma consulta (ou uma transcrição já existente) onde há pelo menos duas pessoas conversando: o Profissional (Médico(a) ou Nutricionista) e o(a) Paciente.

REGRAS CLÍNICAS OBRIGATÓRIAS:
1. Use exclusivamente fatos ditos na consulta ou presentes no contexto enviado. Não invente doses, medicamentos, exames ou diagnósticos.
2. Preserve números, unidades, datas e negações exatamente como falados.
3. Na transcrição completa ("transcricao"), transcreva TODA a conversa em português do Brasil, separando claramente as falas com horários aproximados no formato [MM:SS] Profissional: ... e [MM:SS] Paciente: ...
4. Preencha o "bloco" com as seções do prontuário clínico (deixe string vazia "" nas seções que não foram abordadas na consulta; para listas, separe cada item com quebra de linha \\n). A seção "queixa" NUNCA pode ficar vazia: registre nela o motivo/contexto da conversa ou o resumo do que foi dito.
5. Preencha o "resumoPaciente" em linguagem acolhedora, clara e direta para a pessoa atendida. NUNCA use a palavra "retorno" em nenhum campo do resumoPaciente — use sempre "consulta", "nova consulta" ou "próxima consulta". Nenhum dos 6 campos de resumoPaciente pode ficar vazio (se não houve exame ou medicação, escreva de forma neutra, ex.: "Nenhuma medicação nova prescrita nesta consulta.").
6. Preencha "mensagemWhatsapp" com uma mensagem curta e cordial pós-consulta para enviar no WhatsApp.

Responda SOMENTE com um objeto JSON válido seguindo exatamente esta estrutura:
{
  "transcricao": "[00:00] Profissional: ...\\n[00:12] Paciente: ...",
  "resumoClinico": "Resumo clínico objetivo da consulta para leitura rápida do profissional.",
  "mensagemWhatsapp": "Mensagem acolhedora para WhatsApp...",
  "bloco": {
    "queixa": "Texto corrido sobre queixa e contexto atual",
    "alimentacao": "Item 1\\nItem 2",
    "atividade": "Item 1\\nItem 2",
    "sintomas": "Item 1\\nItem 2",
    "suplementos": "Item 1\\nItem 2",
    "antropometria": "Item 1\\nItem 2",
    "laboratorio": "Item 1\\nItem 2",
    "conduta": "Item 1\\nItem 2",
    "proximo": "Texto sobre próximo atendimento",
    "confirmar": "Pontos pendentes ou dúvidas a confirmar, se houver"
  },
  "resumoPaciente": {
    "fraseconexao": "Frase breve de abertura conectando com a consulta",
    "pontosatencao": "Pontos que merecem atenção da pessoa",
    "medicacao": "Medicações e suplementos combinados",
    "exames": "Exames solicitados ou avaliados",
    "agendamento": "Próximo passo ou agendamento combinado (sem usar a palavra retorno)",
    "frasefinal": "Frase de encerramento cordial"
  }
}`;

function limparRetorno(texto) {
  if (typeof texto !== 'string') return '';
  return texto.replace(/\bretornos\b/gi, 'consultas').replace(/\bretorno\b/gi, 'nova consulta');
}

export function normalizarRespostaGemini(raw) {
  let texto = String(raw || '').trim();
  const cerca = /^```(?:json)?\s*|\s*```$/gi;
  texto = texto.replace(cerca, '').trim();
  const inicio = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (inicio >= 0 && fim > inicio) texto = texto.slice(inicio, fim + 1);

  let parsed;
  try {
    parsed = JSON.parse(texto);
  } catch {
    throw Error('O Gemini não devolveu um JSON válido. Tente novamente.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw Error('Resposta inválida do Gemini.');
  }

  const transcricao = typeof parsed.transcricao === 'string' ? parsed.transcricao.trim() : '';
  const resumoClinico = typeof parsed.resumoClinico === 'string' ? parsed.resumoClinico.trim() : '';
  const mensagemWhatsapp = limparRetorno(typeof parsed.mensagemWhatsapp === 'string' ? parsed.mensagemWhatsapp.trim() : '');

  const bloco = {};
  const rawBloco = parsed.bloco && typeof parsed.bloco === 'object' ? parsed.bloco : {};
  for (const { key } of BLOCK_SECTIONS) {
    const val = rawBloco[key];
    bloco[key] = Array.isArray(val) ? val.map(v => String(v).trim()).filter(Boolean).join('\n')
      : typeof val === 'string' ? val.trim() : '';
  }
  if (!Object.values(bloco).some(Boolean)) {
    bloco.queixa = resumoClinico || transcricao || 'Atendimento registrado por áudio.';
  }

  const rawResumo = parsed.resumoPaciente && typeof parsed.resumoPaciente === 'object' ? parsed.resumoPaciente : {};
  const defaultsResumo = {
    fraseconexao: 'Foi um prazer conversar com você hoje e acompanhar seu cuidado.',
    pontosatencao: 'Manter a rotina combinada em consulta e observar a evolução dos sintomas.',
    medicacao: 'Seguir conforme prescrição e orientações alinhadas em consulta.',
    exames: 'Sem novos exames pendentes no momento, ou conforme pedido entregue.',
    agendamento: 'Próxima consulta conforme combinado com a equipe.',
    frasefinal: 'Seguimos juntos no acompanhamento da sua saúde.',
  };
  const resumoPaciente = {};
  for (const [campo, padrao] of Object.entries(defaultsResumo)) {
    const val = typeof rawResumo[campo] === 'string' && rawResumo[campo].trim() ? rawResumo[campo].trim() : padrao;
    resumoPaciente[campo] = limparRetorno(val);
  }

  return {
    transcricao,
    resumoClinico,
    mensagemWhatsapp,
    bloco,
    resumoPaciente,
  };
}

export function createGeminiScribeService({
  apiKey = process.env.GEMINI_API_KEY || '',
  apiKeyPath = null,
  obterChave = null,
  salvarChave = null,
  model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
  fetchImpl = fetch,
  depurar = null,
} = {}) {
  let chaveEmMemoria = apiKey;
  let modeloAtivo = model;
  let ultimaChaveValidada = '';
  let ultimoResultadoValidacao = null;

  function listaModelosParaTentar() {
    return [...new Set([modeloAtivo, ...MODELOS_CANDIDATOS])];
  }

  async function chaveAtual() {
    if (obterChave) {
      try {
        const v = await obterChave();
        if (v) return v.trim();
      } catch { /* fallback */ }
    }
    if (chaveEmMemoria) return chaveEmMemoria.trim();
    if (apiKeyPath) {
      try {
        const texto = await readFile(apiKeyPath, 'utf8');
        for (const linhaBruta of texto.split(/\r?\n/)) {
          const linha = linhaBruta.trim();
          if (linha.startsWith('GEMINI_API_KEY=')) {
            return linha.slice('GEMINI_API_KEY='.length).trim();
          }
        }
      } catch { /* ignore */ }
    }
    return '';
  }

  async function validarChave(chaveOpcional, { forcar = false } = {}) {
    const key = String(chaveOpcional !== undefined ? chaveOpcional : await chaveAtual()).trim();
    if (!key) {
      return { valid: false, configured: false, model: modeloAtivo, error: 'Chave do Gemini ainda não configurada.' };
    }
    if (!forcar && ultimaChaveValidada === key && ultimoResultadoValidacao) {
      return ultimoResultadoValidacao;
    }
    let ultimoErroStatus = 0;
    let ultimaMsgApi = '';
    for (const candidato of listaModelosParaTentar()) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidato)}:generateContent`;
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': key,
          },
          signal: AbortSignal.timeout(12000),
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
            generationConfig: { maxOutputTokens: 2 },
          }),
        });
        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          let apiMsg = '';
          try { apiMsg = JSON.parse(errText)?.error?.message || ''; } catch { /* ignore */ }
          ultimoErroStatus = response.status;
          ultimaMsgApi = apiMsg;
          if (depurar) await depurar(`gemini: validacao (${candidato}) status=${response.status} msg=${apiMsg.slice(0, 100)}`);
          // Se este modelo retornou 404 (descontinuado para novos usuários), tenta automaticamente o próximo modelo candidato!
          if (response.status === 404) {
            const sugerido = /models\/([\w.-]+flash[\w.-]*)/i.exec(apiMsg)?.[1];
            if (sugerido && !MODELOS_CANDIDATOS.includes(sugerido)) MODELOS_CANDIDATOS.unshift(sugerido);
            continue;
          }
          if (response.status === 400 || response.status === 401 || response.status === 403) {
            const res = {
              valid: false,
              configured: true,
              model: modeloAtivo,
              error: 'Chave do Gemini inválida ou recusada pelo Google AI Studio. Gere/copie uma chave válida (AIza...) antes de iniciar a consulta.',
            };
            ultimaChaveValidada = key;
            ultimoResultadoValidacao = res;
            return res;
          }
          if (response.status === 429) {
            modeloAtivo = candidato;
            const res = { valid: true, configured: true, model: modeloAtivo };
            ultimaChaveValidada = key;
            ultimoResultadoValidacao = res;
            return res;
          }
          continue;
        }
        modeloAtivo = candidato;
        const res = { valid: true, configured: true, model: modeloAtivo };
        ultimaChaveValidada = key;
        ultimoResultadoValidacao = res;
        return res;
      } catch (error) {
        if (depurar) await depurar(`gemini: erro de rede ao validar chave: ${error.message || ''}`);
        return {
          valid: false,
          configured: true,
          networkError: true,
          model: modeloAtivo,
          error: 'Sem conexão com a internet para validar a chave do Gemini no momento.',
        };
      }
    }
    return {
      valid: false,
      configured: true,
      model: modeloAtivo,
      error: `Não foi possível validar o modelo no Gemini (status ${ultimoErroStatus}${ultimaMsgApi ? `: ${ultimaMsgApi}` : ''}).`,
    };
  }

  async function definirChave(novaChave) {
    const limpa = String(novaChave || '').trim();
    if (limpa) {
      const check = await validarChave(limpa, { forcar: true });
      if (!check.valid) {
        throw Error(check.error || 'Chave do Gemini inválida.');
      }
    } else {
      ultimaChaveValidada = '';
      ultimoResultadoValidacao = null;
    }
    chaveEmMemoria = limpa;
    if (salvarChave) {
      await salvarChave(limpa);
    } else if (apiKeyPath) {
      try {
        let linhas = [];
        try {
          const atual = await readFile(apiKeyPath, 'utf8');
          linhas = atual.split(/\r?\n/).filter(l => !l.trim().startsWith('GEMINI_API_KEY='));
        } catch { /* arquivo .env ainda não existe */ }
        if (limpa) linhas.push(`GEMINI_API_KEY=${limpa}`);
        await writeFile(apiKeyPath, linhas.filter((l, i, arr) => l || i < arr.length - 1).join('\n') + '\n', 'utf8');
      } catch { /* ignore se não puder escrever */ }
    }
    return Boolean(limpa);
  }

  async function processarConsulta({ audioBase64 = '', mimeType = 'audio/webm', transcricaoTexto = '', contextoExtra = '' } = {}) {
    const key = await chaveAtual();
    if (!key) {
      throw Error('Cole sua chave da API do Gemini (Google AI Studio) nas configurações ou no painel de Gravação para transcrever e resumir.');
    }
    if (!audioBase64 && !transcricaoTexto.trim()) {
      throw Error('Envie um áudio gravado/importado ou informe o texto da transcrição.');
    }

    const cleanMime = String(mimeType || 'audio/webm').split(';')[0].trim().toLowerCase() || 'audio/webm';
    const parts = [];
    if (audioBase64) {
      parts.push({
        inlineData: {
          mimeType: cleanMime,
          data: audioBase64,
        },
      });
    }
    let instrucaoUsuario = 'Transcreva a consulta completa separando os falantes ([MM:SS] Profissional: e [MM:SS] Paciente:) e gere o bloco do prontuário, o resumo ao paciente e a mensagem pós-consulta em JSON.';
    if (transcricaoTexto.trim()) {
      instrucaoUsuario += `\n\nTranscrição já disponível:\n${transcricaoTexto.trim()}`;
    }
    if (contextoExtra.trim()) {
      instrucaoUsuario += `\n\nContexto / exames / observações adicionais:\n${contextoExtra.trim()}`;
    }
    parts.push({ text: instrucaoUsuario });

    let response;
    let errText = '';
    let apiMsg = '';
    for (const candidato of listaModelosParaTentar()) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidato)}:generateContent`;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': key,
          },
          signal: AbortSignal.timeout(300000),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts }],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: 'application/json',
            },
          }),
        });
      } catch (error) {
        if (depurar) await depurar(`gemini: fetch falhou: ${error.name || ''} ${error.message || ''}`.trim());
        throw Error('Falha de conexão ou tempo esgotado ao comunicar com o Gemini.');
      }

      if (response.ok) {
        modeloAtivo = candidato;
        break;
      }
      errText = await response.text().catch(() => '');
      apiMsg = '';
      try { apiMsg = JSON.parse(errText)?.error?.message || ''; } catch { /* ignore */ }
      if (depurar) await depurar(`gemini (${candidato}): status=${response.status} len=${errText.length} msg=${apiMsg.slice(0, 120)}`);
      if (response.status === 404) {
        const sugerido = /models\/([\w.-]+flash[\w.-]*)/i.exec(apiMsg)?.[1];
        if (sugerido && !MODELOS_CANDIDATOS.includes(sugerido)) MODELOS_CANDIDATOS.unshift(sugerido);
        continue;
      }
      break;
    }

    if (!response.ok) {
      if (response.status === 400 && errText.toLowerCase().includes('api_key')) {
        throw Error('Chave do Gemini inválida. Confira a chave no Google AI Studio.');
      }
      if (response.status === 401 || response.status === 403) {
        throw Error('Chave do Gemini recusada ou sem permissão.');
      }
      if (response.status === 429) {
        throw Error('Limite de requisições do Gemini atingido. Aguarde alguns segundos e tente novamente.');
      }
      throw Error(`O Gemini não concluiu a solicitação (status ${response.status}${apiMsg ? `: ${apiMsg}` : ''}).`);
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!rawText.trim()) {
      throw Error('O Gemini retornou uma resposta vazia.');
    }
    if (depurar) {
      await depurar(`gemini: concluido usage=${JSON.stringify(data?.usageMetadata || {})}`);
    }
    return normalizarRespostaGemini(rawText);
  }

  return {
    get model() { return modeloAtivo; },
    async estaConfigurado() { return Boolean(await chaveAtual()); },
    validarChave,
    definirChave,
    processarConsulta,
  };
}
