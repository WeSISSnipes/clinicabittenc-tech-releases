// Turns the long single page into a step-by-step assistant. No section id is renamed and no
// other module needs to know this exists: it only toggles `hidden` on existing top-level
// sections and intercepts in-page `#anchor` links so they switch steps instead of scrolling to
// a hidden element. Nothing here blocks navigation — every step stays reachable at any time,
// consistent with the rest of the app never blocking reading, only gating export/approval.
const STEPS = [
  { ids: ['inicio'], label: 'Pacientes' },
  { ids: ['conexoes'], label: 'Ajustes' },
  { ids: ['entrada', 'fontes'], label: 'Dados da consulta' },
  { ids: ['apoio'], label: 'Exames e documentos' },
  { ids: ['pipeline', 'rascunhos'], label: 'Resumo para conferir' },
  { ids: ['bloco'], label: 'Texto do prontuário' },
  // O "Registro do atendimento" não faz parte da rotina (o Bloco da etapa 4 é colado no sistema da
  // clínica): fica fora do caminho e só aparece no modo avançado, em Ajustes. Nada foi apagado.
  { ids: ['clinica'], label: 'Registro do atendimento', avancado: true },
  { ids: ['resumo'], label: 'Resumo ao paciente' },
  { ids: ['sessao'], label: 'Concluir e guardar' },
];
const PRIMEIRA_ETAPA = 2; // Pacientes e Ajustes vêm antes das etapas da consulta.
const CHAVE_AVANCADO = 'prontuario.avancado';

export function mountWizard() {
  const $ = id => document.getElementById(id);
  const sections = [...document.querySelectorAll('main>section[data-step]')];
  const navLinks = [...document.querySelectorAll('nav[aria-label="Etapas"] a')];
  const stepOf = id => STEPS.findIndex(step => step.ids.includes(id));
  let current = 0;

  // A preferência é só uma conveniência deste computador: se o navegador não guarda, volta ao padrão.
  const avancado = () => document.body.hasAttribute('data-avancado');
  const visivel = index => !STEPS[index].avancado || avancado();
  const vizinho = (de, sentido) => {
    let index = de + sentido;
    while (index >= 0 && index < STEPS.length && !visivel(index)) index += sentido;
    return index;
  };
  // Número mostrado ao usuário: conta só as etapas visíveis, para não haver um buraco na numeração.
  const numeroDe = index => STEPS.slice(PRIMEIRA_ETAPA, index + 1).filter((_, i) => visivel(PRIMEIRA_ETAPA + i)).length;

  function apply() {
    for (const section of sections) section.hidden = !STEPS[current].ids.includes(section.id);
    for (const link of navLinks) {
      const index = stepOf(link.getAttribute('href').slice(1));
      link.classList.toggle('active', index === current);
      // O texto do link é "N · Rótulo": só o número muda, o ícone (um <svg> à parte) fica onde está.
      const texto = index >= PRIMEIRA_ETAPA && [...link.childNodes].find(no => no.nodeType === Node.TEXT_NODE && /^\d+ · /.test(no.textContent));
      if (texto) texto.textContent = texto.textContent.replace(/^\d+/, numeroDe(index));
    }
    for (const section of sections) {
      const index = stepOf(section.id), rotulo = section.querySelector('.eyebrow');
      if (index >= PRIMEIRA_ETAPA && rotulo && /^ETAPA \d+/.test(rotulo.textContent)) rotulo.textContent = rotulo.textContent.replace(/^ETAPA \d+/, `ETAPA ${numeroDe(index)}`);
    }
    // Uma numeração só, igual à do menu: Pacientes e Ajustes não são etapas da consulta.
    const etapas = numeroDe(STEPS.length - 1);
    $('wizardProgress').textContent = current < PRIMEIRA_ETAPA ? STEPS[current].label : `Etapa ${numeroDe(current)} de ${etapas} · ${STEPS[current].label}`;
    $('wizardBack').disabled = vizinho(current, -1) < 0;
    $('wizardNext').disabled = vizinho(current, 1) >= STEPS.length;
  }

  function goTo(index, { focusId } = {}) {
    current = Math.max(0, Math.min(STEPS.length - 1, index));
    apply();
    const alvo = (focusId && $(focusId)) || sections.find(section => STEPS[current].ids.includes(section.id));
    alvo?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function goToSection(id) {
    const index = stepOf(id);
    if (index >= 0) goTo(index, { focusId: id });
  }

  // A single delegated handler covers every `#anchor` link already scattered through the page
  // (nav, cross-references inside paragraphs like "veja em Base revisada"), without touching them.
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const id = link.getAttribute('href').slice(1);
    const index = stepOf(id);
    if (index < 0) return;
    event.preventDefault();
    goTo(index, { focusId: id });
  });
  $('wizardBack').onclick = () => goTo(vizinho(current, -1));
  $('wizardNext').onclick = () => goTo(vizinho(current, 1));

  const caixa = $('modoAvancado');
  try { if (localStorage.getItem(CHAVE_AVANCADO) === '1') document.body.setAttribute('data-avancado', ''); } catch { /* sem armazenamento: fica no padrão */ }
  caixa.checked = avancado();
  caixa.onchange = () => {
    document.body.toggleAttribute('data-avancado', caixa.checked);
    try { localStorage.setItem(CHAVE_AVANCADO, caixa.checked ? '1' : '0'); } catch { /* preferência só desta sessão */ }
    apply();
  };

  apply();
  return { goTo, goToSection };
}
