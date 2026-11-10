// All requests stay on the local origin; only Node knows the provider credential.
import {renderComVerMais} from './ui.mjs';
export function mountHub({sources,onStatus,onRefresh=()=>{}}) {
  const $=id=>document.getElementById(id);
  const blank=()=>({version:1,base:null,sourceSnapshot:null,approval:null,revision:0,outputs:{mensagem:null,resumo:null}});
  let state=blank(),epoch=0,busy=false,requests=new Set(),chaveOk=null;
  const sameSources=()=>state.sourceSnapshot&&JSON.stringify(state.sourceSnapshot)===JSON.stringify(sources());
  const naoConfirmadas=()=>(state.base?.itens||[]).reduce((total,item)=>total+item.origens.filter(o=>o.verificada===false).length,0);
  async function request(path,body){
    const controller=new AbortController();requests.add(controller);
    try{
      const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Clinical-Request':'1'},body:JSON.stringify(body),signal:controller.signal});
      const data=await response.json();if(!response.ok)throw Error(data.error||'Falha no servidor local.');return data;
    }finally{requests.delete(controller);}
  }
  function revoke(){state.approval=null;$('hubApprove').checked=false;state.revision++;refresh();}
  function gate(condicao,mensagem,anchor,label){if(!condicao){const erro=Error(mensagem);erro.anchor=anchor;erro.linkLabel=label;throw erro;}}
  function consent(){gate($('hubConsent').checked,'Autorize o envio das fontes à Anthropic.','conexoes','Ir para Conexões de IA →');}
  function refresh(){
    if(state.approval&&!sameSources()){state.approval=null;$('hubApprove').checked=false;}
    // A navegação entre passos é livre: quem chega direto neste passo sem passar por "Entradas"
    // precisa de um aviso claro, não só de um erro depois de clicar.
    const input=sources(),faltaProntuario=!input.prontuario.trim(),faltaTranscricao=!input.transcricao.trim(),semFontes=faltaProntuario||faltaTranscricao;
    $('hubGenerate').disabled=busy||semFontes;
    $('hubGenerate').textContent=busy?'Gerando o resumo… (uma consulta real pode levar alguns minutos)':'Gerar resumo para conferir';
    $('hubApprove').disabled=busy||!state.base||!sameSources();
    const faltaConsentimento=state.approval&&!$('hubConsent').checked;
    $('hubDeliver').disabled=busy||!state.approval||!$('hubConsent').checked;
    $('hubSaveBase').disabled=!state.base;
    // Reabrir uma sessão salva sempre desmarca "Autorizo enviar..." (em Ajustes) — a base aprovada
    // é preservada, mas essa caixa fica numa página que a profissional não está olhando neste
    // passo. Sem este aviso aqui, "Conferi cada item" parecia funcionar (a aprovação é local, não
    // depende do consentimento) e "Gerar mensagem e resumo" continuava desabilitado sem explicação.
    $('hubState').replaceChildren();
    const escreverEstado=(texto,link=null)=>{
      $('hubState').append(texto);
      if(link){$('hubState').append(' ');const a=document.createElement('a');a.href='#'+link.anchor;a.textContent=link.label;$('hubState').append(a);}
    };
    if(busy)escreverEstado('Em execução…');
    else if(semFontes)escreverEstado(`Falta carregar em "1 · Entradas": ${[faltaProntuario&&'o HTML do prontuário',faltaTranscricao&&'a transcrição'].filter(Boolean).join(' e ')}.`);
    // Sem chave, o único sinal era o selo "Chave não configurada" no canto (com o motivo só num
    // tooltip): a pessoa clicava em gerar e recebia um erro. O motivo e o caminho ficam à vista.
    else if(!state.base&&chaveOk===false)escreverEstado('Falta a chave da Anthropic para gerar o resumo. Cole a chave em Ajustes.',{anchor:'conexoes',label:'Ir para Ajustes →'});
    else if(!state.base)escreverEstado('1 · Arquivos carregados. Gere o resumo quando estiver pronto.');
    else if(!sameSources())escreverEstado('Os arquivos mudaram. Gere um novo resumo; as edições anteriores permanecem visíveis.');
    else if(faltaConsentimento)escreverEstado('3 · Base aprovada, mas a autorização de envio foi desmarcada — acontece ao reabrir uma sessão salva.',{anchor:'conexoes',label:'Marcar em Conexões de IA →'});
    else if(state.approval)escreverEstado('3 · Resumo conferido. Gere e revise os dois textos.');
    else escreverEstado(`2 · Resumo gerado, ainda não conferido. Confira cada item e o trecho de onde veio.${naoConfirmadas()?` ${naoConfirmadas()} citação(ões) não foram localizadas literalmente na fonte e estão marcadas com ⚠ — confira essas na fonte original.`:''}`);
    for(const kind of ['mensagem','resumo']){
      const output=state.outputs[kind];
      const current=state.approval&&output?.revision===state.revision;
      $('hubStatus_'+kind).textContent=output?.status==='running'?'Gerando…':output?.status==='failed'?output.error:output?current?'Rascunho pronto para edição e conferência.':'Versão anterior — gere novamente depois de conferir o resumo.':'Ainda não gerado.';
      $('hubRetry_'+kind).disabled=busy||!state.approval||!$('hubConsent').checked;
      $('hubFinal_'+kind).disabled=!current||output?.status!=='ready';
      if(!current)$('hubFinal_'+kind).checked=false;
      $('hubCopy_'+kind).disabled=!current||output?.status!=='ready'||!$('hubFinal_'+kind).checked;
      $('hubSave_'+kind).disabled=$('hubCopy_'+kind).disabled;
    }
    onRefresh();
  }
  function render(){
    const box=$('hubBase');box.replaceChildren();
    const cartoes=(state.base?.itens||[]).map((item,index)=>{
      const card=document.createElement('div');card.className=item.origens.some(o=>o.verificada===false)?'pipeline-output nao-confirmado':'pipeline-output';
      const label=document.createElement('label');label.textContent=({fato:'Fato registrado',conduta:'Conduta registrada',pendencia:'Pendente de confirmação'})[item.tipo];
      const field=document.createElement('textarea');field.rows=3;field.value=item.texto;field.dataset.baseItem=String(index);
      field.oninput=()=>{item.texto=field.value;revoke();};label.append(field);card.append(label);
      const kind=document.createElement('select');kind.setAttribute('aria-label','Classificação do item');
      for(const type of ['fato','conduta','pendencia']){const option=document.createElement('option');option.value=type;option.textContent=type;kind.append(option);}kind.value=item.tipo;kind.onchange=()=>{item.tipo=kind.value;revoke();};card.append(kind);
      // Origem não confirmada não é descartada nem escondida: aparece marcada, para a profissional
      // conferir na fonte antes de aprovar. Descartar a síntese inteira por causa de uma citação
      // imperfeita jogava fora todo o trabalho já gerado; esconder seria pior ainda.
      for(const origin of item.origens){
        const quote=document.createElement('p');
        quote.className=origin.verificada===false?'evidence warn':'evidence';
        quote.textContent=origin.verificada===false
          ? `⚠ ${origin.fonte} — não localizada literalmente na fonte, confira antes de aprovar: “${origin.trecho}”`
          : `${origin.fonte}: “${origin.trecho}”`;
        card.append(quote);
      }
      const remove=document.createElement('button');remove.className='secondary';remove.textContent='Excluir item';remove.onclick=()=>{state.base.itens.splice(index,1);revoke();render();};card.append(remove);
      return card;
    });
    // Uma consulta real gera muito mais itens que o exemplo fictício, e mostrar todos de uma vez
    // obrigava a rolar a página inteira antes de conseguir marcar "Conferi cada item". O aviso em
    // hubState já diz quando há alguma citação não confirmada, mesmo que o cartão dela esteja
    // escondido atrás de "Mostrar mais".
    renderComVerMais(box,cartoes);
    for(const kind of ['mensagem','resumo'])$('hubText_'+kind).value=state.outputs[kind]?.texto||'';
    refresh();
  }
  function exportText(text,name){const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const safe=fn=>async()=>{try{await fn();}catch(error){onStatus(error.message||'Operação interrompida.',true,error.anchor?{anchor:error.anchor,label:error.linkLabel||'Corrigir →'}:null);}finally{refresh();}};
  $('hubGenerate').onclick=safe(async()=>{
    if(busy)return;consent();const input=sources();
    gate(input.prontuario.trim()&&input.transcricao.trim(),'Carregue prontuário e transcrição usando as entradas abaixo.','entrada','Ir para Entradas →');
    gate($('identityConfirmed').checked,'Confirme a identidade nas entradas.','entrada','Ir para Entradas →');
    gate(!(input.laudos.trim()&&!$('examsApproved').checked),'Confira os exames extraídos antes de enviá-los.','apoio','Ir para Documentos de apoio →');
    if(state.base&&!confirm('Substituir o resumo e os textos gerados? Salve a consulta antes se quiser conservar a versão anterior.'))return;
    const run=++epoch;busy=true;refresh();
    try{const result=await request('/api/synthesize',{sources:input,consent:true});if(run!==epoch)return;if(JSON.stringify(input)!==JSON.stringify(sources()))throw Error('Fontes alteradas durante a geração. Gere novamente.');state={...blank(),base:result.base,sourceSnapshot:input,revision:state.revision+1};$('hubApprove').checked=false;render();onStatus('Resumo pronto para conferir. Nada foi aceito automaticamente.');}
    finally{if(run===epoch)busy=false;}
  });
  $('hubApprove').onchange=safe(async()=>{
    if(!$('hubApprove').checked){revoke();return;}
    if(!sameSources())throw Error('As fontes mudaram. Gere novamente.');
    const run=epoch,revision=state.revision;busy=true;refresh();
    try{const result=await request('/api/approve',{base:state.base,approved:true});if(run!==epoch||revision!==state.revision||!sameSources())return;state.approval=result.approval;}
    finally{if(run===epoch){busy=false;if(!state.approval)$('hubApprove').checked=false;}}
  });
  async function deliver(kinds){
    if(busy)return;consent();if(!state.approval||!sameSources())throw Error('Revise e aprove a base atual.');
    if(kinds.some(kind=>state.outputs[kind]?.texto)&&!confirm('Substituir os rascunhos selecionados pelas novas versões?'))return;
    const run=epoch,revision=state.revision,base=structuredClone(state.base),approval=state.approval;
    busy=true;
    for(const kind of kinds){state.outputs[kind]={...state.outputs[kind],status:'running',revision};$('hubFinal_'+kind).checked=false;}refresh();
    await Promise.allSettled(kinds.map(async kind=>{
      try{
        const result=await request('/api/deliver',{kind,base,approval,consent:true});
        // Uma entrega já chegou "pronta" com o campo vazio, sem lançar erro nenhum, e a causa não
        // se repetiu com dados fictícios — só a forma da resposta, nunca o conteúdo, para achar de
        // verdade se acontecer de novo, em vez de adivinhar outra vez.
        console.debug('[hub] deliver recebeu',{kind,tamanho:result.texto?.length,descartado_por:run!==epoch?'run':revision!==state.revision?'revision':!sameSources()?'fontes':null});
        if(run!==epoch||revision!==state.revision||!sameSources())return;
        state.outputs[kind]={texto:result.texto,status:'ready',revision};$('hubText_'+kind).value=result.texto;
      }
      catch(error){if(run===epoch&&revision===state.revision)state.outputs[kind]={...state.outputs[kind],status:'failed',error:error.message,revision};}
      finally{if(run===epoch)refresh();}
    }));
    if(run===epoch){busy=false;for(const kind of kinds)if(state.outputs[kind]?.status==='running')state.outputs[kind].status='stale';refresh();}
  }
  $('hubDeliver').onclick=safe(()=>deliver(['mensagem','resumo']));
  $('hubConsent').onchange=refresh;
  $('hubSaveBase').onclick=()=>exportText(state.base.itens.map(x=>`${x.tipo.toUpperCase()}: ${x.texto}\n${x.origens.map(o=>`${o.verificada===false?'[!] NAO LOCALIZADA LITERALMENTE NA FONTE - CONFERIR: ':''}${o.fonte}: ${o.trecho}`).join('\n')}`).join('\n\n'),'base-revisao.txt');
  for(const kind of ['mensagem','resumo']){
    $('hubText_'+kind).oninput=()=>{if(state.outputs[kind])state.outputs[kind].texto=$('hubText_'+kind).value;$('hubFinal_'+kind).checked=false;refresh();};
    $('hubRetry_'+kind).onclick=safe(()=>deliver([kind]));
    $('hubFinal_'+kind).onchange=refresh;
    $('hubCopy_'+kind).onclick=safe(async()=>{refresh();if($('hubCopy_'+kind).disabled)throw Error('Confira a entrega atual antes de copiar.');await navigator.clipboard.writeText(state.outputs[kind].texto);onStatus('Texto copiado.');});
    $('hubSave_'+kind).onclick=safe(()=>{refresh();if($('hubSave_'+kind).disabled)throw Error('Confira a entrega atual antes de salvar.');exportText(state.outputs[kind].texto,kind+'-revisado.txt');});
  }
function atualizarConexao(){
    return fetch('/api/status').then(r=>r.json()).then(config=>{
      const badge=$('hubConnection');
      badge.textContent=config.configured?`Conectado · ${config.model}`:'Chave não configurada';
      badge.className='conn-badge '+(config.configured?'ok':'off');
      badge.title=config.configured?'':(window.chaveSintese?'Digite a chave da Anthropic acima e clique em Salvar chave.':'Preencha ANTHROPIC_API_KEY no .env local e reinicie o servidor.');
      if(config.version)$('appVersion').textContent=`v${config.version}`;
      chaveOk=Boolean(config.configured);refresh();
      return config;
    }).catch(()=>{const badge=$('hubConnection');badge.textContent='Servidor indisponível';badge.className='conn-badge off';});
  }
  atualizarConexao();
  // No aplicativo instalado (Electron), a chave é digitada aqui e guardada com a proteção de
  // credenciais do sistema operacional — quando o computador a oferece. Onde não oferece (Linux sem
  // chaveiro), o cofre grava em arquivo comum: a tela diz isso em vez de prometer criptografia.
  // Fora do Electron (navegador comum, ensaios automatizados) esta ponte não existe: o texto sobre
  // o .env permanece a explicação.
  if(window.chaveSintese){
    $('hubApiKeyBox').hidden=false;
    $('hubApiKeyEnvNote').hidden=true;
    const mostrarNotaDoCofre=estado=>{
      const nota=$('hubCofreNota');
      if(typeof estado?.criptografada!=='boolean'){nota.hidden=true;return;}
      nota.textContent=estado.criptografada
        ?'Neste computador a chave é guardada com a proteção de credenciais do sistema operacional.'
        :'Atenção: este computador não oferece proteção de credenciais do sistema (no Linux, falta o chaveiro). A chave ficaria em um arquivo comum, legível por quem usa este computador.';
      nota.className=estado.criptografada?'evidence':'evidence warn';nota.hidden=false;
    };
    window.chaveSintese.status().then(mostrarNotaDoCofre).catch(()=>{});
    $('hubApiKeySave').onclick=async()=>{
      const valor=$('hubApiKeyInput').value.trim();
      if(!valor){onStatus('Digite a chave antes de salvar.',true);return;}
      try{
        const estado=await window.chaveSintese.salvar(valor);$('hubApiKeyInput').value='';await atualizarConexao();mostrarNotaDoCofre(estado);
        onStatus(estado?.criptografada===false?'Chave salva, mas em arquivo comum: este computador não oferece proteção de credenciais do sistema.':'Chave salva com a proteção de credenciais do sistema operacional.');
      }
      catch(error){onStatus(error.message||'Não foi possível salvar a chave.',true);}
    };
    $('hubApiKeyForget').onclick=async()=>{
      await window.chaveSintese.esquecer();await atualizarConexao();onStatus('Chave da síntese esquecida.');
    };
  }
  render();
  return {
    refresh,
    // true/false depois que o servidor respondeu; null enquanto não se sabe.
    chaveConfigurada(){return chaveOk;},
    // Usado por quem precisa de uma entrega estruturada da base aprovada fora do par fixo
    // "mensagem"/"resumo" (ex.: os campos da Etapa 6) — mesma trava de segurança, sem side effect
    // de status na tela: quem chama decide onde colocar o resultado.
    baseAprovada(){return busy?false:Boolean(state.approval&&sameSources()&&$('hubConsent').checked);},
    async deliverRaw(kind){
      consent();if(!state.approval||!sameSources())throw Error('Aprove a base em "3 · Base revisada" antes.');
      return request('/api/deliver',{kind,base:structuredClone(state.base),approval:state.approval,consent:true});
    },
    reset(){epoch++;for(const controller of requests)controller.abort();busy=false;state=blank();$('hubApprove').checked=false;$('hubConsent').checked=false;render();},
    snapshot(){return structuredClone({...state,approval:null});},
    restore(saved){
      this.reset();if(!saved)return;
      // base é null quando a consulta foi salva antes de gerar qualquer síntese — estado válido,
      // não um erro. Só valida o formato dos itens quando de fato existe uma base.
      if(saved.version!==1||!saved.outputs||(saved.base!==null&&!Array.isArray(saved.base?.itens)))throw Error('Estado da base inválido.');
      if(saved.base&&saved.base.itens.some(x=>!['fato','conduta','pendencia'].includes(x.tipo)||typeof x.texto!=='string'||!Array.isArray(x.origens)||x.origens.some(o=>typeof o.trecho!=='string'||typeof o.fonte!=='string')))throw Error('Itens da base inválidos.');
      state=structuredClone(saved);state.approval=null;
      // Uma entrega salva como pronta continua pronta: se a base ou as fontes mudarem depois, a
      // revisão (ou sameSources) já a marca como versão anterior. Marcar tudo como "stale" aqui
      // deixava a tela dizendo "Rascunho pronto" depois de reaprovar a base, com a caixa "Conferi esta
      // entrega" travada para sempre — só regenerar (e pagar de novo) destravava.
      for(const kind of ['mensagem','resumo'])if(state.outputs[kind]){const saida=state.outputs[kind];if(typeof saida.texto!=='string')saida.texto='';saida.status=saida.status==='ready'&&saida.texto.trim()?'ready':'stale';}
      render();
    }
  };
}
