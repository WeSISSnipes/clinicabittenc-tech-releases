// Atualizador em 1 clique do aplicativo (via GitHub)
// Baixa os arquivos atualizados diretamente do repositório GitHub público de releases
// (WeSISSnipes/clinicabittenc-tech-releases) ou do repositório principal (clinicabittenc-tech/prontuario_meta.workflow)
// sem precisar baixar instalador .zip/.exe manualmente e sem esbarrar no bloqueio do Smart App Control.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

export const FONTES_GITHUB = [
  'https://raw.githubusercontent.com/WeSISSnipes/clinicabittenc-tech-releases/main',
  'https://raw.githubusercontent.com/clinicabittenc-tech/prontuario_meta.workflow/main',
];

export const ARQUIVOS_ATUALIZAVEIS = [
  'package.json',
  'server.mjs',
  'clinical-api.mjs',
  'gemini-scribe.mjs',
  'patients-store.mjs',
  'diagnostico.mjs',
  'updater.mjs',
  'app/index.html',
  'app/app.css',
  'app/app.mjs',
  'app/core.mjs',
  'app/summary.mjs',
  'app/review.mjs',
  'app/exams.mjs',
  'app/pdf.mjs',
  'app/bioimpedancia.mjs',
  'app/draft.mjs',
  'app/ai.mjs',
  'app/providers.mjs',
  'app/bloco.mjs',
  'app/hub.mjs',
  'app/wizard.mjs',
  'app/sources.mjs',
  'app/pacientes.mjs',
  'app/ui.mjs',
  'app/icons.mjs',
  'app/scribe.mjs',
  'templates/resumo-template.html',
];

export function compararVersoes(a, b) {
  const pa = String(a || '0.0.0').replace(/^v/i, '').split('.').map(n => Number(n) || 0);
  const pb = String(b || '0.0.0').replace(/^v/i, '').split('.').map(n => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function obterTokenGitLocal(username = 'clinicabittenc-tech') {
  if (process.env.GITHUB_UPDATE_TOKEN) return process.env.GITHUB_UPDATE_TOKEN.trim();
  return new Promise(resolve => {
    let concluido = false;
    const finalizar = val => { if (!concluido) { concluido = true; resolve(val); } };
    const timer = setTimeout(() => finalizar(''), 2000);
    try {
      const proc = spawn('git', ['credential', 'fill'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let out = '';
      proc.stdout.on('data', d => { out += d.toString('utf8'); });
      proc.on('error', () => { clearTimeout(timer); finalizar(''); });
      proc.on('close', () => {
        clearTimeout(timer);
        const m = /^password=(.+)$/m.exec(out);
        finalizar(m ? m[1].trim() : '');
      });
      proc.stdin.write(`protocol=https\nhost=github.com\nusername=${username}\n\n`);
      proc.stdin.end();
    } catch {
      clearTimeout(timer);
      finalizar('');
    }
  });
}

export function createUpdaterService({
  appRoot,
  fontes = FONTES_GITHUB,
  fetchImpl = fetch,
  depurar = null,
} = {}) {
  async function lerVersaoLocal() {
    try {
      const pkg = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  async function baixarArquivoDeFonte(fonte, relPath) {
    if (fonte.tipo === 'github-api') {
      const url = `https://api.github.com/repos/${fonte.repo}/contents/${relPath}?ref=${fonte.branch || 'main'}`;
      const res = await fetchImpl(url, {
        headers: {
          Accept: 'application/vnd.github.raw+json',
          Authorization: `Bearer ${fonte.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'cache-control': 'no-cache',
        },
        signal: AbortSignal.timeout(12000),
      });
      return res;
    }
    const url = `${fonte.baseUrl}/${relPath}?t=${Date.now()}`;
    return fetchImpl(url, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(12000),
    });
  }

  async function buscarFonteRemota() {
    const candidatos = [];
    for (const baseUrl of fontes) {
      try {
        const res = await fetchImpl(`${baseUrl}/package.json?t=${Date.now()}`, {
          headers: { 'cache-control': 'no-cache' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) continue;
        const pkg = await res.json();
        if (pkg && typeof pkg.version === 'string') {
          candidatos.push({ tipo: 'raw', baseUrl, version: pkg.version, pkg });
        }
      } catch { /* tenta próxima fonte */ }
    }
    // Se as fontes públicas não responderem ou se houver credencial local para o repositório privado:
    if (!candidatos.length && fetchImpl === fetch) {
      const token = await obterTokenGitLocal('clinicabittenc-tech');
      if (token) {
        try {
          const fonteApi = { tipo: 'github-api', repo: 'clinicabittenc-tech/prontuario_meta.workflow', branch: 'main', baseUrl: 'github:clinicabittenc-tech/prontuario_meta.workflow', token };
          const res = await baixarArquivoDeFonte(fonteApi, 'package.json');
          if (res.ok) {
            const pkg = await res.json();
            if (pkg && typeof pkg.version === 'string') {
              candidatos.push({ ...fonteApi, version: pkg.version, pkg });
            }
          }
        } catch { /* ignore */ }
      }
    }
    if (!candidatos.length) return null;
    candidatos.sort((a, b) => compararVersoes(b.version, a.version));
    return candidatos[0];
  }

  async function verificarAtualizacao() {
    const currentVersion = await lerVersaoLocal();
    const remoto = await buscarFonteRemota();
    if (!remoto) {
      return {
        ok: false,
        currentVersion,
        latestVersion: currentVersion,
        hasUpdate: false,
        message: 'Você já está na versão instalada (v' + currentVersion + '). Nenhuma atualização pendente encontrada no GitHub.',
      };
    }
    const hasUpdate = compararVersoes(remoto.version, currentVersion) > 0;
    return {
      ok: true,
      currentVersion,
      latestVersion: remoto.version,
      hasUpdate,
      source: remoto.baseUrl,
      message: hasUpdate
        ? `Nova versão disponível no GitHub: v${remoto.version} (atual: v${currentVersion}).`
        : `O aplicativo já está na versão mais recente (v${currentVersion}).`,
    };
  }

  async function aplicarAtualizacao({ forcar = false } = {}) {
    const currentVersion = await lerVersaoLocal();
    const remoto = await buscarFonteRemota();
    if (!remoto) {
      throw Error(`Não foi possível consultar atualizações no GitHub agora (versão atual: v${currentVersion}). Verifique a conexão com a internet.`);
    }
    const hasUpdate = compararVersoes(remoto.version, currentVersion) > 0;
    if (!hasUpdate && !forcar) {
      return {
        updated: false,
        previousVersion: currentVersion,
        version: currentVersion,
        updatedFilesCount: 0,
        message: `O aplicativo já está na versão mais recente (v${currentVersion}).`,
      };
    }

    const baixados = [];
    for (const relPath of ARQUIVOS_ATUALIZAVEIS) {
      const res = await baixarArquivoDeFonte(remoto, relPath);
      if (!res.ok) {
        if (relPath === 'updater.mjs') continue;
        throw Error(`Falha ao baixar arquivo da atualização (${relPath}: status ${res.status}).`);
      }
      const conteudo = await res.text();
      if (!conteudo.trim()) {
        throw Error(`Arquivo ${relPath} veio vazio na atualização.`);
      }
      baixados.push({ relPath, conteudo });
    }

    for (const { relPath, conteudo } of baixados) {
      const destino = join(appRoot, relPath);
      await mkdir(dirname(destino), { recursive: true });
      await writeFile(destino, conteudo, 'utf8');
    }

    if (depurar) {
      await depurar(`updater: atualizado de v${currentVersion} para v${remoto.version} (${baixados.length} arquivos)`);
    }

    return {
      updated: true,
      previousVersion: currentVersion,
      version: remoto.version,
      updatedFilesCount: baixados.length,
      message: `Aplicativo atualizado com sucesso para a versão v${remoto.version} (${baixados.length} arquivos sincronizados)! Recarregando…`,
    };
  }

  return {
    lerVersaoLocal,
    verificarAtualizacao,
    aplicarAtualizacao,
  };
}
