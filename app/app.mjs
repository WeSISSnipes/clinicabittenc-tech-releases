import {sourceFile,binarySource,sourceText,verifySource,fromBase64,safeName,detectRegions,validateRegions,makeRecord,textareaOffset,applyPatches} from './core.mjs';
import {buildSummary,installEditor,snapshotSummary} from './summary.mjs';
import {SimulatedProvider,safeSuggestion} from './review.mjs';
import {extractPdfPages} from './pdf.mjs';
import {parseExams,parsePages,examsToProse,markAlreadyRecorded,examDateWarnings,pendingExams} from './exams.mjs';
import {parseGalileuLink,describeGalileu,parseBia,biaToProse,parseTarget,targetToProse,parseInterpretacao} from './bioimpedancia.mjs';
import {buildDraft} from './draft.mjs';
import {createDraftProvider,AI_MODES} from './ai.mjs';
import {listaDeProvedores,resolverProvedor} from './providers.mjs';
import {makeEntry,describeEntry,KINDS_CURTOS,STATES} from './sources.mjs';
import {BLOCK_SECTIONS,buildClinicalBlock,seedSections} from './bloco.mjs';
import {mountHub} from './hub.mjs';
import {mountWizard} from './wizard.mjs';
import {mountPacientes} from './pacientes.mjs';
import {mountScribe} from './scribe.mjs';
import {renderComVerMais} from './ui.mjs';
import {montarIcones} from './icons.mjs';

const $=id=>document.getElementById(id);
const blocoIds=BLOCK_SECTIONS.map(s=>`bloco_${s.key}`);
const fieldIds=[...BLOCK_SECTIONS.map(s=>`bloco_${s.key}`),'bloco_heading','patient','birthDate','date','modality','internalType','medications','evolution','identificacao','hipoteses','conduta','recordFilename','patientType','fraseconexao','pontosatencao','medicacao','exames','agendamento','frasefinal','obsobesidade','workingText','examsProse','biaProse','targetProse','interpProse','interpFonte'];
const summaryKeys=['fraseconexao','pontosatencao','medicacao','exames','agendamento','frasefinal','obsobesidade'];
const emptyState=()=>({id:crypto.randomUUID(),extras:[],catalog:[],exams:null,bia:null,target:null,interpretacao:null,biaLink:null,pendencias:[]});
let state=emptyState(), prepared=null, summaryReady=false, summaryDirty=false;
const templatePromise=fetch('/templates/resumo-template.html').then(r=>{if(!r.ok)throw Error('Modelo de resumo indisponível.');return r.text();});
const values=()=>Object.fromEntries(fieldIds.map(id=>[id,$(id).value]));
function say(message,error=false,link=null){
  const el=$('status');
  el.textContent=message;el.className=error?'error':'';
  if(link){el.append(' ');const a=document.createElement('a');a.href='#'+link.anchor;a.textContent=link.label;el.append(a);}
}
// mountHub() já chama render() (e portanto onRefresh) antes de retornar — "hub" precisa existir
// (mesmo que undefined) antes dessa primeira chamada, ou o próprio onRefresh, ao ler "hub" na
// época em que a atribuição abaixo ainda não terminou, cai numa referência antes da inicialização.
// Mesmo cuidado para "pacientes" (criado bem mais abaixo): o checklist só roda depois que ele existe.
let checklistPronto=false;
let hub;
let scribe=null;
hub=mountHub({sources:()=>({prontuario:state.html?sourceText(state.html):'',transcricao:state.transcript?sourceText(state.transcript):'',laudos:$('examsProse').value}),onStatus:say,onRefresh:()=>{atualizarFillSummaryStatus();atualizarChecklist();}});
atualizarFillSummaryStatus();
const wizard=mountWizard();
montarIcones();
function renderPipeline(){hub.refresh();}
function invalidatePipeline(){hub.refresh();}
// Enquanto uma ação está em andamento, o mesmo controle ignora novos disparos. Sem isso, dois
// cliques impacientes num botão que chama a IA viram duas chamadas pagas — o custo dobra sem
// nenhum aviso. A trava é por reentrância, e não por `disabled`, de propósito: `disabled` é
// gerenciado pela lógica do aplicativo em vários botões (copiar bloco, salvar no histórico,
// reabrir consulta) e mexer nele aqui reabriria botões que deveriam continuar bloqueados.
const emExecucao = new WeakSet();
function protect(action){return async event=>{
  const controle=event?.currentTarget;
  if(controle&&emExecucao.has(controle))return;
  const section=controle?.closest('section');
  section?.querySelector('.action-feedback')?.remove();
  const rotulo=controle?.tagName==='BUTTON'?controle.textContent:null;
  if(controle){emExecucao.add(controle);controle.setAttribute('aria-busy','true');if(rotulo!==null)controle.textContent=`${rotulo}…`;}
  try{await action(event);}catch(error){
    const message=error.message||'Falha na operação. O trabalho permanece aberto.';say(message,true);
    if(section){const notice=document.createElement('p');notice.className='action-feedback';notice.setAttribute('role','alert');notice.textContent=message;section.append(notice);notice.scrollIntoView({block:'center',behavior:'smooth'});}
  }finally{
    if(controle){emExecucao.delete(controle);controle.removeAttribute('aria-busy');if(rotulo!==null)controle.textContent=rotulo;}
  }
};}
function revokeRecord(){prepared=null;$('recordApproved').checked=false;$('recordApproved').disabled=true;$('exportRecord').disabled=true;$('changes').replaceChildren();}
function revokeSummary(){ $('summaryApproved').checked=false; $('exportSummary').disabled=true;$('printSummary').disabled=true; }
function summaryData(){return {...values(),commercialEnabled:$('commercialEnabled').checked};}
function reset(){
  state=emptyState();prepared=null;summaryReady=false;summaryDirty=false;hub.reset();
  for(const id of fieldIds) $(id).value='';
  $('pastedHtml').value='';$('pastedTranscript').value='';$('examPaste').value='';$('biaPaste').value='';$('biaLink').value='';$('targetPaste').value='';$('interpPaste').value='';$('interpFonte').value='Galileu';
  $('internalType').value='Nova consulta';$('patientType').value='Nova consulta';$('bloco_heading').value='1. Prontuário clínico';
  $('blockCode').value='';$('copyBlock').disabled=true;$('downloadBlock').disabled=true;
  // Caixas de configuração (data-config) não pertencem à consulta: "Nova consulta" as desmarcava e o
  // valor salvo só era reaplicado ao recarregar a página — depois disso a leitura de PDF pela IA
  // passava a falhar com "não aceita PDF", sem ninguém ter mudado nada.
  document.querySelectorAll('input[type=checkbox]:not([data-config])').forEach(el=>el.checked=false);
  document.querySelectorAll('input[type=file]').forEach(el=>el.value='');
  for(const id of ['safePreview','originalText','extras','suggestions','regionDetails','catalog','examReport','biaReport','biaNotice','targetReport','interpReport','pendencies','proposals','blockPreview']) $(id).replaceChildren();
  $('sourceCode').value='';$('summaryFrame').srcdoc='';$('summaryFrame').hidden=true;$('summaryApproved').disabled=true;
  revokeRecord();revokeSummary();$('regionState').textContent='Importe o HTML.';atualizarPrepareStatus();atualizarBuildSummaryStatus();
  $('nextSteps').hidden=true;document.querySelectorAll('.action-feedback').forEach(el=>el.remove());
  scribe?.limparAudio();
  renderPipeline();
  pacientes.voltarParaLista();
  pacientes.atualizarBotoes();
  wizard.goToSection('entrada');
}
// Only basic formatting tags survive; no input attributes, styles or URLs reach the live document.
function safeMarkup(html,rich=false){
  const allowed=rich?new Set(['b','strong','i','em','br','mark']):new Set(['p','b','strong','i','em','br','h1','h2','h3','ul','ol','li','section','div','span','table','tbody','tr','td','th']);
  return html.replace(/<!--[\s\S]*?-->|<![^>]*>|<[^>]*>/g, token=>{
    const m=/^<\s*(\/?)\s*([a-z0-9]+)\b[^>]*>$/i.exec(token);
    if(!m||!allowed.has(m[2].toLowerCase()))return '';
    const tag=m[2].toLowerCase();return `<${m[1]}${tag}${tag==='mark'&&!m[1]?' class="grifo"':''}>`;
  });
}
async function fileSource(file){if(!file)throw Error('Selecione um arquivo.');if(file.size>10*1024*1024)throw Error('Arquivo maior que 10 MB. Divisão ou suporte adicional precisa ser avaliado.');return sourceFile(new Uint8Array(await file.arrayBuffer()),file.name);}
function renderSources(){
  $('nextSteps').hidden=!(state.html&&state.transcript);
  atualizarBuildSummaryStatus();
  if(state.html){const html=sourceText(state.html);$('sourceCode').value=html;$('safePreview').innerHTML=safeMarkup(html);renderRegions();}
  if(state.transcript){$('originalText').textContent=sourceText(state.transcript);}
  $('extras').replaceChildren();for(const extra of state.extras){const block=document.createElement('details');const title=document.createElement('summary');title.textContent=extra.name;const pre=document.createElement('pre');pre.textContent=sourceText(extra);block.append(title,pre);$('extras').append(block);}
  renderCatalog();renderPipeline();
}
function renderCatalog(){
  const box=$('catalog');box.replaceChildren();
  if(!state.catalog.length){const empty=document.createElement('p');empty.textContent='Nenhuma fonte registrada ainda.';box.append(empty);return;}
  // Só apresentação: tipo, nome e estado à vista; data e método numa linha secundária; a frase
  // completa (describeEntry) continua disponível ao pousar o mouse.
  const span=(classe,texto)=>{const el=document.createElement('span');el.className=classe;el.textContent=texto;return el;};
  for(const entry of state.catalog){
    const row=document.createElement('div');row.className='catalog-row';row.title=describeEntry(entry);
    const principal=document.createElement('div');principal.className='cat-principal';
    principal.append(span('cat-tipo',KINDS_CURTOS[entry.kind]||entry.kind),span('cat-nome',entry.name),span('cat-estado est-'+entry.state,STATES[entry.state]));
    row.append(principal,span('cat-meta',`${entry.date||'sem data informada'} · ${entry.method||'método não informado'}`));
    box.append(row);
  }
}
function catalogPut(entry){
  const index=state.catalog.findIndex(item=>item.kind===entry.kind&&item.name===entry.name);
  if(index>=0)state.catalog[index]={...state.catalog[index],...entry,id:state.catalog[index].id};else state.catalog.push(entry);
  renderCatalog();
}
// O prontuário real vem do sistema da clínica sem marcadores, e delimitar regiões à mão a cada
// consulta não é razoável. Sem a entrada do dia delimitada, o prontuário inteiro vai como contexto:
// isso é leitura, nunca alvo de gravação — exportar continua exigindo delimitação explícita.
function prontuarioTexto(){
  if(!state.html)return {texto:'',delimitado:false};
  const atual=currentEntryText();
  if(atual)return {texto:atual,delimitado:true};
  const doc=new DOMParser().parseFromString(sourceText(state.html),'text/html');
  return {texto:(doc.body?.textContent||'').replace(/\s+/g,' ').trim(),delimitado:false};
}
function currentEntryText(){
  if(!state.html||!state.regions?.current)return '';
  const html=sourceText(state.html);
  return html.slice(state.regions.current.start,state.regions.current.end).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
}
function renderRegions(){
  const mode=state.regions?.current?'A entrada do dia foi localizada no HTML. Ela será substituída pela versão revisada; nenhuma evolução será acrescentada.'
    :Number.isInteger(state.regions?.insertion)?'Nenhuma entrada do dia foi localizada. A versão revisada será gravada no ponto de inserção marcado e passará a ser a entrada do dia.'
    :'O HTML foi recebido, mas seus campos não foram reconhecidos. Marque abaixo a evolução do dia já escrita ou, se ela não existir, o ponto de inserção.';
  $('regionState').textContent=mode;
  $('regionDetails').textContent=JSON.stringify(state.regions||{},null,2);
  if(!state.regions)$('boundaries').open=true;
  atualizarPrepareStatus();
}
// Antes, "Preparar conferência do HTML" ficava sempre clicável e só avisava depois do clique que a
// evolução do dia não tinha sido delimitada — quem chegasse a este passo sem abrir "Delimitar e
// conferir regiões" via um erro sem contexto, sem saber que precisava marcar algo antes. Reaproveita
// a própria validação de makeRecord (validateRegions), sem side effect, para travar o botão e
// escrever o motivo ao lado — o mesmo padrão já usado em "Salvar esta consulta no histórico".
function atualizarPrepareStatus(){
  let motivo='';
  try{
    if(!state.html||!state.transcript)throw Error('Importe as duas entradas em "1 · Entradas" antes.');
    validateRegions(sourceText(state.html),state.regions);
  }catch(error){motivo=error.message;}
  $('prepare').disabled=Boolean(motivo);
  $('prepareNota').textContent=motivo;
}
// Mesmo padrão do "prepare" acima: "Montar resumo para editar e grifar" ficava sempre clicável e só
// avisava depois do clique que faltava preencher algum campo — quem chegasse à Etapa 6 sem preencher
// tudo via um erro sem contexto. validateSummaryFields() é a mesma validação usada no clique real,
// reaproveitada aqui sem o side effect de montar o resumo.
// Lista TODOS os impedimentos de uma vez, não só o primeiro: com "Confirme pessoa e data." sozinho,
// a profissional resolvia isso, voltava, e só então descobria o próximo (ex.: texto comercial
// marcado sem texto). Reabrir uma sessão salva desmarca a confirmação de identidade de propósito,
// então quem reabre uma sessão cai neste caso toda vez — daí o "onde resolver" em cada item.
const NOMES_DOS_CAMPOS_DO_RESUMO={fraseconexao:'Abertura',pontosatencao:'Pontos que merecem atenção',medicacao:'Medicação',exames:'Exames solicitados',agendamento:'Próximo passo / agendamento',frasefinal:'Encerramento'};
function problemasDoResumo(){
  const problemas=[];
  if(!state.html||!state.transcript)problemas.push({texto:'Importe as duas entradas.',entradas:true});
  else{
    if(!$('modality').value)problemas.push({texto:'Confirme a modalidade.',entradas:true});
    if(!$('patient').value.trim())problemas.push({texto:'Preencha o nome da pessoa.',entradas:true});
    if(!$('date').value)problemas.push({texto:'Preencha a data da consulta.',entradas:true});
    if(!$('identityConfirmed').checked)problemas.push({texto:'Marque "Conferi que as duas entradas pertencem à mesma pessoa…".',entradas:true});
  }
  const vazios=Object.keys(NOMES_DOS_CAMPOS_DO_RESUMO).filter(k=>!$(k).value.trim());
  if(vazios.length)problemas.push({texto:`Preencha ${vazios.map(k=>NOMES_DOS_CAMPOS_DO_RESUMO[k]).join(', ')}, sem presumir negativas clínicas.`});
  if($('commercialEnabled').checked){
    if($('internalType').value!=='Primeira consulta')problemas.push({texto:'"Texto comercial opcional" está marcado, mas o tipo da consulta em "1 · Entradas" não é "Primeira consulta" — desmarque o texto comercial ou corrija o tipo.',entradas:true});
    if(!$('obsobesidade').value.trim())problemas.push({texto:'"Texto comercial opcional" está marcado sem o texto aprovado — preencha ou desmarque.',acao:{rotulo:'Desmarcar texto comercial',executar:()=>{$('commercialEnabled').checked=false;$('commercialEnabled').dispatchEvent(new Event('input',{bubbles:true}));}}});
  }
  const comRetorno=summaryKeys.filter(k=>/\bretorno\b/i.test($(k).value)).map(k=>NOMES_DOS_CAMPOS_DO_RESUMO[k]||'Texto comercial');
  if(comRetorno.length)problemas.push({texto:`Use a nomenclatura aprovada ao paciente, sem “retorno” — troque por “consulta” em: ${comRetorno.join(', ')}.`});
  return problemas;
}
function validateSummaryFields(){
  const problemas=problemasDoResumo();
  if(problemas.length)throw Error(problemas.map(p=>p.texto).join(' '));
}
function atualizarBuildSummaryStatus(){
  const problemas=problemasDoResumo(),nota=$('buildSummaryNota');
  $('buildSummary').disabled=Boolean(problemas.length);
  nota.replaceChildren();
  if(!problemas.length)return;
  nota.append(problemas.map(p=>p.texto).join(' '));
  if(problemas.some(p=>p.entradas)){nota.append(' ');const a=document.createElement('a');a.href='#entrada';a.textContent='Ir para Entradas →';nota.append(a);}
  for(const {acao} of problemas.filter(p=>p.acao)){nota.append(' ');const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=acao.rotulo;b.onclick=acao.executar;nota.append(b);}
}
// "Preencher com IA" depende só da base aprovada em "3 · Base revisada" (hub.baseAprovada()), não
// das validações de validateSummaryFields() acima — o objetivo dele é justamente preencher os
// campos que ainda faltam, então travá-lo pelos mesmos campos vazios seria contraditório.
// Primeira execução numa máquina nova: sem chave e sem pasta, o app abria em Pacientes sem dizer o
// que fazer primeiro (seis telas e nove ações até a primeira síntese, sem nenhuma pista). O quadro
// só aparece enquanto falta a chave ou a pasta, e some sozinho quando as duas estão prontas.
function atualizarChecklist(){
  if(!checklistPronto||!hub)return;
  const chave=hub.chaveConfigurada(),pasta=pacientes.pastaConfigurada(),caixa=$('primeirosPassos');
  if(chave!==false&&pasta!==false){caixa.hidden=true;return;}
  const itens=[
    [chave===true,'Colar a chave da IA'],
    [pasta===true,'Escolher a pasta onde as consultas serão guardadas'],
    [$('hubConsent').checked,'Marcar a permissão para usar a IA nesta consulta'],
  ];
  caixa.replaceChildren();
  const titulo=document.createElement('strong');titulo.textContent='Antes da primeira consulta — três passos em Ajustes';
  const lista=document.createElement('ul');
  for(const [feito,texto] of itens){const li=document.createElement('li');li.textContent=`${feito?'✓':'○'} ${texto}`;lista.append(li);}
  const link=document.createElement('a');link.href='#conexoes';link.textContent='Ir para Ajustes →';
  caixa.append(titulo,lista,link);caixa.hidden=false;
}
function atualizarFillSummaryStatus(){
  if(!hub)return; // primeira chamada, disparada de dentro do próprio mountHub(), antes de "hub" existir
  const motivo=hub.baseAprovada()?'':'Confira o resumo em "3 · Resumo para conferir" antes de preencher com IA.';
  $('fillSummaryAI').disabled=Boolean(motivo);
  $('fillSummaryAINota').textContent=motivo;
}
$('fillSummaryAI').onclick=protect(async()=>{
  const preenchidos=summaryKeys.filter(k=>k!=='obsobesidade').filter(k=>$(k).value.trim());
  if(preenchidos.length&&!confirm('Isso substitui o texto já escrito nestes campos: '+preenchidos.join(', ')+'. Continuar?'))return;
  say('Preenchendo com IA a partir da base aprovada… (pode levar um pouco)');
  const campos=await hub.deliverRaw('resumoConsulta');
  for(const campo of ['fraseconexao','pontosatencao','medicacao','exames','agendamento','frasefinal'])$(campo).value=campos[campo];
  revokeSummary();atualizarBuildSummaryStatus();
  if(summaryReady){summaryDirty=true;$('summaryApproved').disabled=true;}
  say('Campos preenchidos pela IA a partir da base aprovada. Revise cada um antes de montar o resumo.');
});
// HTML e transcrição são independentes: aplicar um nunca depende do outro já estar preenchido,
// seja por arquivo ou por texto colado. Só substituir um original já aplicado pede confirmação
// e reinicia a consulta — preencher um campo pela primeira vez nunca mexe no outro.
async function aplicarOriginal(key,source,metodo){
  if(state[key]&&!confirm('Substituir esta entrada inicia outra consulta e limpa os rascunhos e as demais entradas. Salve a sessão antes. Continuar?'))return false;
  if(state[key])reset();
  state[key]=source;
  catalogPut(makeEntry({kind:key==='html'?'prontuario':'transcricao',name:source.name,sha256:source.sha256,date:$('date').value,method:metodo,state:'lido'}));
  if(key==='html')state.regions=detectRegions(sourceText(source));else $('workingText').value=sourceText(source);
  $('identityConfirmed').checked=false;$('regionsConfirmed').checked=false;revokeRecord();revokeSummary();renderSources();
  return true;
}
for(const [id,key] of [['htmlFile','html'],['textFile','transcript']]) $(id).onchange=protect(async e=>{
  const source=await fileSource(e.target.files[0]);
  if(await aplicarOriginal(key,source,key==='html'?'documento recebido':'transcrição da conversa'))say('Original carregado sem alteração.');
});
$('extraFile').onchange=protect(async e=>{state.extras.push(await fileSource(e.target.files[0]));renderSources();say('Referência adicionada separadamente, sem mesclagem.');});
for(const [botaoId,campoId,key,nomeArquivo] of [['useHtmlPasted','pastedHtml','html','html-colado.html'],['useTranscriptPasted','pastedTranscript','transcript','texto-colado.txt']]) $(botaoId).onclick=protect(async()=>{
  const texto=$(campoId).value;
  if(!texto.trim())throw Error(`Cole ${key==='html'?'o HTML':'a transcrição'} antes de confirmar.`);
  const bytes=new TextEncoder().encode(texto);
  if(bytes.length>10*1024*1024)throw Error('Texto maior que 10 MB. Use uma entrada menor.');
  const source=await sourceFile(bytes,nomeArquivo);
  if(!(await aplicarOriginal(key,source,'texto colado')))return;
  $(campoId).value='';
  say(`${key==='html'?'HTML do prontuário colado e preservado':'Transcrição colada e preservada'} como original. ${key==='html'?'Cole ou anexe também a transcrição, se ainda não fez.':'Cole ou anexe também o HTML do prontuário, se ainda não fez.'}`);
});
$('demo').onclick=protect(async()=>{
  if(state.html&&!confirm('Limpar esta sessão e abrir o exemplo fictício?'))return;
  const sources=await Promise.all(['/examples/consulta-ficticia.html','/examples/fala-ficticia.txt'].map(async url=>{const r=await fetch(url);if(!r.ok)throw Error('Exemplo indisponível.');return sourceFile(new Uint8Array(await r.arrayBuffer()),url.split('/').pop());}));
  reset();[state.html,state.transcript]=sources;state.regions=detectRegions(sourceText(state.html));$('workingText').value=sourceText(state.transcript);$('patient').value='Pessoa Exemplo A';$('date').value='2026-09-13';$('modality').value='Avulso';
  catalogPut(makeEntry({kind:'prontuario',name:state.html.name,sha256:state.html.sha256,date:'2026-09-13',method:'exemplo fictício',state:'lido'}));
  catalogPut(makeEntry({kind:'transcricao',name:state.transcript.name,sha256:state.transcript.sha256,date:'2026-09-13',method:'exemplo fictício',state:'lido'}));
  renderSources();say('Exemplo inteiramente fictício carregado. A entrada do dia já existe no HTML e será complementada, não duplicada.');
});
for(const button of document.querySelectorAll('[data-region]'))button.onclick=protect(()=>{
  if(!state.html)throw Error('Importe o HTML.');const source=$('sourceCode'),original=sourceText(state.html),start=textareaOffset(original,source.selectionStart),end=textareaOffset(original,source.selectionEnd);
  state.regions||={};const name=button.dataset.region;
  if(name==='insertion'){
    if(start!==end)throw Error('Posicione apenas o cursor no ponto de inserção.');
    if(state.regions.current&&!confirm('A evolução atual já está marcada. Trocar para inserção grava uma entrada nova em vez de atualizar a existente. Continuar?'))return;
    delete state.regions.current;state.regions.insertion=start;delete state.regions.insertionMarker;
  } else {
    if(start===end)throw Error('Selecione o conteúdo da região no código.');
    if(name==='current'){
      if(Number.isInteger(state.regions.insertion)&&!confirm('Havia um ponto de inserção marcado. Trocar para evolução atual substitui a entrada do dia já escrita. Continuar?'))return;
      delete state.regions.insertion;delete state.regions.insertionMarker;
    }
    state.regions[name]={start,end};
  }
  $('regionsConfirmed').checked=false;revokeRecord();renderRegions();
});
const extractionFields={examsProse:'examsApproved',biaProse:'biaApproved',targetProse:'targetApproved',interpProse:'interpApproved'};
const approvalIds=Object.values(extractionFields);
for(const id of [...fieldIds,'identityConfirmed','regionsConfirmed','commercialEnabled',...approvalIds])$(id).addEventListener('input',()=>{
  if(id==='workingText'){$('reviewApproved').checked=false;$('reviewState').textContent='Cópia alterada: compare novamente com o original.';return;}
  if(extractionFields[id]){$(extractionFields[id]).checked=false;revokeRecord();invalidatePipeline();return;}
  if(['patient','date','modality','internalType','medications','evolution','identificacao','hipoteses','conduta','identityConfirmed','regionsConfirmed','interpFonte',...approvalIds].includes(id))revokeRecord();
  if([...summaryKeys,'patient','date','patientType','internalType','commercialEnabled','identityConfirmed'].includes(id)){
    revokeSummary();
    if(summaryReady&&id!=='identityConfirmed'){summaryDirty=true;$('summaryApproved').disabled=true;say('Campos do resumo alterados. Monte novamente para incorporar os ajustes; as edições anteriores permanecem visíveis e na sessão até a substituição.');}
  }
  if([...summaryKeys,'patient','date','identityConfirmed','commercialEnabled','internalType'].includes(id))atualizarBuildSummaryStatus();
});
$('reviewApproved').onchange=()=>{$('reviewState').textContent=$('reviewApproved').checked?'Cópia aprovada como referência. Evolução e documentos ainda exigem elaboração manual.':'Use o original até aprovar uma cópia.';};
$('simulate').onclick=protect(async()=>{
  if(!state.transcript)throw Error('Importe a transcrição.');const original=sourceText(state.transcript),result=await new SimulatedProvider().suggest(original);
  $('suggestions').replaceChildren();let accepted=[];
  for(const suggestion of result.suggestions){
    const row=document.createElement('div');row.className='suggestion';const text=document.createElement('pre');text.textContent=`Original: ${JSON.stringify(suggestion.before)}\nSugestão: ${JSON.stringify(suggestion.after)}\n${suggestion.reason}`;row.append(text);
    const button=document.createElement('button');button.textContent='Aceitar esta sugestão';button.disabled=!safeSuggestion(original,suggestion);
    button.onclick=()=>{accepted.push({...suggestion,text:suggestion.after});$('workingText').value=applyPatches(original,accepted);$('reviewApproved').checked=false;button.disabled=true;};row.append(button);$('suggestions').append(row);
  }
  const note=document.createElement('p');note.textContent=result.doubts.join(' ');$('suggestions').append(note);
});
function reportList(target,title,lines,tone='',{max=8}={}){
  const box=document.createElement('div');box.className='report '+tone;
  const head=document.createElement('h4');head.textContent=lines.length>max?`${title} (${lines.length})`:title;box.append(head);
  const list=document.createElement('ul');
  for(const line of lines.slice(0,max)){const li=document.createElement('li');li.textContent=line;list.append(li);}
  box.append(list);
  if(lines.length>max){
    const resto=document.createElement('ul');resto.hidden=true;
    for(const line of lines.slice(max)){const li=document.createElement('li');li.textContent=line;resto.append(li);}
    box.append(resto);
    const restante=lines.length-max;
    const toggle=document.createElement('button');toggle.type='button';toggle.className='secondary';
    toggle.textContent=`Mostrar mais ${restante}`;
    toggle.onclick=()=>{const abrir=resto.hidden;resto.hidden=!abrir;toggle.textContent=abrir?'Mostrar menos':`Mostrar mais ${restante}`;};
    box.append(toggle);
  }
  target.append(box);
}
// Um laudo com muitas páginas repete a mesma linha de cabeçalho/rodapé em cada uma. Sem isso, um
// documento de 24 páginas gerava até 24 pendências idênticas para a mesma linha de letreiro.
function agruparRepeticoes(itens){
  const grupos=new Map();
  for(const item of itens){
    const chave=item.bruto+'|'+item.motivo;
    const existente=grupos.get(chave);
    if(existente)existente.paginas.push(item.locator.page);
    else grupos.set(chave,{...item,paginas:[item.locator.page]});
  }
  return [...grupos.values()];
}
function renderExtraction(target,{meta,items,avisos,problemas,origem}){
  target.replaceChildren();
  const usable=items.filter(i=>i.confianca!=='baixa'&&!i.jaRegistrado);
  const repetidos=items.filter(i=>i.jaRegistrado);
  const pendentes=agruparRepeticoes(pendingExams(items));
  reportList(target,`Origem: ${origem}`,[
    `Data informada no documento: ${meta.data||'não informada'}`,
    `Laboratório/origem: ${meta.laboratorio||'não informado'}`,
    `Método: ${meta.metodo||'não informado'}`,
    `Pessoa no documento: ${meta.paciente||'não informada'}`,
    `${usable.length} resultado(s) lidos, ${pendentes.reduce((n,i)=>n+i.paginas.length,0)} pendente(s), ${repetidos.length} já registrado(s) no prontuário.`,
  ]);
  if(problemas?.length)reportList(target,'Limites da leitura',problemas,'warn');
  if(avisos?.length)reportList(target,'Conferir antes de incorporar',avisos,'warn');
  if(pendentes.length)reportList(target,'Não lidos com segurança — informe manualmente',pendentes.map(i=>{
    const onde=i.paginas.length>1?`repetido em ${i.paginas.length} páginas (ex.: página ${i.paginas[0]})`:`Página ${i.paginas[0]}, linha ${i.locator.line}`;
    return `${onde}: “${i.bruto}” — ${i.motivo}`;
  }),'warn');
  if(repetidos.length)reportList(target,'Já constam no prontuário e não serão repetidos',repetidos.map(i=>`${i.analito} ${i.valor} ${i.unidade||''}`.trim()));
  if(usable.length)reportList(target,'Lidos, com página e linha de origem',usable.map(i=>`${i.analito}: ${i.valor} ${i.unidade||''} ${i.referencia?`(referência ${i.referencia})`:''} — página ${i.locator.page}, linha ${i.locator.line}`.replace(/\s+/g,' ').trim()));
}
async function readExamText(pages,origem,nome){
  const parsed=parsePages(pages);
  const items=markAlreadyRecorded(parsed.items,state.html?sourceText(state.html):'');
  const avisos=examDateWarnings(parsed.meta,$('date').value);
  if($('patient').value&&parsed.meta.paciente&&!parsed.meta.paciente.toLowerCase().includes($('patient').value.trim().split(/\s+/)[0].toLowerCase()))
    avisos.push(`O documento está em nome de “${parsed.meta.paciente}”, diferente da identificação confirmada. Não incorpore resultados de outra pessoa.`);
  state.examTextoLido=pages.join(String.fromCharCode(10));
  invalidatePipeline();
  return {items,meta:parsed.meta,avisos,origem};
}
// A pessoa pode ter vários PDFs de exames diferentes (laboratórios, datas). Cada leitura nova
// é ACRESCENTADA ao que já está em "Exames extraídos" — nunca substitui nem apaga o texto de uma
// leitura anterior, mesmo que essa leitura já tenha sido editada à mão. `state.exams.items`
// acompanha da mesma forma, para as pendências e o preenchimento do bloco também considerarem
// todos os documentos já lidos, não só o último.
function addExamResult(items,meta){
  const prose=examsToProse(items,meta);
  if(prose){
    const atual=$('examsProse').value.trim();
    $('examsProse').value=atual?`${atual}\n\n${prose}`:prose;
  }
  state.exams={items:[...(state.exams?.items||[]),...items],meta};
  $('examsApproved').checked=false;
}
async function processarExamePdf(file){
  if(file.size>25*1024*1024)throw Error(`${file.name}: PDF maior que 25 MB.`);
  const bytes=new Uint8Array(await file.arrayBuffer());
  state.examSource=await binarySource(bytes,file.name,{kind:'exame'});
  const read=await extractPdfPages(bytes);
  if(read.legivel){
    const result=await readExamText(read.pages,`PDF ${file.name} (${read.declaredPages||read.pages.length} página(s) declarada(s))`,file.name);
    renderExtraction($('examReport'),{...result,problemas:read.problems});
    catalogPut(makeEntry({kind:'exame',name:file.name,sha256:state.examSource.sha256,date:result.meta.data||'',method:result.meta.metodo||'camada de texto extraída localmente com PDF.js',state:pendingExams(result.items).length?'parcial':'lido'}));
    addExamResult(result.items,result.meta);
    return true;
  }
  // Leitura local sem camada de texto útil — documento digitalizado, ou PDF.js não encontrou nada
  // aproveitável. Se um provedor com leitura visual já está configurado e autorizado para esta
  // consulta, a esteira continua sozinha em vez de parar pedindo uma ação manual a mais; senão, a
  // mensagem diz exatamente o próximo clique. O texto já lido de outros PDFs desta mesma consulta
  // nunca é apagado por causa de um documento que falhou.
  catalogPut(makeEntry({kind:'exame',name:file.name,sha256:state.examSource.sha256,method:'leitura local sem camada de texto útil',state:'bloqueado'}));
  const chaveEAutorizacaoPresentes=$('aiConsent').checked&&$('aiKey').value.trim();
  if(chaveEAutorizacaoPresentes){
    let provedor;try{provedor=createDraftProvider(configDaIA());}catch{provedor=null;}
    if(provedor?.podePdf){
      say('Leitura local sem resultado. Enviando automaticamente para leitura visual, como configurado em "Redigir com IA".');
      await lerExamesComIA({pdfBase64:state.examSource.base64});
      return true;
    }
  }
  throw Error(`${file.name}: este PDF não tem texto selecionável (é uma foto ou uma digitalização). Para a IA lê-lo sem você digitar: em Ajustes, configure a chave em "Redigir com IA", escolha um provedor que aceite PDF e marque a autorização — a próxima leitura passa a usar a IA sozinha. Também dá para colar o texto do laudo ao lado.`);
}
$('examFile').onchange=protect(async e=>{
  const files=[...e.target.files];if(!files.length)return;
  const falhas=[];
  for(const file of files){
    try{await processarExamePdf(file);}
    catch(error){falhas.push(error.message);}
  }
  if(falhas.length===files.length)throw Error(falhas.join(' '));
  if(falhas.length)say(`${files.length-falhas.length} de ${files.length} documento(s) lido(s). ${falhas.join(' ')}`,true);
  else say(files.length>1?`${files.length} documentos de exames lidos localmente. Confira cada linha contra os originais antes de aprovar.`:'Exames lidos localmente. Confira cada linha contra o documento original antes de aprovar.');
});

$('readExams').onclick=protect(async()=>{
  const text=$('examPaste').value.trim();if(!text)throw Error('Cole o texto do laudo ou selecione um PDF.');
  const result=await readExamText([text],'texto colado');
  renderExtraction($('examReport'),result);
  catalogPut(makeEntry({kind:'exame',name:'laudo colado',date:result.meta.data||'',method:result.meta.metodo||'texto colado',state:pendingExams(result.items).length?'parcial':'lido'}));
  addExamResult(result.items,result.meta);
  say('Exames lidos do texto colado. Confira cada linha antes de aprovar.');
});
$('demoExams').onclick=protect(async()=>{const r=await fetch('/examples/exames-ficticios.txt');if(!r.ok)throw Error('Exemplo indisponível.');$('examPaste').value=await r.text();say('Exames fictícios carregados no campo. Clique em “Ler documento de exames”.');});
$('demoBia').onclick=protect(async()=>{const r=await fetch('/examples/bioimpedancia-ficticia.txt');if(!r.ok)throw Error('Exemplo indisponível.');$('biaPaste').value=await r.text();say('Relatório fictício carregado no campo. Clique em “Ler dados de bioimpedância”.');});
// O aviso fica ao lado do campo: a barra de status no topo da página passa desapercebida.
function renderLinkNotice(){
  const raw=$('biaLink').value.trim();
  $('biaNotice').replaceChildren();
  if(!raw){state.biaLink=null;return;}
  try{
    state.biaLink=parseGalileuLink(raw);
    reportList($('biaNotice'),`Endereço reconhecido: ${describeGalileu(state.biaLink)}`,[
      'O aplicativo não baixa o relatório. Ele não acessa a internet, e as condições de acesso ao site não foram verificadas.',
      'Para trazer os dados: abra o relatório no navegador e cole os valores no campo ao lado, ou anexe o PDF exportado em “Exames extraídos”.',
      'O endereço fica somente nesta sessão privada, nunca em documento, log ou repositório.',
    ],'warn');
  }catch(error){
    state.biaLink=null;
    reportList($('biaNotice'),'Endereço não aceito',[error.message],'warn');
  }
}
for(const evento of ['change','input'])$('biaLink').addEventListener(evento,renderLinkNotice);
// Cada documento do serviço de bioimpedância entra por um campo próprio: o tipo é declarado, nunca
// adivinhado pelo conteúdo do arquivo.
async function pdfText(input,rotulo){
  const file=input.files?.[0];
  if(!file)return null;
  if(file.size>25*1024*1024)throw Error('PDF maior que 25 MB.');
  const bytes=new Uint8Array(await file.arrayBuffer());
  const read=await extractPdfPages(bytes);
  const source=await binarySource(bytes,file.name,{kind:rotulo});
  if(!read.legivel)throw Error(`${file.name}: ${read.problems.join(' ')}`);
  return {texto:read.pages.join('\n'),problemas:read.problems,nome:file.name,source};
}
$('readTarget').onclick=protect(async()=>{
  const lido=await pdfText($('targetFile'),'bioimpedancia');
  state.targetSource=lido?.source||null;
  const text=lido?lido.texto:$('targetPaste').value.trim();
  if(!text)throw Error('Anexe o PDF de evolução/meta ou cole os dados.');
  const parsed=parseTarget(text,{consultaDate:$('date').value});
  state.target=parsed;
  $('targetReport').replaceChildren();
  reportList($('targetReport'),`Origem: ${lido?`PDF ${lido.nome}`:'texto colado'}`,[
    `${parsed.serie.length} medida(s) com data reconhecida(s).`,
    `${parsed.metas.length} meta(s) reconhecida(s).`,
    `Pessoa no documento: ${parsed.meta.paciente||'não informada'}`,
  ]);
  if(lido?.problemas?.length)reportList($('targetReport'),'Limites da leitura',lido.problemas,'warn');
  if(parsed.avisos.length)reportList($('targetReport'),'Conferir antes de incorporar',parsed.avisos,'warn');
  if(parsed.pendencias.length)reportList($('targetReport'),'Não lidos com segurança — informe manualmente',parsed.pendencias.map(p=>`Linha ${p.locator.line}: “${p.bruto}” — ${p.motivo}`),'warn');
  if(parsed.serie.length)reportList($('targetReport'),'Série lida, com linha de origem',parsed.serie.map(p=>`${p.data}: ${p.medidas.map(m=>`${m.valor} ${m.unidade}`).join(', ')} — linha ${p.locator.line}`));
  catalogPut(makeEntry({kind:'bioimpedancia',name:lido?lido.nome:'evolução/meta colada',sha256:lido?.source.sha256??null,date:parsed.serie.at(-1)?.data||'',method:parsed.meta.metodo||'relatório de evolução',state:parsed.pendencias.length?'parcial':'lido'}));
  $('targetProse').value=targetToProse(parsed.serie,parsed.metas);$('targetApproved').checked=false;
  // A tabela de metas e os gráficos costumam ser só desenho: a leitura local "lê" zero e parece
  // completa. Com PDF anexado, provedor com PDF, chave e autorização, a leitura visual segue sozinha
  // (o mesmo caminho da bioimpedância e dos exames escaneados); senão a mensagem diz o que falta.
  if(parsed.serie.length||parsed.metas.length||!state.targetSource?.base64){
    say('Evolução e meta lidas. Confira datas e valores contra o documento.');
    return;
  }
  let provedor=null;
  if($('aiConsent').checked&&$('aiKey').value.trim()){try{provedor=createDraftProvider(configDaIA());}catch{provedor=null;}}
  if(!provedor?.podePdf){
    say('Leitura local feita, mas ela não enxerga desenhos: a tabela de metas e os gráficos ficaram de fora. Para lê-los automaticamente, marque a autorização em "Redigir com IA" (com chave e um provedor que aceite PDF) e leia de novo — ou use "Pedir para a IA ler este PDF".',false,{anchor:'conexoes',label:'Ir para Ajustes →'});
    return;
  }
  say('A leitura local não encontrou metas nem série (a tabela e os gráficos são desenho). Enviando o PDF para leitura visual, como configurado em "Redigir com IA".');
  try{await lerEvolucaoComIA({pdfBase64:state.targetSource.base64});}
  catch(error){say(`A leitura local ficou salva, mas a leitura visual falhou: ${error.message} Tente de novo com "Pedir para a IA ler este PDF".`,true);}
});
$('readInterp').onclick=protect(async()=>{
  const lido=await pdfText($('interpFile'),'bioimpedancia');
  const text=lido?lido.texto:$('interpPaste').value.trim();
  if(!text)throw Error('Anexe o PDF da interpretação ou cole o texto.');
  const parsed=parseInterpretacao(text);
  state.interpretacao=parsed;
  $('interpReport').replaceChildren();
  reportList($('interpReport'),`Origem: ${lido?`PDF ${lido.nome}`:'texto colado'}`,[`${parsed.paragrafos.length} parágrafo(s) lidos. O texto não foi resumido nem reescrito.`]);
  reportList($('interpReport'),'Antes de aprovar',parsed.avisos,'warn');
  const bloco=document.createElement('div');bloco.className='report';
  const titulo=document.createElement('h4');titulo.textContent='Texto lido, para conferência';
  const corpo=document.createElement('pre');corpo.textContent=parsed.paragrafos.join('\n\n');
  bloco.append(titulo,corpo);$('interpReport').append(bloco);
  catalogPut(makeEntry({kind:'bioimpedancia',name:lido?lido.nome:'interpretação colada',sha256:lido?.source.sha256??null,method:'interpretação de terceiro',state:'parcial',note:'Leitura do serviço, não da profissional'}));
  $('interpApproved').checked=false;
  say('Interpretação carregada. Nada dela entra no prontuário: copie para o campo abaixo só o que você conferiu e quer registrar.');
});
$('readBia').onclick=protect(async()=>{
  const lido=await pdfText($('biaFile'),'bioimpedancia');
  state.biaSource=lido?.source||null;
  const text=lido?lido.texto:$('biaPaste').value.trim();
  if(!text)throw Error('Anexe o PDF do relatório ou cole os dados de bioimpedância.');
  const parsed=parseBia(text,{consultaDate:$('date').value});
  const items=markAlreadyRecorded(parsed.items,currentEntryText());
  state.bia={...parsed,items};
  renderExtraction($('biaReport'),{meta:parsed.meta,items,avisos:parsed.avisos,origem:state.biaLink?describeGalileu(state.biaLink):'dados colados'});
  catalogPut(makeEntry({kind:'bioimpedancia',name:state.biaLink?describeGalileu(state.biaLink):'relatório colado',date:parsed.meta.data||'',method:parsed.meta.metodo||'não informado',state:pendingExams(items).length?'parcial':'lido',link:state.biaLink}));
  $('biaProse').value=biaToProse(items,parsed.meta);$('biaApproved').checked=false;
  // Massa gorda, % de gordura, massa magra e massa muscular quase sempre são medidores desenhados,
  // que a leitura local não enxerga. Sem eles a leitura local ficava parecendo completa e a pessoa
  // tinha que descobrir sozinha o botão da IA. Com PDF anexado, provedor com PDF, chave e
  // autorização, a leitura visual segue sozinha — o mesmo caminho já usado para exames escaneados.
  const composicao=items.some(item=>item.confianca!=='baixa'&&/gordura|massa\s+(?:magra|muscular)/i.test(item.analito||''));
  if(composicao||!state.biaSource?.base64){
    say('Bioimpedância lida. Confirme identidade, data e método; não compare com densitometria.');
    return;
  }
  let provedor=null;
  if($('aiConsent').checked&&$('aiKey').value.trim()){try{provedor=createDraftProvider(configDaIA());}catch{provedor=null;}}
  if(!provedor?.podePdf){
    say('Leitura local feita, mas ela não enxerga desenhos: gordura, massa magra e massa muscular ficaram de fora. Para lê-las automaticamente, marque a autorização em "Redigir com IA" (com chave e um provedor que aceite PDF) e leia de novo — ou use "Pedir para a IA ler este PDF".',false,{anchor:'conexoes',label:'Ir para Ajustes →'});
    return;
  }
  say('A leitura local não encontrou gordura nem massa muscular (só aparecem como desenho). Enviando o PDF para leitura visual, como configurado em "Redigir com IA".');
  try{await lerBioComIA({pdfBase64:state.biaSource.base64});}
  catch(error){say(`A leitura local ficou salva, mas a leitura visual falhou: ${error.message} Tente de novo com "Pedir para a IA ler este PDF".`,true);}
});
// A leitura local só decifra texto de verdade. Vários relatórios de bioimpedância mostram os
// valores mais importantes (massa gorda, magra, muscular) só como medidor/desenho. A leitura visual
// segue sozinha depois de "Ler bioimpedância" quando esses valores faltam e a IA está pronta
// (chave, provedor com PDF e autorização); também pode ser pedida à mão pelo botão ao lado.
async function lerBioComIA({pdfBase64='',textoExtraido=''}={}){
  const provedor=createDraftProvider(configDaIA());
  if(pdfBase64&&!provedor.podePdf)pdfBase64='';
  if(!pdfBase64&&!textoExtraido){
    throw Error(provedor.podePdf
      ? 'Anexe o PDF de bioimpedância ou cole o texto do relatório antes de pedir a leitura.'
      : `${provedor.host} não aceita PDF como anexo, e não há texto de relatório disponível. Saídas: colar os dados no campo ao lado, ou escolher um provedor que aceite documento.`);
  }
  say(`Enviando o relatório de bioimpedância para ${provedor.host}. Aguarde.`);
  const {meta,items:lidosPelaIA,uso,modelo}=await provedor.lerBioimpedancia({pdfBase64,textoExtraido});
  // O que a leitura local já trouxe do texto do PDF (peso, altura, IMC…) é copiado dos caracteres
  // reais; se a IA deixar algum de fora, ele não se perde. O que a IA também leu prevalece.
  const semAcento=texto=>String(texto||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();
  const nomesDaIA=new Set(lidosPelaIA.map(item=>semAcento(item.analito)));
  const doTextoLocal=(state.bia?.items||[]).filter(item=>item.confianca!=='baixa'&&item.analito&&!nomesDaIA.has(semAcento(item.analito)));
  const items=[...doTextoLocal,...lidosPelaIA];
  const vistos=new Set();
  const semDuplicata=items.filter(item=>{const chave=`${item.analito}|${item.valor}|${item.unidade}`;if(vistos.has(chave))return false;vistos.add(chave);return true;});
  const marcados=markAlreadyRecorded(semDuplicata,currentEntryText());
  const avisos=examDateWarnings(meta,$('date').value);
  avisos.push('Esta transcrição foi feita por um modelo de linguagem, inclusive os valores lidos de medidores e gráficos. Confira cada um contra o documento original antes de aprovar.');
  if(!marcados.some(item=>item.confianca!=='baixa'&&/gordura|massa\s+(?:magra|muscular)/i.test(item.analito||'')))
    avisos.push('A leitura visual também não encontrou gordura, massa magra ou massa muscular neste PDF. Confira o documento e informe esses valores manualmente.');
  state.bia={meta,items:marcados,avisos};
  renderExtraction($('biaReport'),{meta,items:marcados,avisos,origem:`${modelo} lendo ${pdfBase64?'o PDF':'o texto'} do relatório${uso?` — ${uso.entrada} tokens de entrada, ${uso.saida} de saída`:''}`});
  catalogPut(makeEntry({kind:'bioimpedancia',name:state.biaSource?.name||'relatório colado',sha256:state.biaSource?.sha256??null,date:meta.data||'',method:`transcrição por ${modelo}`,state:pendingExams(marcados).length?'parcial':'lido'}));
  $('biaProse').value=biaToProse(marcados,meta);$('biaApproved').checked=false;
  say('Relatório transcrito pelo provedor. Nada está aprovado: confira cada linha contra o documento original.');
}
function metasToProse(metas,meta){
  if(!metas.length)return '';
  const head=['Metas'];if(meta.prazo)head.push(`para ${meta.prazo}`);if(meta.data)head.push(`(avaliação de ${meta.data})`);
  const un=m=>m.unidade?(m.unidade==='%'?'%':` ${m.unidade}`):'';
  const body=metas.map(m=>{const partes=[`${m.indicador} atual ${m.atual}${un(m)}`];if(m.meta)partes.push(`meta ${m.meta}${un(m)}`);return partes.join(', ');}).join('; ');
  return `${head.join(' ')}: ${body}.`;
}
// O gráfico de tendência (peso, % gordura) só existe como desenho: a leitura da tabela de metas e
// a leitura do gráfico saem da mesma chamada, mas a interpretação do gráfico é sempre aproximada —
// entra em "Interpretação do relatório", o mesmo campo já usado para leitura de terceiro, nunca
// aprovada automaticamente.
async function lerEvolucaoComIA({pdfBase64='',textoExtraido=''}={}){
  const provedor=createDraftProvider(configDaIA());
  if(pdfBase64&&!provedor.podePdf)pdfBase64='';
  if(!pdfBase64&&!textoExtraido){
    throw Error(provedor.podePdf
      ? 'Anexe o PDF de evolução e meta ou cole o texto antes de pedir a leitura.'
      : `${provedor.host} não aceita PDF como anexo, e não há texto disponível. Saídas: colar os dados no campo ao lado, ou escolher um provedor que aceite documento.`);
  }
  say(`Enviando o relatório de evolução e meta para ${provedor.host}. Aguarde.`);
  const {meta,metas,interpretacao,leitura,uso,modelo}=await provedor.lerEvolucao({pdfBase64,textoExtraido});
  state.target={meta,metas};
  $('targetReport').replaceChildren();
  reportList($('targetReport'),`Origem: ${modelo} lendo ${pdfBase64?'o PDF':'o texto'}${uso?` — ${uso.entrada} tokens de entrada, ${uso.saida} de saída`:''}`,[
    `${metas.length} indicador(es) de meta lido(s).`,
    interpretacao?'Leitura do gráfico incluída — veja em "Interpretação do relatório", abaixo.':'Sem leitura de gráfico (gráfico ausente ou pontos não legíveis com segurança).',
  ]);
  // "0 indicadores" sem explicação parecia um documento sem metas. Quando a IA devolveu linhas que o
  // app não conseguiu ler — ou nada — a tela diz isso e o que fazer.
  const alertas=['Esta transcrição foi feita por um modelo de linguagem. Confira cada valor de meta contra o documento original antes de aprovar.'];
  if(leitura?.descartadas)alertas.push(`A IA devolveu ${leitura.recebidas} linha(s) de meta, mas ${leitura.descartadas} não puderam ser lidas (faltava o nome do indicador ou o valor atual). Confira o PDF e informe essas metas manualmente.`);
  if(!metas.length)alertas.push(`Nenhuma meta foi lida. Campos devolvidos pela IA: ${(leitura?.chaves||[]).join(', ')||'nenhum'}. Se o PDF tem a tabela de metas, tente de novo ou digite os valores.`);
  reportList($('targetReport'),'Conferir antes de incorporar',alertas,'warn');
  catalogPut(makeEntry({kind:'bioimpedancia',name:state.targetSource?.name||'evolução/meta colada',sha256:state.targetSource?.sha256??null,date:meta.data||'',method:`transcrição por ${modelo}`,state:'parcial'}));
  $('targetProse').value=metasToProse(metas,meta);$('targetApproved').checked=false;
  if(interpretacao){
    const parsed=parseInterpretacao(interpretacao);
    state.interpretacao=parsed;
    $('interpReport').replaceChildren();
    reportList($('interpReport'),`Origem: ${modelo} lendo o gráfico de evolução`,['Leitura aproximada de um gráfico, não uma medição exata — como ler um número impresso.']);
    reportList($('interpReport'),'Antes de aprovar',parsed.avisos,'warn');
    const bloco=document.createElement('div');bloco.className='report';
    const titulo=document.createElement('h4');titulo.textContent='Texto lido, para conferência';
    const corpo=document.createElement('pre');corpo.textContent=parsed.paragrafos.join('\n\n');
    bloco.append(titulo,corpo);$('interpReport').append(bloco);
    $('interpFonte').value=`Leitura visual por IA (${modelo})`;
    $('interpProse').value=parsed.texto;$('interpApproved').checked=false;
  }
  say('Evolução e meta transcritas pelo provedor. Nada está aprovado: confira cada valor e a leitura do gráfico contra o documento original.');
}
$('buildDraft').onclick=protect(async()=>{
  if(!state.transcript)throw Error('Importe a transcrição antes de preparar rascunhos.');
  const draft=buildDraft({
    transcript:sourceText(state.transcript), currentEntry:currentEntryText(),
    exams:state.exams?.items||[], examsMeta:state.exams?.meta||{},
    bia:state.bia?.items||[], biaMeta:state.bia?.meta||{},
    patient:$('patient').value, consultaDate:$('date').value,
  });
  $('pendencies').replaceChildren();
  if(!draft.pendencias.length)reportList($('pendencies'),'Nenhuma pendência automática','Isso não substitui a conferência clínica de cada campo.'.split('|'));
  renderComVerMais($('pendencies'),draft.pendencias.map(item=>{
    const box=document.createElement('div');box.className='report warn';
    const head=document.createElement('h4');head.textContent=item.tipo;const body=document.createElement('p');body.textContent=item.mensagem;box.append(head,body);
    if(item.trecho){const quote=document.createElement('pre');quote.textContent=item.trecho;box.append(quote);}
    return box;
  }));
  $('proposals').replaceChildren();
  renderComVerMais($('proposals'),draft.propostas.map(item=>{
    const box=document.createElement('div');box.className='change';
    const head=document.createElement('h3');head.textContent=`${item.campo==='medications'?'Em uso de':'Evolução'} · ${item.evidencia.fonte} · ${item.evidencia.quem}${item.base?' · base atual':''}`;
    const text=document.createElement('pre');text.textContent=item.texto;
    const source=document.createElement('p');source.className='evidence';source.textContent=`Evidência: ${item.evidencia.trecho}`;
    box.append(head,text,source);
    for(const alerta of item.alerta||[]){const a=document.createElement('p');a.className='evidence warn';a.textContent=alerta;box.append(a);}
    const accept=document.createElement('button');accept.className='secondary';accept.textContent='Acrescentar ao campo';
    accept.onclick=()=>{const field=$(item.campo);field.value=(field.value.trim()?field.value.trim()+' ':'')+item.texto;field.dispatchEvent(new Event('input'));accept.disabled=true;};
    box.append(accept);
    return box;
  }));
  // A seção "Pontos que precisam ser confirmados" é uma lista clínica, não instruções de tela:
  // fica a primeira frase de cada pendência, sem repetir itens idênticos.
  state.pendencias=[...new Set(draft.pendencias.map(p=>`${p.tipo[0].toUpperCase()}${p.tipo.slice(1)}: ${p.mensagem.split(/(?<=\.)\s+/)[0]}`))];
  say(`${draft.propostas.length} proposta(s) e ${draft.pendencias.length} pendência(s). Nada foi gravado: cada item exige aceitação.`);
});
function assertInputs(){if(!state.html||!state.transcript)throw Error('As duas entradas são obrigatórias.');if(!$('modality').value)throw Error('Confirme a modalidade.');}
function approvedExtractions(){
  const campos=[
    ['exams','examsProse','examsApproved','exames extraídos'],
    ['bioimpedancia','biaProse','biaApproved','bioimpedância'],
    ['target','targetProse','targetApproved','evolução e meta'],
    ['interpretacao','interpProse','interpApproved','interpretação do relatório'],
  ];
  const out={interpretacaoFonte:$('interpFonte').value.trim()};
  for(const [chave,campo,aprovacao,rotulo] of campos){
    const valor=$(campo).value.trim();
    if(valor&&!$(aprovacao).checked)throw Error(`Há ${rotulo} sem conferência. Aprove ou limpe o campo antes de preparar o HTML.`);
    out[chave]=valor;
  }
  if(out.interpretacao&&!out.interpretacaoFonte)throw Error('Informe a fonte a creditar pela interpretação; ela não pode entrar no prontuário sem autoria.');
  return out;
}
$('prepare').onclick=protect(()=>{
  assertInputs();
  prepared=makeRecord(sourceText(state.html),state.regions,{...values(),...approvedExtractions(),identityConfirmed:$('identityConfirmed').checked,regionsConfirmed:$('regionsConfirmed').checked});
  $('changes').replaceChildren();
  const note=document.createElement('p');note.className='next-steps';
  note.textContent=prepared.mode==='atualizar'?'A entrada do dia já existente será substituída pela versão revisada. Nenhuma evolução foi acrescentada e o histórico anterior é copiado literalmente.':'Nenhuma entrada do dia foi encontrada: esta será a primeira gravação do atendimento, marcada para que reprocessar atualize em vez de duplicar.';
  $('changes').append(note);
  for(const patch of prepared.patches){const box=document.createElement('div');box.className='change';const title=document.createElement('h3');title.textContent=patch.label;const pre=document.createElement('pre');pre.textContent=`ANTES\n${sourceText(state.html).slice(patch.start,patch.end)||'(nada — inserção)'}\n\nDEPOIS\n${patch.text}`;box.append(title,pre);$('changes').append(box);}
  $('recordApproved').checked=false;$('recordApproved').disabled=false;$('exportRecord').disabled=true;say('Confira cada alteração. O restante do HTML será copiado literalmente.');
});
$('recordApproved').onchange=()=>{$('exportRecord').disabled=!$('recordApproved').checked||!prepared;};
function download(blob,name){
  const url=URL.createObjectURL(blob);try{const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}catch(error){URL.revokeObjectURL(url);throw Error('Falha ao exportar. Mantenha a sessão aberta e tente novamente.');}
  say('Download solicitado. Confira o destino e o arquivo salvo; o navegador pode acrescentar numeração se já existir.');
}
const stem=()=>`${safeName($('patient').value)}_${$('date').value}`;
$('exportRecord').onclick=protect(()=>{
  if(!prepared||!$('recordApproved').checked)throw Error('Prepare e aprove o HTML.');
  const filename=$('recordFilename').value.trim()||`prontuario_${safeName($('patient').value)}_gestaods.html`;
  if(!/^[\p{L}\p{N}_. -]+\.html$/u.test(filename))throw Error('Informe apenas um nome de arquivo .html, sem diretórios.');
  download(new Blob([new TextEncoder().encode(prepared.html)],{type:'text/html;charset=utf-8'}),filename);
});
function captureFields(){const doc=$('summaryFrame').contentDocument;return Object.fromEntries([...doc.querySelectorAll('[data-field]')].map(f=>[f.dataset.field,f.innerHTML]));}
async function mountSummary(savedFields){
  const data=summaryData();const html=buildSummary(await templatePromise,data);const frame=$('summaryFrame');
  await new Promise(resolve=>{frame.onload=resolve;frame.srcdoc=html;frame.hidden=false;});
  const doc=frame.contentDocument;
  if(savedFields)for(const field of doc.querySelectorAll('[data-field]'))if(typeof savedFields[field.dataset.field]==='string')field.innerHTML=safeMarkup(savedFields[field.dataset.field],true);
  const editor=installEditor(doc,frame.contentWindow,()=>{revokeSummary();});
  editor.save.hidden=true;doc.getElementById('printBtn').hidden=true;
  summaryReady=true;summaryDirty=false;$('summaryApproved').disabled=false;revokeSummary();
}
$('buildSummary').onclick=protect(async()=>{
  validateSummaryFields();
  if(summaryReady&&!confirm('Remontar substitui as edições feitas diretamente no resumo. Continuar?'))return;
  await mountSummary();say('Resumo montado. Edite, grife e confira antes de aprovar.');
});
$('summaryApproved').onchange=()=>{const allowed=summaryReady&&$('summaryApproved').checked;$('exportSummary').disabled=!allowed;$('printSummary').disabled=!allowed;};
function finalSummary(){assertInputs();if(!$('identityConfirmed').checked)throw Error('Confirme novamente a identidade do atendimento.');if(!summaryReady||summaryDirty||!$('summaryApproved').checked)throw Error('Monte e aprove a versão final do resumo.');const doc=$('summaryFrame').contentDocument;
  const text=[...doc.querySelectorAll('[data-field]')].map(f=>f.textContent).join(' ');if(/\bretorno\b/i.test(text))throw Error('Revise a nomenclatura: não usar retorno.');
  const copy=new DOMParser().parseFromString(snapshotSummary(doc),'text/html');copy.getElementById('printBtn').hidden=false;return '<!doctype html>\n'+copy.documentElement.outerHTML;
}
$('exportSummary').onclick=protect(()=>download(new Blob([finalSummary()],{type:'text/html;charset=utf-8'}),`resumo_consulta_${stem()}.html`));
$('printSummary').onclick=protect(()=>{finalSummary();$('summaryFrame').contentWindow.print();say('Impressão solicitada da mesma versão exibida. Salve como PDF e confira as páginas.');});
// Compartilhado entre "Salvar sessão" (arquivo) e "Salvar no histórico" (pasta local via servidor):
// as duas formas de persistência gravam e reabrem exatamente o mesmo formato.
function sessionPayload(){
  if(!state.html||!state.transcript)throw Error('Carregue as duas entradas para salvar a sessão.');
  return {hub:hub.snapshot(),schema:3,id:state.id,html:state.html,transcript:state.transcript,extras:state.extras,examSource:state.examSource??null,regions:state.regions,catalog:state.catalog,exams:state.exams,bia:state.bia,target:state.target,interpretacao:state.interpretacao,biaLink:state.biaLink,fields:values(),commercialEnabled:$('commercialEnabled').checked,summaryFields:summaryReady?captureFields():null,summaryDirty};
}
async function restoreSession(parsed){
  if(parsed.schema!==3||!parsed.fields||!Array.isArray(parsed.extras)||parsed.extras.length>50)throw Error('Formato de sessão inválido ou de uma versão anterior do aplicativo.');
  const html=await verifySource(parsed.html),transcript=await verifySource(parsed.transcript),extras=await Promise.all(parsed.extras.map(verifySource));
  const examSource=parsed.examSource?await verifySource(parsed.examSource):undefined;
  if(state.html&&!confirm('Substituir a sessão aberta? Salve o trabalho antes.'))return false;
  // A consulta reaberta mantém o identificador com que foi salva: um id novo a cada reabertura fazia
  // "salvar de novo" criar outro arquivo e a mesma consulta aparecer duplicada no histórico.
  const idSalvo=typeof parsed.id==='string'&&/^[\w-]{1,80}$/.test(parsed.id)?parsed.id:crypto.randomUUID();
  reset();state={id:idSalvo,html,transcript,extras,examSource,regions:parsed.regions,catalog:Array.isArray(parsed.catalog)?parsed.catalog:[],exams:parsed.exams??null,bia:parsed.bia??null,target:parsed.target??null,interpretacao:parsed.interpretacao??null,biaLink:parsed.biaLink??null};
  if(state.biaLink)$('biaLink').value='';
  for(const id of fieldIds)if(typeof parsed.fields[id]==='string')$(id).value=parsed.fields[id];$('commercialEnabled').checked=parsed.commercialEnabled===true;renderSources();
  hub.restore(parsed.hub);
  if(parsed.summaryFields){await mountSummary(parsed.summaryFields);summaryDirty=parsed.summaryDirty===true;if(summaryDirty)$('summaryApproved').disabled=true;}
  return true;
}
$('saveSession').onclick=protect(()=>{
  download(new Blob([JSON.stringify(sessionPayload())],{type:'application/json'}),`sessao_${stem()}.json`);
});
$('sessionFile').onchange=protect(async event=>{
  const file=event.target.files[0];if(!file||file.size>30*1024*1024)throw Error('Sessão ausente ou maior que 30 MB.');
  if(await restoreSession(JSON.parse(await file.text())))say('Sessão reaberta; originais íntegros. Confirme novamente identidade, limites e aprovações.');
});
// Pacientes e Histórico vivem em pacientes.mjs; recebem daqui só o que realmente usam.
const pacientes=mountPacientes({$,protect,say,wizard,temSessaoAberta:()=>Boolean(state.html),reset,restoreSession,sessionPayload,aoVerificarPasta:()=>atualizarChecklist()});
scribe=mountScribe({
  $,say,protect,templatePromise,
  aplicarTranscricaoECampos:async({nome,dataAtendimento,transcricao,bloco,codigoBloco,resumoPaciente,mensagemWhatsapp})=>{
    $('patient').value=nome;
    $('date').value=dataAtendimento;
    if(!$('modality').value)$('modality').value='Avulso';
    if(transcricao){
      const src=await sourceFile(new TextEncoder().encode(transcricao),'transcricao_gemini.txt');
      state.transcript=src;
      $('workingText').value=transcricao;
      $('pastedTranscript').value=transcricao;
      if($('scribeTranscriptText'))$('scribeTranscriptText').value=transcricao;
      catalogPut(makeEntry({kind:'transcricao',name:src.name,sha256:src.sha256,date:dataAtendimento,method:'Gemini Flash (áudio)',state:'lido'}));
    }
    if(!state.html){
      const htmlMinimo=`<div><p><strong>Paciente:</strong> ${nome}</p><!-- app:evolucao --></div>`;
      const htmlSrc=await sourceFile(new TextEncoder().encode(htmlMinimo),'prontuario_gerado.html');
      state.html=htmlSrc;
      state.regions=detectRegions(htmlMinimo);
    }
    $('identityConfirmed').checked=true;
    for(const [chave,valor] of Object.entries(bloco||{})){
      const campo=$(`bloco_${chave}`);
      if(campo)campo.value=valor;
    }
    if(codigoBloco){
      $('blockCode').value=codigoBloco;
      $('blockPreview').innerHTML=safeMarkup(codigoBloco);
      $('blockApproved').checked=true;
      $('copyBlock').disabled=false;
      $('downloadBlock').disabled=false;
    }
    for(const [campo,valor] of Object.entries(resumoPaciente||{})){
      if($(campo))$(campo).value=valor;
    }
    if($('scribeWhatsappText'))$('scribeWhatsappText').value=mensagemWhatsapp||'';
    if($('scribeResultDrawer')){$('scribeResultDrawer').hidden=false;$('scribeResultDrawer').open=true;}
    renderSources();
    await mountSummary();
    $('summaryApproved').checked=true;
    $('exportSummary').disabled=false;
    $('printSummary').disabled=false;
  }
});
checklistPronto=true;atualizarChecklist();
for(const [id,key] of [['downloadOriginalHtml','html'],['downloadOriginalText','transcript']])$(id).onclick=protect(()=>{if(!state[key])throw Error('Importe o original primeiro.');download(new Blob([fromBase64(state[key].base64)],{type:'application/octet-stream'}),`original_${safeName(state[key].name)}.${key==='html'?'html':'txt'}`);});
$('newSession').onclick=()=>{if(confirm('Limpar a sessão da memória? Salve os arquivos antes; não há salvamento automático.')){reset();say('Nova consulta iniciada.');}};

function revokeBlock(){$('blockApproved').checked=false;$('copyBlock').disabled=true;$('downloadBlock').disabled=true;$('blockCode').value='';$('blockPreview').replaceChildren();}
$('seedBlock').onclick=protect(()=>{
  const aprovadas=id=>$(id.campo).value.trim()&&$(id.aprovacao).checked;
  const semente=seedSections({
    exams: aprovadas({campo:'examsProse',aprovacao:'examsApproved'})?(state.exams?.items||[]):[],
    examsMeta: state.exams?.meta||{},
    bia: aprovadas({campo:'biaProse',aprovacao:'biaApproved'})?(state.bia?.items||[]):[],
    biaMeta: state.bia?.meta||{},
    target: aprovadas({campo:'targetProse',aprovacao:'targetApproved'})?state.target:null,
    pendencias: state.pendencias||[],
    medications: $('medications').value,
  });
  const preenchidas=[];
  for(const [chave,valor] of Object.entries(semente)){
    const campo=$(`bloco_${chave}`);
    if(campo.value.trim()&&!confirm(`A seção "${BLOCK_SECTIONS.find(s=>s.key===chave).title}" já tem conteúdo. Substituir?`))continue;
    campo.value=valor;campo.dispatchEvent(new Event('input'));preenchidas.push(chave);
  }
  if(!preenchidas.length)throw Error('Nada a preencher: aprove as extrações e prepare os rascunhos antes.');
  say(`${preenchidas.length} seção(ões) preenchida(s) a partir do que já foi conferido. Revise cada linha antes de gerar o código.`);
});
$('buildBlock').onclick=protect(()=>{
  const valores=Object.fromEntries(BLOCK_SECTIONS.map(s=>[s.key,$(`bloco_${s.key}`).value]));
  const codigo=buildClinicalBlock(valores,{heading:$('bloco_heading').value.trim()||undefined});
  $('blockCode').value=codigo;
  $('blockPreview').innerHTML=safeMarkup(codigo);
  $('blockApproved').checked=false;$('copyBlock').disabled=false;$('downloadBlock').disabled=false;
  say('Código gerado. Confira a prévia e o texto antes de colar no sistema da clínica.');
});
$('copyBlock').onclick=protect(async()=>{
  if(!$('blockCode').value)throw Error('Gere o código antes de copiar.');
  if(!$('blockApproved').checked)throw Error('Revise e aprove o bloco antes de copiar.');
  try{await navigator.clipboard.writeText($('blockCode').value);say('Código copiado. Cole no prontuário da clínica e confira o resultado lá.');}
  catch{$('blockCode').select();throw Error('O navegador recusou a cópia automática. O texto está selecionado: use Ctrl+C.');}
});
$('downloadBlock').onclick=protect(()=>{
  if(!$('blockCode').value)throw Error('Gere o código antes de salvar.');
  if(!$('blockApproved').checked)throw Error('Revise e aprove o bloco antes de salvar.');
  download(new Blob([new TextEncoder().encode($('blockCode').value)],{type:'text/html;charset=utf-8'}),`bloco_${stem()}.html`);
});

function configDaIA(){
  return {mode:AI_MODES.external,apiKey:$('aiKey').value,provedor:$('aiProvider').value,
    endpoint:$('aiEndpoint').value.trim(),modelo:$('aiModel').value.trim(),aceitaPdf:$('aiPdfOk').checked};
}
let aplicarProvedor=()=>{};
// Guardado só a pedido explícito da profissional, ciente da troca: fica em texto legível neste
// navegador (localStorage), sobrevive ao fechar a aba, mas nunca sai deste computador nem entra
// na sessão exportada. "Esquecer chave salva" apaga tudo de uma vez.
const AI_STORAGE_KEY='prontuario-local:redigir-com-ia';
function lerConfigSalva(){try{const bruto=localStorage.getItem(AI_STORAGE_KEY);return bruto?JSON.parse(bruto):null;}catch{return null;}}
function salvarConfig(){
  try{localStorage.setItem(AI_STORAGE_KEY,JSON.stringify({provedor:$('aiProvider').value,endpoint:$('aiEndpoint').value,modelo:$('aiModel').value,chave:$('aiKey').value,pdfOk:$('aiPdfOk').checked}));}
  catch{/* Modo privado ou armazenamento bloqueado: a chave simplesmente não persiste. */}
}
function preencherProvedores(){
  const seletor=$('aiProvider');
  for(const p of listaDeProvedores()){const op=document.createElement('option');op.value=p.id;op.textContent=p.label;seletor.append(op);}
  const mostrarDestino=()=>{
    const caixa=$('aiDestino'),badge=$('aiBadge');
    try{
      const {host,modelo}=resolverProvedor({id:seletor.value,endpoint:$('aiEndpoint').value.trim(),modelo:$('aiModel').value.trim()});
      caixa.textContent=`As fontes irão para ${host}, no modelo ${modelo}.`;
      caixa.className='evidence';
      const temChave=$('aiKey').value.trim().length>0;
      badge.textContent=temChave?`Configurado · ${host}`:'Falta informar a chave';
      badge.className='conn-badge '+(temChave?'ok':'warn');
    }catch(erro){
      caixa.textContent=erro.message;caixa.className='evidence warn';
      badge.textContent='Configuração incompleta';badge.className='conn-badge warn';
    }
  };
  const aplicar=()=>{
    const p=listaDeProvedores().find(x=>x.id===seletor.value);
    $('aiEndpoint').value=p.endpoint;$('aiEndpoint').readOnly=!p.exigeEndpoint;
    $('aiModel').value=p.modeloPadrao;$('aiPdfOk').checked=p.aceitaPdfPadrao;$('aiPdfOk').disabled=p.pdfFixo;
    $('aiPdfNota').textContent=p.pdfFixo?'Este provedor não aceita PDF como anexo. O laudo precisa vir da leitura local ou do texto colado.':'Confira na documentação do provedor antes de marcar.';
  };
  const atualizar=()=>{aplicar();mostrarDestino();};
  seletor.onchange=()=>{atualizar();salvarConfig();};
  for(const id of ['aiEndpoint','aiModel','aiKey','aiPdfOk'])$(id).addEventListener('input',()=>{mostrarDestino();salvarConfig();});
  aplicarProvedor=atualizar;
  const salva=lerConfigSalva();
  if(salva?.provedor){
    seletor.value=salva.provedor;aplicar();
    if(typeof salva.endpoint==='string')$('aiEndpoint').value=salva.endpoint;
    if(typeof salva.modelo==='string')$('aiModel').value=salva.modelo;
    if(typeof salva.chave==='string')$('aiKey').value=salva.chave;
    if(typeof salva.pdfOk==='boolean'&&!$('aiPdfOk').disabled)$('aiPdfOk').checked=salva.pdfOk;
    mostrarDestino();
  }else atualizar();
  $('aiForgetKey').onclick=()=>{
    try{localStorage.removeItem(AI_STORAGE_KEY);}catch{/* nada para apagar */}
    $('aiKey').value='';mostrarDestino();say('Chave salva neste navegador foi apagada.');
  };
}
preencherProvedores();
async function lerExamesComIA({pdfBase64='',textoExtraido=''}={}){
  const provedor=createDraftProvider(configDaIA());
  if(pdfBase64&&!provedor.podePdf)pdfBase64='';
  if(!pdfBase64&&!textoExtraido){
    // Este é o beco sem saída real: laudo que a leitura local não decifra, em provedor que não
    // aceita documento. Dizer as saídas vale mais do que repetir que faltou arquivo.
    throw Error(provedor.podePdf
      ? 'Anexe o PDF de exames ou cole o texto do laudo antes de pedir a leitura.'
      : `${provedor.host} não aceita PDF como anexo, e não há texto de laudo disponível. Saídas: colar o texto do laudo no campo ao lado, ou escolher um provedor que aceite documento.`);
  }
  say(`Enviando o laudo para ${provedor.host}. Aguarde.`);
  const {meta,items,uso,modelo}=await provedor.lerExames({pdfBase64,textoExtraido});
  const marcados=markAlreadyRecorded(items,state.html?sourceText(state.html):'');
  const avisos=examDateWarnings(meta,$('date').value);
  if($('patient').value&&meta.paciente&&!meta.paciente.toLowerCase().includes($('patient').value.trim().split(/\s+/)[0].toLowerCase()))
    avisos.push(`O documento está em nome de "${meta.paciente}", diferente da identificação confirmada. Não incorpore resultados de outra pessoa.`);
  avisos.push('Esta transcrição foi feita por um modelo de linguagem. Confira cada analito, valor e unidade contra o documento original antes de aprovar.');
  renderExtraction($('examReport'),{meta,items:marcados,avisos,origem:`${modelo} lendo ${pdfBase64?'o PDF':'o texto'} do laudo${uso?` — ${uso.entrada} tokens de entrada, ${uso.saida} de saída`:''}`});
  catalogPut(makeEntry({kind:'exame',name:state.examSource?.name||'laudo colado',sha256:state.examSource?.sha256??null,date:meta.data||'',method:`transcrição por ${modelo}`,state:pendingExams(marcados).length?'parcial':'lido'}));
  addExamResult(marcados,meta);
  say('Laudo transcrito pelo provedor. Nada está aprovado: confira cada linha contra o documento original.');
}
$('aiReadExams').onclick=protect(async()=>{
  if(!$('aiConsent').checked)throw Error('Marque a autorização em "Redigir com IA" antes de enviar o documento ao provedor externo.');
  const provedor=createDraftProvider(configDaIA());
  const pdfBase64=provedor.podePdf?(state.examSource?.base64||''):'';
  const textoExtraido=pdfBase64?'':($('examPaste').value.trim()||state.examTextoLido||'');
  await lerExamesComIA({pdfBase64,textoExtraido});
});
$('aiReadBia').onclick=protect(async()=>{
  if(!$('aiConsent').checked)throw Error('Marque a autorização em "Redigir com IA" antes de enviar o documento ao provedor externo.');
  const provedor=createDraftProvider(configDaIA());
  const pdfBase64=provedor.podePdf?(state.biaSource?.base64||''):'';
  const textoExtraido=pdfBase64?'':$('biaPaste').value.trim();
  await lerBioComIA({pdfBase64,textoExtraido});
});
$('aiReadTarget').onclick=protect(async()=>{
  if(!$('aiConsent').checked)throw Error('Marque a autorização em "Redigir com IA" antes de enviar o documento ao provedor externo.');
  const provedor=createDraftProvider(configDaIA());
  const pdfBase64=provedor.podePdf?(state.targetSource?.base64||''):'';
  const textoExtraido=pdfBase64?'':$('targetPaste').value.trim();
  await lerEvolucaoComIA({pdfBase64,textoExtraido});
});
$('aiWrite').onclick=protect(async()=>{
  if(!$('aiConsent').checked)throw Error('Marque a autorização antes de enviar as fontes ao provedor externo.');
  const aprovado=(campo,aprovacao)=>$(aprovacao).checked?$(campo).value.trim():'';
  const provedor=createDraftProvider(configDaIA());
  $('aiReport').replaceChildren();
  say(`Enviando as fontes aprovadas para ${provedor.host}. Aguarde.`);
  const {secoes,uso,modelo}=await provedor.redigir({
    currentEntry:prontuarioTexto().texto,
    transcript:state.transcript?sourceText(state.transcript):'',
    medications:$('medications').value,
    examsProse:aprovado('examsProse','examsApproved'),
    biaProse:aprovado('biaProse','biaApproved'),
    targetProse:aprovado('targetProse','targetApproved'),
    interpretacao:aprovado('interpProse','interpApproved'),
    pendencias:state.pendencias||[],
  });
  const escritas=[];
  for(const [chave,valor] of Object.entries(secoes)){
    const campo=$(`bloco_${chave}`);
    if(!campo)continue;
    if(campo.value.trim()&&!confirm(`A seção "${BLOCK_SECTIONS.find(s=>s.key===chave).title}" já tem conteúdo. Substituir pelo texto da IA?`))continue;
    campo.value=valor;campo.dispatchEvent(new Event('input'));escritas.push(chave);
  }
  reportList($('aiReport'),`Rascunho recebido de ${modelo}`,[
    `${escritas.length} seção(ões) preenchida(s). Nenhuma foi aprovada: revise cada linha contra as fontes.`,
    uso?`Tokens: ${uso.input_tokens} de entrada, ${uso.output_tokens} de saída.`:'Uso não informado pelo provedor.',
    'O texto é rascunho de máquina. Números, medicamentos e datas precisam ser conferidos no documento original.',
  ],'warn');
  say(`${escritas.length} seção(ões) preenchida(s) pelo provedor. Nada está aprovado: revise antes de gerar o código.`);
});
for(const id of [...blocoIds,'bloco_heading'])$(id).addEventListener('input',revokeBlock);
$('blockApproved').onchange=()=>{};
// "Há trabalho aberto" vai além dos arquivos carregados: a base gerada pela IA, os textos gerados, o
// resumo montado e qualquer campo preenchido também se perdem ao fechar (não há salvamento
// automático). Campos que nascem com valor padrão não contam.
const CAMPOS_COM_VALOR_PADRAO={patientType:'Nova consulta',internalType:'Nova consulta',bloco_heading:'1. Prontuário clínico',interpFonte:'Galileu'};
function haTrabalhoAberto(){
  if(scribe?.temTrabalhoScribe())return true;
  if(state.html||state.transcript||state.exams||state.bia||state.target||$('pastedHtml').value||$('pastedTranscript').value)return true;
  const salvo=hub.snapshot();
  if(salvo.base?.itens?.length||salvo.outputs?.mensagem?.texto||salvo.outputs?.resumo?.texto)return true;
  if(summaryReady)return true;
  return fieldIds.some(id=>{const valor=$(id).value.trim();return valor&&valor!==CAMPOS_COM_VALOR_PADRAO[id];});
}
window.addEventListener('beforeunload',event=>{if(haTrabalhoAberto()){event.preventDefault();event.returnValue='';}});

async function acionarAtualizacaoApp(event){
  if(scribe?.estaGravando())throw Error('Encerre a gravação da consulta antes de atualizar o aplicativo.');
  if(haTrabalhoAberto()&&!confirm('Há dados de uma consulta aberta na tela. Ao atualizar, o aplicativo será recarregado. Deseja continuar mesmo assim?'))return;
  const forcar=Boolean(event?.shiftKey);
  say('Verificando atualizações no GitHub…');
  if($('settingsUpdateStatus'))$('settingsUpdateStatus').textContent='Consultando GitHub…';
  const r=await fetch('/api/app/update',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-Clinical-Request':'1'},
    body:JSON.stringify({forcar}),
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok){
    if($('settingsUpdateStatus'))$('settingsUpdateStatus').textContent=d.error||'Falha ao verificar atualização.';
    throw Error(d.error||'Falha ao atualizar o aplicativo.');
  }
  if($('settingsUpdateStatus'))$('settingsUpdateStatus').textContent=d.message||'';
  say(d.message||'Aplicativo verificado.');
  if(d.updated){
    setTimeout(()=>{
      if(window.chaveSintese?.reiniciarApp){
        window.chaveSintese.reiniciarApp();
      }else{
        window.location.reload();
      }
    },1200);
  }
}
if($('updateAppBtn'))$('updateAppBtn').onclick=protect(acionarAtualizacaoApp);
if($('settingsUpdateAppBtn'))$('settingsUpdateAppBtn').onclick=protect(acionarAtualizacaoApp);
