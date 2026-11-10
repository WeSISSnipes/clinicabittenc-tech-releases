import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {loadEnvFile} from 'node:process';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createClinicalService,validateBase} from './clinical-api.mjs';
import {createPatientsStore} from './patients-store.mjs';
import {createGeminiScribeService} from './gemini-scribe.mjs';
import {createUpdaterService} from './updater.mjs';

// Só para conferência entre quem desenvolve e quem usa — mostrado em /api/status e na barra de
// status. Não afeta nenhum comportamento do aplicativo.
const APP_VERSION = JSON.parse(await readFile(new URL('./package.json', import.meta.url))).version;

// Endereços de API que o navegador pode alcançar. Um provedor novo entra aqui, de propósito:
// a lista existe para que a página não consiga falar com qualquer servidor da internet.
const PROVEDORES_PERMITIDOS = [
  'https://generativelanguage.googleapis.com',
  'https://api.anthropic.com',
  'https://api.deepseek.com',
  'https://api.openai.com',
  'https://dashscope-intl.aliyuncs.com',
  'https://api.moonshot.cn',
  'https://open.bigmodel.cn',
].join(' ');
const routes = new Map([
  ['/', ['app/index.html', 'text/html']],
  ...['app.mjs', 'core.mjs', 'summary.mjs', 'review.mjs', 'exams.mjs', 'pdf.mjs', 'bioimpedancia.mjs', 'draft.mjs', 'ai.mjs', 'providers.mjs', 'bloco.mjs', 'hub.mjs', 'wizard.mjs', 'sources.mjs', 'pacientes.mjs', 'ui.mjs', 'icons.mjs', 'scribe.mjs']
    .map(f => [`/app/${f}`, [`app/${f}`, 'text/javascript']]),
  ['/app/app.css', ['app/app.css', 'text/css']],
  ['/templates/resumo-template.html', ['templates/resumo-template.html', 'text/plain']],
  ...['consulta-ficticia.html', 'consulta-ficticia-sem-atual.html', 'fala-ficticia.txt', 'exames-ficticios.txt', 'bioimpedancia-ficticia.txt', 'evolucao-meta-ficticia.txt',
    'fala-ficticia-rica.txt', 'exames-ficticios-formato2.txt', 'bio-completa-ficticia.txt', 'interpretacao-ficticia.txt']
    .map(f => [`/examples/${f}`, [`examples/${f}`, 'text/plain']]),
  ['/examples/exames-ficticios.pdf', ['examples/exames-ficticios.pdf', 'application/pdf']],
  ['/vendor/pdfjs/pdf.mjs', ['node_modules/pdfjs-dist/build/pdf.mjs', 'text/javascript']],
  ['/vendor/pdfjs/pdf.worker.mjs', ['node_modules/pdfjs-dist/build/pdf.worker.mjs', 'text/javascript']],
  ...['FoxitDingbats.pfb', 'FoxitFixed.pfb', 'FoxitFixedBold.pfb', 'FoxitFixedBoldItalic.pfb', 'FoxitFixedItalic.pfb', 'FoxitSerif.pfb', 'FoxitSerifBold.pfb', 'FoxitSerifBoldItalic.pfb', 'FoxitSerifItalic.pfb', 'FoxitSymbol.pfb', 'LiberationSans-Bold.ttf', 'LiberationSans-BoldItalic.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-Regular.ttf']
    .map(f => [`/vendor/pdfjs/standard_fonts/${f}`, [`node_modules/pdfjs-dist/standard_fonts/${f}`, 'application/octet-stream']]),
]);
const REPO_ROOT=fileURLToPath(new URL('.',import.meta.url));
function escolherPastaWindows(pastaInicial=''){
  return new Promise(resolve=>{
    if(process.platform!=='win32'){resolve('');return;}
    const script=`Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Escolha a pasta principal de Pacientes (ex.: OneDrive\\...\\Pacientes)'; $f.ShowNewFolderButton = $true; if (${JSON.stringify(pastaInicial)} -and (Test-Path ${JSON.stringify(pastaInicial)})) { $f.SelectedPath = ${JSON.stringify(pastaInicial)} }; $top = New-Object System.Windows.Forms.Form; $top.TopMost = $true; if ($f.ShowDialog($top) -eq 'OK') { [Console]::Out.Write($f.SelectedPath) }`;
    const proc=spawn('powershell.exe',['-NoProfile','-STA','-Command',script],{windowsHide:true});
    let out='';
    proc.stdout.on('data',d=>{out+=d.toString('utf8');});
    proc.on('error',()=>resolve(''));
    proc.on('close',()=>resolve(out.trim()));
  });
}
export function makeServer({clinical=createClinicalService(),gemini=createGeminiScribeService({apiKeyPath:fileURLToPath(new URL('./.env',import.meta.url))}),patients=createPatientsStore({configPath:fileURLToPath(new URL('./dados.config.json',import.meta.url)),repoRoot:REPO_ROOT}),updater=createUpdaterService({appRoot:REPO_ROOT})}={}) {
  const secret=randomBytes(32);
  let active=0;
  const sign=base=>createHmac('sha256',secret).update(JSON.stringify(base)).digest('hex');
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  return createServer(async (req, res) => {
    if (![ `127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}` ].includes(req.headers.host)) {
      res.writeHead(403); return res.end();
    }
    if(req.url==='/api/status'&&req.method==='GET')return json(res,200,{configured:await clinical.estaConfigurado(),model:clinical.model,geminiConfigured:await gemini.estaConfigurado(),geminiModel:gemini.model,version:(await updater.lerVersaoLocal())||APP_VERSION});
    if(req.url==='/api/pacientes/config'&&req.method==='GET')return json(res,200,{pasta:await patients.obterPasta()});
    if(req.url==='/api/pacientes/pastas-referencia'&&req.method==='GET')return json(res,200,{pastas:await patients.listarPastasReferencia()});
    if(req.url?.startsWith('/api/')){
      if(req.method!=='POST'||req.headers.origin!==`http://${req.headers.host}`||req.headers['x-clinical-request']!=='1'||req.headers['content-type']!=='application/json')return json(res,403,{error:'Solicitação local não autorizada.'});
      const ROTAS_PACIENTES=['/api/pacientes/config','/api/pacientes/escolher-pasta','/api/pacientes/listar','/api/pacientes/paciente','/api/pacientes/consultas','/api/pacientes/salvar','/api/pacientes/abrir','/api/pacientes/registrar-nascimento','/api/pacientes/exportar-documentos'];
      const ROTAS_SCRIBE=['/api/scribe/key','/api/scribe/verify','/api/scribe/process'];
      const ROTAS_APP=['/api/app/check-update','/api/app/update'];
      if(![...ROTAS_PACIENTES,...ROTAS_SCRIBE,...ROTAS_APP,'/api/synthesize','/api/approve','/api/deliver'].includes(req.url))return json(res,404,{error:'Rota desconhecida.'});
      if(active>=3)return json(res,429,{error:'Há solicitações em andamento. Aguarde.'});
      active++;
      try{
        // Salvar uma consulta aceita até 40 MB; enviar áudio gravado longo (até 1h30) aceita até 250 MB; as demais continuam em 2 MB.
        const rotaAudio=req.url==='/api/scribe/process'||req.url==='/api/pacientes/exportar-documentos';
        const salvando=req.url==='/api/pacientes/salvar';
        const teto=rotaAudio?250_000_000:salvando?40_000_000:2_000_000;
        let length=0;const chunks=[];
        for await(const chunk of req){length+=chunk.length;if(length>teto)throw Error(rotaAudio?'O arquivo de áudio excede 250 MB.':salvando?'Esta consulta é maior que 40 MB e não cabe no histórico. Use "Salvar sessão" para guardá-la em arquivo, ou remova PDFs muito grandes.':'Solicitação maior que o limite de 2 MB.');chunks.push(chunk);}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('Solicitação JSON inválida.');}
        if(req.url==='/api/pacientes/config')return json(res,200,{pasta:await patients.definirPasta(body.pasta)});
        if(req.url==='/api/pacientes/escolher-pasta'){
          const atual=(await patients.obterPasta())||'';
          const escolhida=await escolherPastaWindows(atual);
          if(!escolhida)return json(res,200,{cancelado:true,pasta:atual});
          return json(res,200,{cancelado:false,pasta:await patients.definirPasta(escolhida)});
        }
        if(req.url==='/api/pacientes/listar')return json(res,200,{pacientes:await patients.listarPacientes()});
        if(req.url==='/api/pacientes/paciente')return json(res,200,{paciente:await patients.obterPaciente(body.id)});
        if(req.url==='/api/pacientes/consultas')return json(res,200,{consultas:await patients.listarConsultas(body.id)});
        if(req.url==='/api/pacientes/salvar')return json(res,200,await patients.salvarConsulta({nome:body.nome,nascimento:body.nascimento},body.dados));
        if(req.url==='/api/pacientes/abrir')return json(res,200,{dados:await patients.lerConsulta(body.id,body.arquivo)});
        if(req.url==='/api/pacientes/registrar-nascimento')return json(res,200,await patients.registrarNascimento(body.id,{nome:body.nome,nascimento:body.nascimento}));
        if(req.url==='/api/pacientes/exportar-documentos')return json(res,200,await patients.exportarDocumentosPaciente(body));
        if(req.url==='/api/scribe/key')return json(res,200,{configured:await gemini.definirChave(body.apiKey),valid:true});
        if(req.url==='/api/scribe/verify')return json(res,200,await gemini.validarChave(undefined,{forcar:Boolean(body?.forcar)}));
        if(req.url==='/api/scribe/process')return json(res,200,await gemini.processarConsulta(body));
        if(req.url==='/api/app/check-update')return json(res,200,await updater.verificarAtualizacao());
        if(req.url==='/api/app/update')return json(res,200,await updater.aplicarAtualizacao({forcar:Boolean(body?.forcar)}));
        if(req.url==='/api/approve'){
          if(body.approved!==true)throw Error('Revise e aprove a base.');
          const base=validateBase(body.base);return json(res,200,{approval:sign(base)});
        }
        if(body.consent!==true)throw Error('Autorize o envio à Anthropic.');
        if(req.url==='/api/synthesize')return json(res,200,{base:await clinical.synthesize(body.sources)});
        const base=validateBase(body.base),expected=Buffer.from(sign(base)),actual=Buffer.from(typeof body.approval==='string'?body.approval:'');
        if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('A base foi alterada ou o servidor reiniciou. Aprove novamente.');
        return json(res,200,await clinical.deliver(body.kind,base));
      }catch(error){return json(res,400,{error:error.message||'Falha na operação.'});}
      finally{active--;}
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(403);return res.end();}
    const entry = routes.get(req.url);
    if (!entry) { res.writeHead(404); return res.end('Não encontrado'); }
    try {
      const body = await readFile(new URL(entry[0], import.meta.url));
      res.writeHead(200, {
        'Content-Type': `${entry[1]}; charset=utf-8`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${PROVEDORES_PERMITIDOS}; worker-src 'self'; frame-src 'self' blob:; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(500); res.end('Falha ao carregar recurso local.'); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try{loadEnvFile(new URL('.env',import.meta.url));}catch(error){if(error.code!=='ENOENT')throw Error('Não foi possível ler a configuração local.');}
  const server = makeServer();
  const port=Number(process.env.PORT||4175);
  server.on('error', () => { console.error(`Não foi possível iniciar. Verifique se a porta ${port} está livre.`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Aplicativo local: http://127.0.0.1:${port} — Ctrl+C para encerrar.`));
}
