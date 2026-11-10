// Pequenos auxiliares de interface compartilhados entre app.mjs e hub.mjs. Sem estado próprio.

// Lista de elementos (para lista de texto simples, ver reportList em app.mjs) com "Mostrar mais N":
// uma consulta real gera muito mais itens que o exemplo fictício, e mostrar tudo de uma vez obriga
// a rolar a página inteira para conferir cada um.
export function renderComVerMais(target,elementos,{max=6}={}){
  for(const el of elementos.slice(0,max))target.append(el);
  if(elementos.length<=max)return;
  const resto=document.createElement('div');resto.hidden=true;
  for(const el of elementos.slice(max))resto.append(el);
  target.append(resto);
  const restante=elementos.length-max;
  const toggle=document.createElement('button');toggle.type='button';toggle.className='secondary';
  toggle.textContent=`Mostrar mais ${restante}`;
  toggle.onclick=()=>{const abrir=resto.hidden;resto.hidden=!abrir;toggle.textContent=abrir?'Mostrar menos':`Mostrar mais ${restante}`;};
  target.append(toggle);
}
