// Módulo do Gravador + Transcrição Diarizada + Geração em 1 Clique (Gemini Flash)
// Permite gravar o microfone (ou importar áudio), validar a chave do Gemini ANTES de iniciar a gravação,
// salvar o áudio .wav automaticamente na pasta do paciente no OneDrive ANTES de chamar a IA (para nunca perder
// uma consulta mesmo se cair a internet), e preencher todas as abas em 1 clique.

import { BLOCK_SECTIONS, buildClinicalBlock } from './bloco.mjs';
import { buildSummary } from './summary.mjs';
import { sourceFile, safeName } from './core.mjs';

function formatarDuracao(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const min = String(Math.floor(s / 60)).padStart(2, '0');
  const seg = String(s % 60).padStart(2, '0');
  return `${min}:${seg}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const partes = [];
  const passo = 32768;
  for (let i = 0; i < bytes.length; i += passo) {
    partes.push(String.fromCharCode(...bytes.subarray(i, i + passo)));
  }
  return btoa(partes.join(''));
}

function base64ToUint8Array(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function encodeWavFromAudioBuffer(audioBuffer) {
  const targetRate = 16000;
  const srcRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);
  const ratio = srcRate / targetRate;
  const newLength = Math.max(1, Math.round(channelData.length / ratio));
  const buffer = new ArrayBuffer(44 + newLength * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + newLength * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, newLength * 2, true);
  let offset = 44;
  for (let i = 0; i < newLength; i++) {
    const idx = Math.min(channelData.length - 1, Math.floor(i * ratio));
    const sample = Math.max(-1, Math.min(1, channelData[idx]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    offset += 2;
  }
  return buffer;
}

async function converterBlobParaWavBase64(blob, mimeOriginal) {
  try {
    const arrayBuf = await blob.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return { base64: arrayBufferToBase64(arrayBuf), mimeType: String(mimeOriginal || 'audio/webm').split(';')[0] };
    const ctx = new Ctx();
    try {
      const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
      const wavBuf = encodeWavFromAudioBuffer(decoded);
      return { base64: arrayBufferToBase64(wavBuf), mimeType: 'audio/wav' };
    } finally {
      ctx.close().catch(() => {});
    }
  } catch {
    const arrayBuf = await blob.arrayBuffer();
    return { base64: arrayBufferToBase64(arrayBuf), mimeType: String(mimeOriginal || 'audio/webm').split(';')[0] };
  }
}

export function montarMarkdownProntuario({ nomePaciente, dataConsulta, resumoClinico, bloco, transcricao }) {
  const linhas = [
    `# Prontuário e Registro de Consulta — ${nomePaciente}`,
    `**Data:** ${dataConsulta.split('-').reverse().join('/')}`,
    '',
  ];
  if (resumoClinico) {
    linhas.push(`## Resumo Clínico`, resumoClinico.trim(), '');
  }
  linhas.push(`## Evolução Estruturada`);
  for (const { key, title } of BLOCK_SECTIONS) {
    const val = (bloco?.[key] || '').trim();
    if (val) {
      linhas.push(`### ${title}`, val, '');
    }
  }
  if (transcricao) {
    linhas.push(`---`, `## Transcrição Completa da Consulta`, '```text', transcricao.trim(), '```', '');
  }
  return linhas.join('\n');
}

export function mountScribe({ $, say, protect, aplicarTranscricaoECampos, templatePromise }) {
  let recorder = null;
  let stream = null;
  let chunks = [];
  let timer = null;
  let inicioMs = 0;
  let acumuladoMs = 0;
  let pausado = false;
  let ultimoAudioBase64 = '';
  let ultimoMimeType = 'audio/wav';

  async function atualizarPastasDatalist() {
    try {
      const r = await fetch('/api/pacientes/pastas-referencia');
      if (!r.ok) return;
      const { pastas } = await r.json();
      const dl = $('scribePatientsDatalist');
      if (!dl) return;
      dl.replaceChildren();
      for (const p of pastas || []) {
        const opt = document.createElement('option');
        opt.value = p.nomeExibicao;
        dl.append(opt);
      }
    } catch { /* ignore */ }
  }

  async function verificarChaveNoServidor({ forcar = false } = {}) {
    const r = await fetch('/api/scribe/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Clinical-Request': '1' },
      body: JSON.stringify({ forcar }),
    });
    const d = await r.json().catch(() => ({}));
    return d;
  }

  function atualizarBadgeInterface({ valid, configured, model, error }) {
    const badge = $('scribeGeminiBadge');
    const box = $('scribeKeyBox');
    const notice = $('scribeKeyVerifyNotice');
    if (badge) {
      if (valid) {
        badge.textContent = `✓ Gemini verificado · ${model || 'gemini-2.5-flash'}`;
        badge.className = 'conn-badge ok';
      } else if (configured) {
        badge.textContent = '❌ Chave Gemini inválida';
        badge.className = 'conn-badge warn';
      } else {
        badge.textContent = 'Chave Gemini pendente';
        badge.className = 'conn-badge warn';
      }
    }
    if (box) box.hidden = Boolean(valid);
    if (notice) {
      notice.textContent = valid
        ? '✓ Chave do Gemini testada e autenticada com sucesso no Google AI Studio.'
        : (error || 'Cole uma chave válida do Google AI Studio (AIza...) antes de iniciar a gravação.');
      notice.style.color = valid ? '' : '#9e2a2b';
    }
  }

  async function atualizarStatusGemini() {
    try {
      const r = await fetch('/api/status');
      if (!r.ok) return;
      const data = await r.json();
      if (!data.geminiConfigured) {
        atualizarBadgeInterface({ valid: false, configured: false, model: data.geminiModel });
        return;
      }
      // Em ambiente de teste automatizado offline (stub-teste), não dispara chamada externa na abertura
      if (data.model === 'stub-teste') {
        atualizarBadgeInterface({ valid: true, configured: true, model: data.geminiModel });
        return;
      }
      const verif = await verificarChaveNoServidor({ forcar: false });
      atualizarBadgeInterface(verif);
    } catch { /* ignore */ }
  }

  function atualizarRelogio() {
    const el = $('scribeTimer');
    if (!el) return;
    const total = acumuladoMs + (pausado ? 0 : Date.now() - inicioMs);
    el.textContent = formatarDuracao(total);
  }

  async function salvarBackupAudioPreventivo(audioBase64) {
    const nome = ($('scribePatientName')?.value || $('patient')?.value || '').trim();
    if (!nome || !audioBase64) return null;
    const dataAtendimento = $('date')?.value || new Date().toISOString().slice(0, 10);
    try {
      const r = await fetch('/api/pacientes/exportar-documentos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Clinical-Request': '1' },
        body: JSON.stringify({
          nomePaciente: nome,
          dataConsulta: dataAtendimento,
          audioWavBase64: audioBase64,
        }),
      });
      if (!r.ok) return null;
      const info = await r.json();
      const backupEl = $('scribeAudioBackupInfo');
      if (backupEl && info?.nomeDaPasta) {
        backupEl.textContent = `✓ Áudio salvo em segurança na pasta de "${info.nomeDaPasta}"`;
      }
      return info;
    } catch {
      return null;
    }
  }

  async function iniciarGravacao() {
    const nome = ($('scribePatientName')?.value || $('patient')?.value || '').trim();
    if (!nome) {
      $('scribePatientName')?.focus();
      throw Error('Informe ou selecione o nome do paciente antes de iniciar a gravação.');
    }
    if ($('patient') && !$('patient').value.trim()) $('patient').value = nome;
    if ($('date') && !$('date').value) $('date').value = new Date().toISOString().slice(0, 10);

    // 1. Confere se a chave do Gemini está realmente válida ANTES de iniciar a gravação!
    say('Conferindo chave do Gemini antes de iniciar a gravação…');
    const verif = await verificarChaveNoServidor({ forcar: true });
    atualizarBadgeInterface(verif);
    if (!verif.valid) {
      const box = $('scribeKeyBox');
      if (box) box.hidden = false;
      $('scribeKeyInput')?.focus();
      throw Error(verif.error || 'Chave do Gemini inválida ou ausente. Configure uma chave válida antes de gravar a consulta.');
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      throw Error('Permissão de microfone recusada ou nenhum microfone encontrado.');
    }

    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'].find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    ultimoMimeType = recorder.mimeType || mime || 'audio/webm';
    chunks = [];

    recorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      clearInterval(timer);
      stream?.getTracks().forEach(t => t.stop());
      stream = null;
      $('scribeStartBtn').hidden = false;
      $('scribePauseBtn').hidden = true;
      $('scribeStopBtn').hidden = true;
      $('scribeRecordingStatus').hidden = true;

      if (!chunks.length) return;
      const blob = new Blob(chunks, { type: ultimoMimeType });
      const convertido = await converterBlobParaWavBase64(blob, ultimoMimeType);
      ultimoAudioBase64 = convertido.base64;
      ultimoMimeType = convertido.mimeType;

      const url = URL.createObjectURL(blob);
      const player = $('scribeAudioPlayer');
      if (player) {
        player.src = url;
        player.hidden = false;
      }
      if ($('scribeAudioActions')) $('scribeAudioActions').hidden = false;

      // Salva o áudio .wav imediatamente na pasta do paciente no OneDrive ANTES de chamar a IA!
      await salvarBackupAudioPreventivo(ultimoAudioBase64);

      try {
        await executarFluxoUmClique({ audioBase64: ultimoAudioBase64, mimeType: ultimoMimeType });
      } catch (err) {
        const msg = err?.message || 'Falha ao processar a gravação no Gemini.';
        say(msg, true);
        const statusBox = $('scribeQuickResult');
        if (statusBox) {
          statusBox.hidden = false;
          statusBox.className = 'action-feedback';
          statusBox.textContent = `❌ ${msg} — Fique tranquilo(a): o áudio da consulta está salvo e seguro! Após ajustar a chave ou conexão, clique em "🔄 Tentar Processar Áudio Novamente".`;
        }
      }
    };

    recorder.start(2000);
    inicioMs = Date.now();
    acumuladoMs = 0;
    pausado = false;
    timer = setInterval(atualizarRelogio, 250);

    $('scribeStartBtn').hidden = true;
    $('scribePauseBtn').hidden = false;
    $('scribePauseBtn').textContent = 'Pausar';
    $('scribeStopBtn').hidden = false;
    $('scribeRecordingStatus').hidden = false;
    say(`Gravando consulta de ${nome} (chave Gemini verificada ✓)… Quando terminar, clique em "Encerrar e Gerar Tudo".`);
  }

  function pausarOuRetomar() {
    if (!recorder || recorder.state === 'inactive') return;
    if (!pausado) {
      recorder.pause();
      acumuladoMs += Date.now() - inicioMs;
      pausado = true;
      $('scribePauseBtn').textContent = 'Retomar gravação';
      say('Gravação pausada.');
    } else {
      recorder.resume();
      inicioMs = Date.now();
      pausado = false;
      $('scribePauseBtn').textContent = 'Pausar';
      say('Gravação retomada.');
    }
  }

  function encerrarGravacao() {
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop();
  }

  async function executarFluxoUmClique({ audioBase64 = '', mimeType = 'audio/wav' } = {}) {
    const nome = ($('scribePatientName')?.value || $('patient')?.value || '').trim();
    if (!nome) throw Error('Informe o nome do paciente.');
    if ($('patient')) $('patient').value = nome;
    if ($('date') && !$('date').value) $('date').value = new Date().toISOString().slice(0, 10);
    if ($('modality') && !$('modality').value) $('modality').value = 'Avulso';

    const statusBox = $('scribeQuickResult');
    if (statusBox) {
      statusBox.hidden = false;
      statusBox.className = 'next-steps';
      statusBox.textContent = '⏳ O Gemini 2.5 Flash está ouvindo a consulta, separando Profissional e Paciente e montando o Prontuário + Pós-Consulta…';
    }
    say('Processando áudio no Gemini Flash… Aguarde alguns instantes.');

    const contextoExtra = [
      $('examsProse')?.value?.trim() && `Exames:\n${$('examsProse').value.trim()}`,
      $('biaProse')?.value?.trim() && `Bioimpedância:\n${$('biaProse').value.trim()}`,
    ].filter(Boolean).join('\n\n');

    const resp = await fetch('/api/scribe/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Clinical-Request': '1' },
      body: JSON.stringify({
        audioBase64,
        mimeType,
        transcricaoTexto: !audioBase64 ? ($('pastedTranscript')?.value || '') : '',
        contextoExtra,
      }),
    });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const errMsg = dados.error || 'Falha ao processar consulta no Gemini.';
      if (statusBox) {
        statusBox.hidden = false;
        statusBox.className = 'action-feedback';
        statusBox.textContent = `❌ ${errMsg} — O áudio gravado continua salvo na tela e na pasta do paciente. Clique em "🔄 Tentar Processar Áudio Novamente" quando desejar.`;
      }
      throw Error(errMsg);
    }

    // Preenche a transcrição, o Bloco do Prontuário e os 6 campos do Resumo Pós-Consulta
    const codigoBloco = buildClinicalBlock(dados.bloco, { heading: $('bloco_heading')?.value?.trim() || '1. Prontuário clínico' });
    const templateHtml = await templatePromise;
    const dataAtendimento = $('date')?.value || new Date().toISOString().slice(0, 10);
    const resumoHtml = buildSummary(templateHtml, {
      patient: nome,
      date: dataAtendimento,
      patientType: $('patientType')?.value || 'Nova consulta',
      ...dados.resumoPaciente,
      commercialEnabled: false,
      obsobesidade: '',
    });

    await aplicarTranscricaoECampos({
      nome,
      dataAtendimento,
      transcricao: dados.transcricao,
      bloco: dados.bloco,
      codigoBloco,
      resumoPaciente: dados.resumoPaciente,
      resumoClinico: dados.resumoClinico,
      mensagemWhatsapp: dados.mensagemWhatsapp,
    });

    const prontuarioMd = montarMarkdownProntuario({
      nomePaciente: nome,
      dataConsulta: dataAtendimento,
      resumoClinico: dados.resumoClinico,
      bloco: dados.bloco,
      transcricao: dados.transcricao,
    });

    // Salva automaticamente na pasta do paciente no OneDrive!
    let infoSalvo = null;
    try {
      const saveResp = await fetch('/api/pacientes/exportar-documentos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Clinical-Request': '1' },
        body: JSON.stringify({
          nomePaciente: nome,
          dataConsulta: dataAtendimento,
          transcricao: dados.transcricao,
          prontuarioHtml: codigoBloco,
          prontuarioMd,
          resumoHtml,
          mensagemWhatsapp: dados.mensagemWhatsapp,
        }),
      });
      if (saveResp.ok) infoSalvo = await saveResp.json();
    } catch { /* se a pasta não estiver configurada, avisa abaixo */ }

    await atualizarPastasDatalist();

    if (statusBox) {
      statusBox.className = 'next-steps';
      statusBox.replaceChildren();
      const titulo = document.createElement('strong');
      titulo.textContent = infoSalvo
        ? `✓ Consulta processada e salva na pasta de "${infoSalvo.nomeDaPasta}"!`
        : '✓ Consulta transcrita e estruturada!';
      const detalhe = document.createElement('p');
      detalhe.textContent = infoSalvo
        ? `Caminho: ${infoSalvo.pastaPaciente} (${infoSalvo.arquivosSalvos.join(', ')})`
        : 'Configure a pasta do OneDrive em Ajustes para salvar os arquivos automaticamente.';
      statusBox.append(titulo, detalhe);
      statusBox.hidden = false;
    }

    say(infoSalvo
      ? `Pronto! Transcrição, Prontuário e Resumo salvos na pasta de ${infoSalvo.nomeDaPasta}.`
      : 'Pronto! Transcrição, Prontuário e Resumo gerados.');
  }

  if ($('scribeStartBtn')) $('scribeStartBtn').onclick = protect(iniciarGravacao);
  if ($('scribePauseBtn')) $('scribePauseBtn').onclick = pausarOuRetomar;
  if ($('scribeStopBtn')) $('scribeStopBtn').onclick = encerrarGravacao;

  if ($('scribeRetryBtn')) {
    $('scribeRetryBtn').onclick = protect(async () => {
      if (!ultimoAudioBase64) throw Error('Nenhum áudio gravado ou importado disponível para reprocessar.');
      await executarFluxoUmClique({ audioBase64: ultimoAudioBase64, mimeType: ultimoMimeType });
    });
  }

  if ($('scribeDownloadAudioBtn')) {
    $('scribeDownloadAudioBtn').onclick = protect(async () => {
      if (!ultimoAudioBase64) throw Error('Nenhum áudio gravado disponível.');
      const nome = safeName(($('scribePatientName')?.value || $('patient')?.value || 'consulta').trim());
      const data = $('date')?.value || new Date().toISOString().slice(0, 10);
      const blob = new Blob([base64ToUint8Array(ultimoAudioBase64)], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data}_Audio_${nome}.wav`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      say('Áudio .wav baixado com sucesso.');
    });
  }

  if ($('scribeAudioFile')) {
    $('scribeAudioFile').onchange = protect(async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > 28 * 1024 * 1024) throw Error('Arquivo de áudio maior que 28 MB.');
      const rawMime = file.type || (file.name.endsWith('.mp3') ? 'audio/mpeg' : file.name.endsWith('.wav') ? 'audio/wav' : file.name.endsWith('.m4a') ? 'audio/mp4' : 'audio/webm');
      const convertido = await converterBlobParaWavBase64(file, rawMime);
      ultimoAudioBase64 = convertido.base64;
      ultimoMimeType = convertido.mimeType;
      const player = $('scribeAudioPlayer');
      if (player) {
        player.src = URL.createObjectURL(file);
        player.hidden = false;
      }
      if ($('scribeAudioActions')) $('scribeAudioActions').hidden = false;
      await salvarBackupAudioPreventivo(ultimoAudioBase64);
      await executarFluxoUmClique({ audioBase64: ultimoAudioBase64, mimeType: ultimoMimeType });
    });
  }

  if ($('scribeSaveKeyBtn')) {
    $('scribeSaveKeyBtn').onclick = protect(async () => {
      const key = ($('scribeKeyInput')?.value || '').trim();
      if (!key) throw Error('Cole a chave do Gemini antes de salvar.');
      say('Testando a chave do Gemini diretamente no Google AI Studio…');
      const r = await fetch('/api/scribe/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Clinical-Request': '1' },
        body: JSON.stringify({ apiKey: key }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        atualizarBadgeInterface({ valid: false, configured: false, error: d.error });
        throw Error(d.error || 'Não foi possível validar a chave do Gemini.');
      }
      $('scribeKeyInput').value = '';
      // Também já deixa o provedor de PDFs (Exames/Bioimpedância) pré-configurado com a mesma chave Gemini,
      // sem tirar a liberdade de trocar para Anthropic, DeepSeek ou OpenAI em Ajustes!
      if ($('aiProvider') && !$('aiKey')?.value?.trim()) {
        $('aiProvider').value = 'gemini';
        $('aiProvider').dispatchEvent(new Event('change'));
        if ($('aiKey')) {
          $('aiKey').value = key;
          $('aiKey').dispatchEvent(new Event('input'));
        }
        if ($('aiConsent')) $('aiConsent').checked = true;
      }
      await atualizarStatusGemini();
      say('✓ Chave do Gemini testada, validada e salva com sucesso!');
    });
  }

  if ($('scribeTestKeyBtn')) {
    $('scribeTestKeyBtn').onclick = protect(async () => {
      const digitada = ($('scribeKeyInput')?.value || '').trim();
      if (digitada) {
        $('scribeSaveKeyBtn').click();
        return;
      }
      say('Verificando chave atual do Gemini junto ao Google…');
      const verif = await verificarChaveNoServidor({ forcar: true });
      atualizarBadgeInterface(verif);
      if (!verif.valid) throw Error(verif.error || 'Chave do Gemini inválida.');
      say('✓ Chave do Gemini testada e funcionando perfeitamente!');
    });
  }

  if ($('scribeToggleKeyBtn')) {
    $('scribeToggleKeyBtn').onclick = () => {
      const box = $('scribeKeyBox');
      if (box) box.hidden = !box.hidden;
    };
  }

  if ($('scribeCopyBlocoBtn')) {
    $('scribeCopyBlocoBtn').onclick = protect(async () => {
      const codigo = $('blockCode')?.value || '';
      if (!codigo) throw Error('Grave ou processe uma consulta primeiro.');
      await navigator.clipboard.writeText(codigo);
      say('Bloco do prontuário copiado! Pode colar direto no Gestão DS.');
    });
  }

  if ($('scribePrintResumoBtn')) {
    $('scribePrintResumoBtn').onclick = protect(async () => {
      const frame = $('summaryFrame');
      if (!frame || !frame.contentWindow || frame.hidden) throw Error('Gere uma consulta primeiro.');
      frame.contentWindow.print();
      say('Janela de impressão aberta! Escolha "Salvar como PDF".');
    });
  }

  if ($('scribeDownloadResumoBtn')) {
    $('scribeDownloadResumoBtn').onclick = protect(async () => {
      if ($('exportSummary') && !$('exportSummary').disabled) {
        $('exportSummary').click();
      } else {
        throw Error('Gere uma consulta primeiro.');
      }
    });
  }

  if ($('scribeCopyTranscricaoBtn')) {
    $('scribeCopyTranscricaoBtn').onclick = protect(async () => {
      const texto = $('scribeTranscriptText')?.value || $('originalText')?.textContent || '';
      if (!texto) throw Error('Nenhuma transcrição disponível ainda.');
      await navigator.clipboard.writeText(texto);
      say('Transcrição completa copiada!');
    });
  }

  if ($('scribeCopyWhatsappBtn')) {
    $('scribeCopyWhatsappBtn').onclick = protect(async () => {
      const texto = $('scribeWhatsappText')?.value || '';
      if (!texto) throw Error('Nenhuma mensagem de WhatsApp disponível ainda.');
      await navigator.clipboard.writeText(texto);
      say('Mensagem de WhatsApp copiada!');
    });
  }

  if ($('scribeProcessPastedBtn')) {
    $('scribeProcessPastedBtn').onclick = protect(async () => {
      const texto = ($('pastedTranscript')?.value || '').trim();
      if (!texto) throw Error('Cole a transcrição no campo acima primeiro.');
      await executarFluxoUmClique({ audioBase64: '', mimeType: '' });
    });
  }

  atualizarPastasDatalist();
  atualizarStatusGemini();

  return {
    atualizarPastasDatalist,
    atualizarStatusGemini,
    estaGravando() {
      return Boolean(recorder && recorder.state !== 'inactive');
    },
    temTrabalhoScribe() {
      return Boolean((recorder && recorder.state !== 'inactive') || ultimoAudioBase64);
    },
    limparAudio() {
      ultimoAudioBase64 = '';
      if ($('scribeAudioPlayer')) {
        $('scribeAudioPlayer').pause();
        $('scribeAudioPlayer').removeAttribute('src');
        $('scribeAudioPlayer').hidden = true;
      }
      if ($('scribeAudioActions')) $('scribeAudioActions').hidden = true;
      if ($('scribeQuickResult')) $('scribeQuickResult').hidden = true;
      if ($('scribeResultDrawer')) $('scribeResultDrawer').hidden = true;
    },
    sourceFileFromTranscript(texto) {
      return sourceFile(new TextEncoder().encode(texto), 'transcricao-gemini.txt');
    },
  };
}
