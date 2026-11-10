// Histórico local de pacientes e consultas, dentro de um diretório que a profissional escolhe uma
// vez. Nada aqui é automático — salvar continua sendo uma ação explícita; isto só organiza onde e
// como o arquivo é gravado.
//
// Cada pessoa é identificada por DOIS identificadores, nome e data de nascimento, como pede o
// protocolo de identificação do paciente: só o nome misturava no mesmo histórico duas pessoas
// homônimas, e também "José Conceição" com "Jose Conceicao". A pasta é `<nome-seguro>_<AAAA-MM-DD>`
// e guarda `_perfil.json` (nome como foi escrito, com acentos, e um índice leve do que cada consulta
// contém) mais um arquivo por consulta, `<AAAA-MM-DD>_<id>.json`.
//
// Pastas gravadas antes disso (só o nome, sem perfil) continuam listadas e abrindo, marcadas como
// sem data de nascimento; registrar a data move a pasta para o formato novo sem perder nada.
//
// Sem criptografia nesta versão: a pasta é protegida pelo controle de acesso do próprio sistema
// operacional. Levar o histórico para outro computador é copiar a pasta inteira.
import { mkdir, readdir, readFile, writeFile, rename, stat, unlink, rmdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { safeName } from './app/core.mjs';

const CONSULTA = /^\d{4}-\d{2}-\d{2}_[\w-]+\.json$/;
const ID_PACIENTE = /^[A-Za-z0-9_-]{1,80}$/;
const PERFIL = '_perfil.json';

// Data de nascimento: AAAA-MM-DD de verdade (o mês 13 ou o dia 31/02 não passam), nunca no futuro.
export function nascimentoValido(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const data = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== valor) return false;
  return data.getUTCFullYear() >= 1900 && data <= new Date();
}

function resumoDaConsulta(dados) {
  const hub = dados?.hub;
  return {
    itens: Array.isArray(hub?.base?.itens) ? hub.base.itens.length : 0,
    mensagem: Boolean(hub?.outputs?.mensagem?.texto),
    resumo: Boolean(hub?.outputs?.resumo?.texto),
    exames: Boolean(dados?.fields?.examsProse?.trim?.()),
  };
}

export function createPatientsStore({ configPath, repoRoot } = {}) {
  async function lerConfig() {
    try { return JSON.parse(await readFile(configPath, 'utf8')); }
    catch { return {}; }
  }

  async function obterPasta() {
    return (await lerConfig()).pasta || null;
  }

  // A pasta escolhida nunca pode ficar dentro do próprio projeto: dado clínico não é arquivo de
  // projeto e não pode acabar versionado ou sincronizado por engano junto com o código.
  async function definirPasta(caminho) {
    if (typeof caminho !== 'string' || !caminho.trim()) throw Error('Informe um caminho de pasta.');
    const absoluto = resolve(caminho.trim());
    if (repoRoot && (absoluto === repoRoot || absoluto.startsWith(repoRoot + sep))) {
      throw Error('Escolha uma pasta fora da pasta do aplicativo, para não misturar dado clínico com o código.');
    }
    await mkdir(absoluto, { recursive: true });
    await writeFile(configPath, JSON.stringify({ pasta: absoluto }, null, 2));
    return absoluto;
  }

  async function exigirPasta() {
    const base = await obterPasta();
    if (!base) throw Error('Configure a pasta de dados antes.');
    return base;
  }

  // O identificador vem do navegador: só letras, números, _ e -, sem separador de caminho nem ponto,
  // então nunca aponta para fora da pasta base.
  function caminhoDoPaciente(base, id) {
    if (typeof id !== 'string' || !ID_PACIENTE.test(id)) throw Error('Paciente inválido.');
    return join(base, id);
  }

  async function lerPerfil(caminho) {
    try { return JSON.parse(await readFile(join(caminho, PERFIL), 'utf8')); }
    catch { return null; }
  }

  async function arquivosDeConsulta(caminho) {
    try { return (await readdir(caminho)).filter(f => CONSULTA.test(f)).sort().reverse(); }
    catch { return []; }
  }

  function idPara(nome, nascimento) {
    return `${safeName(nome)}_${nascimento}`;
  }

  async function descreverPaciente(base, id) {
    const caminho = join(base, id);
    const [perfil, consultas] = await Promise.all([lerPerfil(caminho), arquivosDeConsulta(caminho)]);
    const legado = !perfil || !nascimentoValido(perfil.nascimento);
    return {
      id,
      nome: typeof perfil?.nome === 'string' && perfil.nome.trim() ? perfil.nome : id.replace(/_\d{4}-\d{2}-\d{2}$/, '').replace(/-/g, ' '),
      nascimento: legado ? null : perfil.nascimento,
      consultas: consultas.length,
      ultima: consultas[0]?.slice(0, 10) ?? null,
      legado,
    };
  }

  async function listarPacientes() {
    const base = await obterPasta();
    if (!base) return [];
    let entradas;
    try { entradas = await readdir(base, { withFileTypes: true }); } catch { return []; }
    const ids = entradas.filter(e => e.isDirectory() && ID_PACIENTE.test(e.name)).map(e => e.name);
    const pacientes = await Promise.all(ids.map(id => descreverPaciente(base, id)));
    return pacientes.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }) || String(a.nascimento).localeCompare(String(b.nascimento)));
  }

  async function obterPaciente(id) {
    const base = await exigirPasta();
    caminhoDoPaciente(base, id);
    return descreverPaciente(base, id);
  }

  async function listarConsultas(id) {
    const base = await exigirPasta();
    const caminho = caminhoDoPaciente(base, id);
    const [perfil, arquivos] = await Promise.all([lerPerfil(caminho), arquivosDeConsulta(caminho)]);
    return arquivos.map(arquivo => ({ arquivo, data: arquivo.slice(0, 10), ...(perfil?.consultas?.[arquivo] ?? {}) }));
  }

  async function gravarPerfil(caminho, perfil) {
    await writeFile(join(caminho, PERFIL), JSON.stringify(perfil, null, 2));
  }

  async function salvarConsulta(identificacao, dados) {
    const nome = typeof identificacao?.nome === 'string' ? identificacao.nome.trim() : '';
    if (!nome) throw Error('Identificação do paciente é obrigatória para salvar no histórico.');
    if (!nascimentoValido(identificacao?.nascimento)) throw Error('Informe a data de nascimento do paciente para salvar no histórico — ela separa pessoas com o mesmo nome.');
    const base = await exigirPasta();
    const id = idPara(nome, identificacao.nascimento);
    const caminho = join(base, id);
    await mkdir(caminho, { recursive: true });
    // A sessão guarda a data do atendimento em `fields.date`; arquivar pela data em que o botão foi
    // clicado colocaria uma consulta salva no dia seguinte fora de ordem no histórico.
    const dataBruta = typeof dados?.date === 'string' ? dados.date : typeof dados?.fields?.date === 'string' ? dados.fields.date : '';
    const data = /^\d{4}-\d{2}-\d{2}$/.test(dataBruta) ? dataBruta : new Date().toISOString().slice(0, 10);
    const idDaConsulta = safeName(String(dados?.id ?? Date.now()));
    const arquivo = `${data}_${idDaConsulta}.json`;
    await writeFile(join(caminho, arquivo), JSON.stringify(dados, null, 2));
    const perfil = (await lerPerfil(caminho)) ?? {};
    const consultas = { ...(perfil.consultas ?? {}), [arquivo]: resumoDaConsulta(dados) };
    // A mesma consulta salva de novo com outra data de atendimento gravava um segundo arquivo e
    // aparecia duas vezes no histórico. O arquivo é `AAAA-MM-DD_<id>.json` (11 caracteres de prefixo):
    // o antigo, com o mesmo id e data diferente, é substituído — nunca um de outra consulta.
    if (dados?.id != null) {
      for (const antigo of await arquivosDeConsulta(caminho)) {
        if (antigo === arquivo || antigo.slice(11) !== `${idDaConsulta}.json`) continue;
        try { await unlink(join(caminho, antigo)); delete consultas[antigo]; } catch { /* não foi possível remover; fica como está */ }
      }
    }
    await gravarPerfil(caminho, { nome, nascimento: identificacao.nascimento, consultas });
    return { id, arquivo };
  }

  async function lerConsulta(id, arquivo) {
    const base = await exigirPasta();
    const caminho = caminhoDoPaciente(base, id);
    if (typeof arquivo !== 'string' || !CONSULTA.test(arquivo)) throw Error('Nome de arquivo inválido.');
    return JSON.parse(await readFile(join(caminho, arquivo), 'utf8'));
  }

  // Converte uma pasta antiga (só nome) para o formato com data de nascimento. Se já existir uma
  // pasta com esse nome e essa data, as consultas são juntadas a ela; um arquivo de mesmo nome nos
  // dois lados interrompe tudo antes de mover qualquer coisa, para nunca sobrescrever uma consulta.
  async function registrarNascimento(idAntigo, identificacao) {
    const nome = typeof identificacao?.nome === 'string' ? identificacao.nome.trim() : '';
    if (!nome) throw Error('Informe o nome do paciente.');
    if (!nascimentoValido(identificacao?.nascimento)) throw Error('Informe uma data de nascimento válida.');
    const base = await exigirPasta();
    const origem = caminhoDoPaciente(base, idAntigo);
    const idNovo = idPara(nome, identificacao.nascimento);
    const destino = join(base, idNovo);
    const consultasOrigem = await arquivosDeConsulta(origem);
    const perfilOrigem = await lerPerfil(origem);
    let destinoExiste = false;
    try { destinoExiste = idNovo !== idAntigo && (await stat(destino)).isDirectory(); } catch { destinoExiste = false; }
    if (!destinoExiste) {
      if (idNovo !== idAntigo) await rename(origem, destino);
    } else {
      const noDestino = new Set(await arquivosDeConsulta(destino));
      const conflito = consultasOrigem.find(arquivo => noDestino.has(arquivo));
      if (conflito) throw Error(`Já existe uma consulta ${conflito} no histórico de destino. Nada foi movido.`);
      for (const arquivo of consultasOrigem) await rename(join(origem, arquivo), join(destino, arquivo));
      // A pasta antiga ficaria vazia e apareceria na lista como um paciente sem consultas. `rmdir`
      // só remove pasta vazia: se sobrou qualquer outro arquivo ali, ela fica, e nada se perde.
      try { await unlink(join(origem, PERFIL)); } catch { /* pasta antiga não tinha perfil */ }
      try { await rmdir(origem); } catch { /* sobrou algo que não é consulta; fica como está */ }
    }
    const perfilDestino = (await lerPerfil(destino)) ?? {};
    await gravarPerfil(destino, {
      nome,
      nascimento: identificacao.nascimento,
      consultas: { ...(perfilOrigem?.consultas ?? {}), ...(perfilDestino.consultas ?? {}) },
    });
    return { id: idNovo };
  }

  return { obterPasta, definirPasta, listarPacientes, obterPaciente, listarConsultas, salvarConsulta, lerConsulta, registrarNascimento,
    // Suporte direto às pastas de referência do OneDrive (ex.: Nutri Helper Pacientes\Pacientes\<Nome do Paciente>)
    // Lista as subpastas reais (inclusive com espaços e acentos) e grava os documentos prontos (.txt, .md, .html) lá dentro.
    async listarPastasReferencia() {
      const base = await obterPasta();
      if (!base) return [];
      let entradas;
      try { entradas = await readdir(base, { withFileTypes: true }); } catch { return []; }
      return entradas
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({
          pastaNome: e.name,
          nomeExibicao: e.name.replace(/_\d{4}-\d{2}-\d{2}$/, ''),
        }))
        .sort((a, b) => a.nomeExibicao.localeCompare(b.nomeExibicao, 'pt-BR', { sensitivity: 'base' }));
    },
    async exportarDocumentosPaciente({ nomePaciente, dataConsulta, audioWavBase64 = '', transcricao = '', prontuarioHtml = '', prontuarioMd = '', resumoHtml = '', mensagemWhatsapp = '' }) {
      const base = await obterPasta();
      if (!base) throw Error('Configure a pasta de pacientes (OneDrive) em Ajustes primeiro.');
      const nomeLimpo = String(nomePaciente || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\.+$/, '').trim();
      if (!nomeLimpo) throw Error('Informe o nome do paciente para salvar na pasta.');
      // Se já existir uma pasta com o mesmo nome (ignorando maiúsculas/minúsculas ou com sufixo de data), usa a existente!
      let entradas = [];
      try { entradas = await readdir(base, { withFileTypes: true }); } catch { entradas = []; }
      const norm = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
      const alvoNorm = norm(nomeLimpo);
      const existente = entradas.find(e => e.isDirectory() && (norm(e.name) === alvoNorm || norm(e.name.replace(/_\d{4}-\d{2}-\d{2}$/, '')) === alvoNorm));
      const nomeDaPasta = existente ? existente.name : nomeLimpo;
      const pastaPaciente = join(base, nomeDaPasta);
      if (!pastaPaciente.startsWith(base + sep)) throw Error('Caminho de pasta inválido.');
      await mkdir(pastaPaciente, { recursive: true });

      const data = /^\d{4}-\d{2}-\d{2}$/.test(String(dataConsulta || '')) ? dataConsulta : new Date().toISOString().slice(0, 10);
      const slug = safeName(nomeLimpo);
      const arquivosSalvos = [];

      if (typeof audioWavBase64 === 'string' && audioWavBase64.trim()) {
        const arq = `${data}_Audio_${slug}.wav`;
        await writeFile(join(pastaPaciente, arq), Buffer.from(audioWavBase64, 'base64'));
        arquivosSalvos.push(arq);
      }
      if (transcricao.trim()) {
        const arq = `${data}_Transcricao_${slug}.txt`;
        await writeFile(join(pastaPaciente, arq), transcricao, 'utf8');
        arquivosSalvos.push(arq);
      }
      if (prontuarioMd.trim()) {
        const arq = `${data}_Prontuario_${slug}.md`;
        await writeFile(join(pastaPaciente, arq), prontuarioMd, 'utf8');
        arquivosSalvos.push(arq);
      }
      if (prontuarioHtml.trim()) {
        const arq = `${data}_Bloco_GestaoDS_${slug}.html`;
        await writeFile(join(pastaPaciente, arq), prontuarioHtml, 'utf8');
        arquivosSalvos.push(arq);
      }
      if (resumoHtml.trim()) {
        const arq = `resumo_consulta_${slug}_${data}.html`;
        await writeFile(join(pastaPaciente, arq), resumoHtml, 'utf8');
        arquivosSalvos.push(arq);
      }
      if (mensagemWhatsapp.trim()) {
        const arq = `${data}_WhatsApp_${slug}.txt`;
        await writeFile(join(pastaPaciente, arq), mensagemWhatsapp, 'utf8');
        arquivosSalvos.push(arq);
      }
      return { pastaPaciente, nomeDaPasta, arquivosSalvos };
    }
  };
}
