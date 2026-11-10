// Log de diagnóstico (debug.log): só contagens, tamanhos e códigos — nunca texto clínico (ver os
// testes "diagnóstico" em tests/core.test.mjs). Sem isto o arquivo crescia sem limite e nem a
// desinstalação o removia. Separado de electron/main.mjs para poder ser testado sem o Electron.
import { appendFile, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const LIMITE_BYTES = 1_000_000;
export const DIAS_DE_GUARDA = 14;

// Acrescenta uma linha datada. Ao passar do limite, o log atual vira `debug.1.log` (substituindo o
// anterior, então o total nunca passa de ~2 MB) e um novo começa. Diagnóstico nunca derruba o app.
export async function registrar(pasta, linha, { agora = () => new Date(), limite = LIMITE_BYTES } = {}) {
  const arquivo = join(pasta, 'debug.log');
  try {
    try { if ((await stat(arquivo)).size > limite) await rename(arquivo, join(pasta, 'debug.1.log')); } catch { /* ainda não existe */ }
    await appendFile(arquivo, `${agora().toISOString()} ${linha}\n`);
  } catch { /* sem permissão de escrita: o app segue sem log */ }
}

// Remove do log as linhas com mais de `dias` dias (a data ISO no começo de cada linha permite
// comparar como texto) e apaga o `debug.1.log` se ele também for mais velho que isso.
export async function expurgar(pasta, dias = DIAS_DE_GUARDA, agora = new Date()) {
  const corte = new Date(agora.getTime() - dias * 86_400_000).toISOString();
  try {
    const linhas = (await readFile(join(pasta, 'debug.log'), 'utf8')).split('\n');
    let manter = false;
    const recentes = linhas.filter(linha => {
      const data = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z/.exec(linha)?.[0];
      if (data) manter = data >= corte;
      return manter && linha !== '';
    });
    await writeFile(join(pasta, 'debug.log'), recentes.length ? recentes.join('\n') + '\n' : '');
  } catch { /* sem log ainda */ }
  try {
    if ((await stat(join(pasta, 'debug.1.log'))).mtime < new Date(agora.getTime() - dias * 86_400_000)) await unlink(join(pasta, 'debug.1.log'));
  } catch { /* não existe */ }
}
