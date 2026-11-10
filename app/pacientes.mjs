// Telas de Pacientes e Histórico. Separado de app.mjs, que concentrava tudo: o que este módulo
// precisa do resto do aplicativo chega explicitamente por `mountPacientes`, e as funções puras
// (datas, idade, descrição do conteúdo) ficam exportadas para teste sem navegador.

// Datas vêm do servidor como AAAA-MM-DD e são exibidas no formato do consultório. Montadas à mão, e
// não com `new Date`, para que o fuso horário nunca desloque um nascimento para o dia anterior.
export const dataBR = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';

export function idade(nascimento, hoje = new Date()) {
  if (!nascimento) return null;
  const [ano, mes, dia] = nascimento.split('-').map(Number);
  let anos = hoje.getFullYear() - ano;
  if (hoje.getMonth() + 1 < mes || (hoje.getMonth() + 1 === mes && hoje.getDate() < dia)) anos--;
  return anos;
}

export const semAcento = texto => texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export const identificacaoTexto = (paciente, hoje) => paciente.nascimento
  ? `Nascimento ${dataBR(paciente.nascimento)} · ${idade(paciente.nascimento, hoje)} anos`
  : 'Data de nascimento não registrada';

// Consultas salvas antes do índice não têm o resumo do conteúdo; dizer isso, e não "vazia".
export function descreverConteudo(consulta) {
  if (typeof consulta.itens !== 'number') return 'conteúdo não indexado (salva antes desta versão)';
  return [
    consulta.itens ? `síntese com ${consulta.itens} ${consulta.itens === 1 ? 'item' : 'itens'}` : 'sem síntese',
    consulta.mensagem && 'mensagem',
    consulta.resumo && 'resumo',
    consulta.exames && 'exames',
  ].filter(Boolean).join(' · ');
}

async function apiPacientes(caminho, corpo) {
  const resposta = await fetch(caminho, corpo ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Clinical-Request': '1' }, body: JSON.stringify(corpo) } : {});
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw Error(dados.error || 'Falha ao acessar o histórico local.');
  return dados;
}

export function mountPacientes({ $, protect, say, wizard, temSessaoAberta, reset, restoreSession, sessionPayload, aoVerificarPasta = () => {} }) {
  let pastaConfigurada = null, pastaVerificada = false;
  let pacientesCache = [];
  let pacienteAberto = null;
  const nascimentoDigitado = () => $('birthDate').value;

  async function atualizarStatusPasta() {
    try {
      const { pasta } = await apiPacientes('/api/pacientes/config');
      pastaConfigurada = pasta;
      $('patientsFolderStatus').textContent = pasta ? `Pasta atual: ${pasta}` : 'Nenhuma pasta configurada ainda. Informe um caminho acima.';
      $('patientsFolderStatus').className = pasta ? 'evidence' : 'evidence warn';
      if (pasta) $('patientsFolderPath').value = pasta;
    } catch {
      pastaConfigurada = null;
      $('patientsFolderStatus').textContent = 'Servidor local indisponível.';
      $('patientsFolderStatus').className = 'evidence warn';
    }
    $('patientsFolderAviso').hidden = Boolean(pastaConfigurada);
    // O aviso também aparece onde a consulta começa: descobrir a falta da pasta só ao clicar em guardar,
    // no fim do atendimento, é tarde demais.
    $('entradasPastaAviso').hidden = Boolean(pastaConfigurada);
    atualizarBotoes();
    pastaVerificada = true; aoVerificarPasta();
    return pastaConfigurada;
  }

  // Salvar exige os dois identificadores; o botão diz o que falta em vez de só ficar cinza.
  function atualizarBotoes() {
    const nome = $('patient').value.trim(), nascimento = nascimentoDigitado();
    const falta = !pastaConfigurada ? 'Configure a pasta do histórico em Ajustes para poder salvar.'
      : !nome && !nascimento ? 'Preencha nome e data de nascimento em Entradas para salvar no histórico.'
      : !nome ? 'Preencha o nome do paciente em Entradas para salvar no histórico.'
      : !nascimento ? 'Preencha a data de nascimento em Entradas: ela separa pessoas com o mesmo nome.' : '';
    $('saveToHistory').disabled = Boolean(falta);
    $('verHistoricoDaPessoa').disabled = !pastaConfigurada || !nome || !nascimento;
    $('saveToHistoryNota').textContent = falta;
  }
  for (const id of ['patient', 'birthDate']) for (const evento of ['input', 'change']) $(id).addEventListener(evento, atualizarBotoes);

  $('setPatientsFolder').onclick = protect(async () => {
    const caminho = $('patientsFolderPath').value.trim();
    if (!caminho) throw Error('Informe o caminho completo de uma pasta.');
    const { pasta } = await apiPacientes('/api/pacientes/config', { pasta: caminho });
    await atualizarStatusPasta(); await carregarLista();
    say(`Pasta de dados configurada: ${pasta}`);
  });
  $('saveToHistory').onclick = protect(async () => {
    const nome = $('patient').value.trim(), nascimento = nascimentoDigitado();
    if (!nome || !nascimento) throw Error('Preencha nome e data de nascimento em Entradas antes de salvar no histórico.');
    const { arquivo } = await apiPacientes('/api/pacientes/salvar', { nome, nascimento, dados: sessionPayload() });
    say(`Consulta salva no histórico de ${nome}: ${dataBR(arquivo.slice(0, 10))}.`);
    await carregarLista();
  });

  // Pacientes: todas as pessoas com histórico nesta pasta. A lista vem inteira do servidor e a busca
  // filtra aqui, para não fazer uma ida e volta a cada letra digitada.
  async function carregarLista() {
    try { const { pacientes } = await apiPacientes('/api/pacientes/listar', {}); pacientesCache = pacientes; }
    catch { pacientesCache = []; }
    renderLista();
  }
  function renderLista() {
    const lista = $('patientListInicio'); lista.replaceChildren();
    const termo = semAcento($('patientSearchInicio').value.trim());
    const filtrados = pacientesCache.filter(p => semAcento(p.nome).includes(termo));
    if (!filtrados.length) {
      const vazio = document.createElement('p'); vazio.className = 'evidence';
      vazio.textContent = !pastaConfigurada ? '' : pacientesCache.length ? 'Nenhum paciente encontrado com esse termo.' : 'Nenhum paciente salvo ainda. As consultas aparecem aqui depois de "Salvar esta consulta no histórico", no passo Sessão.';
      lista.append(vazio); return;
    }
    for (const paciente of filtrados) {
      const linha = document.createElement('article'); linha.className = paciente.legado ? 'patient-row legado' : 'patient-row';
      const dados = document.createElement('div'); dados.className = 'patient-dados';
      const nome = document.createElement('strong'); nome.className = 'patient-nome'; nome.textContent = paciente.nome;
      const ident = document.createElement('span'); ident.className = paciente.legado ? 'patient-meta warn' : 'patient-meta'; ident.textContent = identificacaoTexto(paciente);
      const consultas = document.createElement('span'); consultas.className = 'patient-meta';
      consultas.textContent = paciente.consultas ? `${paciente.consultas} ${paciente.consultas === 1 ? 'consulta' : 'consultas'} · última em ${dataBR(paciente.ultima)}` : 'Nenhuma consulta salva';
      dados.append(nome, ident, consultas);
      const acoes = document.createElement('div'); acoes.className = 'actions';
      const historicoBtn = document.createElement('button'); historicoBtn.type = 'button'; historicoBtn.className = 'secondary'; historicoBtn.textContent = 'Histórico';
      historicoBtn.onclick = protect(() => abrirHistorico(paciente.id));
      acoes.append(historicoBtn);
      if (!paciente.legado) {
        const hojeBtn = document.createElement('button'); hojeBtn.type = 'button'; hojeBtn.textContent = 'Consulta de hoje';
        hojeBtn.onclick = () => iniciarConsultaPara(paciente);
        acoes.append(hojeBtn);
      }
      linha.append(dados, acoes); lista.append(linha);
    }
  }
  $('patientSearchInicio').addEventListener('input', renderLista);

  function iniciarConsultaPara(paciente) {
    if (temSessaoAberta() && !confirm('Substituir a sessão aberta? Salve o trabalho antes.')) return;
    reset();
    if (paciente) { $('patient').value = paciente.nome; $('birthDate').value = paciente.nascimento || ''; }
    atualizarBotoes();
  }
  $('inicioNovaConsulta').onclick = () => iniciarConsultaPara(null);

  // Histórico: as consultas salvas de UMA pessoa, da mais recente para a mais antiga.
  function mostrarVista(historico) {
    $('vistaPacientes').hidden = historico; $('vistaHistorico').hidden = !historico;
    wizard.goToSection('inicio');
  }
  async function abrirHistorico(id) {
    const [{ paciente }, { consultas }] = await Promise.all([apiPacientes('/api/pacientes/paciente', { id }), apiPacientes('/api/pacientes/consultas', { id })]);
    pacienteAberto = paciente;
    $('historicoNome').textContent = paciente.nome;
    // No formato antigo, a caixa de aviso logo abaixo já diz que falta a data de nascimento.
    $('historicoIdentificacao').textContent = paciente.legado ? '' : identificacaoTexto(paciente);
    $('historicoNovaConsulta').hidden = paciente.legado;
    $('historicoLegado').hidden = !paciente.legado;
    if (paciente.legado) { $('legadoNome').value = paciente.nome; $('legadoNascimento').value = ''; }
    const lista = $('historicoConsultas'); lista.replaceChildren();
    if (!consultas.length) { const vazio = document.createElement('li'); vazio.className = 'evidence'; vazio.textContent = 'Nenhuma consulta salva.'; lista.append(vazio); }
    for (const consulta of consultas) {
      const item = document.createElement('li'); item.className = 'consulta-item';
      const quando = document.createElement('strong'); quando.textContent = dataBR(consulta.data);
      const conteudo = document.createElement('span'); conteudo.className = 'patient-meta'; conteudo.textContent = descreverConteudo(consulta);
      const abrir = document.createElement('button'); abrir.type = 'button'; abrir.className = 'secondary'; abrir.textContent = 'Abrir';
      abrir.onclick = protect(async () => {
        const { dados } = await apiPacientes('/api/pacientes/abrir', { id, arquivo: consulta.arquivo });
        if (!(await restoreSession(dados))) return;
        // Consulta salva antes da data de nascimento existir: completa a identificação com o perfil.
        if (!$('patient').value.trim()) $('patient').value = paciente.nome;
        if (!$('birthDate').value && paciente.nascimento) $('birthDate').value = paciente.nascimento;
        atualizarBotoes();
        say(`Consulta de ${dataBR(consulta.data)} reaberta a partir do histórico; originais íntegros. Confirme novamente identidade, limites e aprovações.`);
      });
      const texto = document.createElement('div'); texto.className = 'patient-dados'; texto.append(quando, conteudo);
      item.append(texto, abrir); lista.append(item);
    }
    mostrarVista(true);
  }
  $('historicoVoltar').onclick = () => { pacienteAberto = null; mostrarVista(false); carregarLista(); };
  $('historicoNovaConsulta').onclick = () => { if (pacienteAberto) iniciarConsultaPara(pacienteAberto); };
  $('legadoRegistrar').onclick = protect(async () => {
    const nome = $('legadoNome').value.trim(), nascimento = $('legadoNascimento').value;
    if (!nome || !nascimento) throw Error('Informe o nome e a data de nascimento para registrar.');
    if (!confirm(`Registrar ${nome}, nascido(a) em ${dataBR(nascimento)}? As consultas desta pasta passam a pertencer a essa identificação.`)) return;
    const { id } = await apiPacientes('/api/pacientes/registrar-nascimento', { id: pacienteAberto.id, nome, nascimento });
    say(`Data de nascimento registrada para ${nome}.`);
    await abrirHistorico(id);
  });
  $('verHistoricoDaPessoa').onclick = protect(async () => {
    const nome = $('patient').value.trim(), nascimento = nascimentoDigitado();
    const mesmaPessoa = p => p.nome === nome && p.nascimento === nascimento;
    const alvo = pacientesCache.find(mesmaPessoa) ?? (await apiPacientes('/api/pacientes/listar', {})).pacientes.find(mesmaPessoa);
    if (!alvo) throw Error(`Ainda não há consultas salvas para ${nome}, nascido(a) em ${dataBR(nascimento)}.`);
    await abrirHistorico(alvo.id);
  });

  // A lista depende de saber se há pasta configurada (a mensagem de lista vazia muda), então a pasta
  // é consultada primeiro.
  atualizarStatusPasta().then(carregarLista);

  return {
    // true/false depois de perguntar ao servidor; null enquanto ainda não se sabe.
    pastaConfigurada() { return pastaVerificada ? Boolean(pastaConfigurada) : null; },
    atualizarBotoes,
    // Uma consulta nova (ou reaberta) devolve a tela de Pacientes à lista, para quem voltar a ela
    // não encontrar aberto o histórico de outra pessoa.
    voltarParaLista() { pacienteAberto = null; $('vistaPacientes').hidden = false; $('vistaHistorico').hidden = true; },
  };
}
