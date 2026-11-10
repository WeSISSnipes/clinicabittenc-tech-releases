export function installEditor(doc, win, onChange = () => {}) {
  let selected = null;
  const fields = [...doc.querySelectorAll('[data-field]')];
  doc.getElementById('resetBtn')?.remove();
  doc.getElementById('grifoToolbar')?.remove();
  const caption = doc.getElementById('modeCaption');
  caption.textContent = 'Edite e selecione um trecho para grifar. Salve o HTML antes de fechar; não há salvamento automático.';
  const toolbar = doc.querySelector('.toolbar-group:last-child');
  const highlight = doc.createElement('button'); highlight.textContent = 'Grifar / remover grifo'; highlight.type='button'; highlight.className='btn-primary'; highlight.id='highlightBtn'; toolbar.append(highlight);
  const save = doc.createElement('button'); save.textContent = 'Salvar HTML editado'; save.className='btn-primary'; save.id='saveHtmlBtn'; toolbar.append(save);
  const status=doc.createElement('span'); status.setAttribute('role','status'); toolbar.append(status);
  fields.forEach(field => {
    field.addEventListener('input', onChange);
    field.addEventListener('paste', event => {
      event.preventDefault(); const text=event.clipboardData.getData('text/plain');
      const selection=win.getSelection(); if(!selection.rangeCount) return;
      const range=selection.getRangeAt(0); if(!field.contains(range.commonAncestorContainer)) return;
      range.deleteContents(); range.insertNode(doc.createTextNode(text)); onChange();
    });
    field.addEventListener('drop', event => event.preventDefault());
  });
  const capture=() => {
    const selection=win.getSelection(); if(!selection?.rangeCount || selection.isCollapsed) return;
    const range=selection.getRangeAt(0), node=range.commonAncestorContainer;
    const el=node.nodeType===1 ? node : node.parentElement;
    if(el.closest('[contenteditable="true"]')) selected=range.cloneRange();
  };
  doc.addEventListener('mouseup',capture); doc.addEventListener('keyup',capture);
  highlight.addEventListener('mousedown', e=>e.preventDefault());
  highlight.addEventListener('click',()=>{
    if(!selected) return;
    const node=selected.commonAncestorContainer;
    const el=node.nodeType===1?node:node.parentElement;
    if(!el.closest('[contenteditable="true"]')) return;
    const old=el.closest('mark');
    if(old) old.replaceWith(...old.childNodes);
    else { const mark=doc.createElement('mark');mark.className='grifo';mark.append(selected.extractContents());selected.insertNode(mark); }
    selected=null; win.getSelection().removeAllRanges(); onChange();
  });
  for(const [id,editing] of [['modeEdit',true],['modeView',false]]) doc.getElementById(id).onclick=()=>{
    fields.forEach(f=>f.contentEditable=String(editing));doc.body.classList.toggle('edit-mode',editing);
    doc.getElementById('modeEdit').setAttribute('aria-pressed',String(editing));doc.getElementById('modeView').setAttribute('aria-pressed',String(!editing));
  };
  doc.getElementById('printBtn').onclick=()=>win.print();
  save.onclick=()=>{
    try {
      const copy=doc.documentElement.cloneNode(true);
      copy.querySelector('#highlightBtn')?.remove(); copy.querySelector('#saveHtmlBtn')?.remove();
      copy.querySelectorAll('[role="status"]').forEach(n=>n.remove());
      const blob=new Blob(['<!doctype html>\n'+copy.outerHTML],{type:'text/html;charset=utf-8'});
      const url=URL.createObjectURL(blob),a=doc.createElement('a');a.href=url;a.download='resumo_consulta_editado.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
      status.textContent='Download solicitado. Confira o arquivo salvo e imprima esta versão.';
    } catch { status.textContent='Falha ao salvar. Mantenha a página aberta e tente novamente.'; }
  };
  return { save, highlight };
}

export function buildSummary(template, data) {
  const doc=new DOMParser().parseFromString(template,'text/html');
  doc.querySelectorAll('script,link').forEach(el=>el.remove());
  doc.querySelector('.patient-name').textContent=data.patient;
  doc.querySelector('.patient-date').textContent=data.date.split('-').reverse().join('/')+' · '+data.patientType;
  for(const field of doc.querySelectorAll('[data-field]')) {
    const key=field.dataset.field;
    if(key==='obsobesidade' && !data.commercialEnabled) field.closest('section').remove();
    else field.textContent=data[key] || '';
  }
  // Trusted template CSS only. No font or resource requests in the delivered artifact.
  const style=doc.createElement('style');
  style.textContent=".doc-name{font-family:Georgia,serif}.eyebrow,.section-label,.signature,.toolbar,.patient-row{font-family:Arial,sans-serif}[data-field]{white-space:pre-wrap}@page{size:A4;margin:16mm}.frase-final,.signature{break-inside:avoid} .toolbar-group{gap:8px}";
  doc.head.append(style);
  const charset=doc.createElement('meta');charset.setAttribute('charset','utf-8');doc.head.prepend(charset);
  const csp=doc.createElement('meta'); csp.httpEquiv='Content-Security-Policy';csp.content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";doc.head.prepend(csp);
  doc.documentElement.lang='pt-BR';
  const script=doc.createElement('script');script.textContent=`(${installEditor.toString()})(document, window);`;doc.body.append(script);
  return '<!doctype html>\n'+doc.documentElement.outerHTML;
}

export function snapshotSummary(doc) {
  const copy=doc.documentElement.cloneNode(true);
  copy.querySelector('#highlightBtn')?.remove();copy.querySelector('#saveHtmlBtn')?.remove();
  copy.querySelectorAll('[role="status"]').forEach(n=>n.remove());
  return '<!doctype html>\n'+copy.outerHTML;
}
