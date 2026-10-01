/* Site institucional PAY AX: rotas, menus, simulação do painel, calculadora e busca da Ajuda. */
(function(){
  // ---- templates
  document.querySelectorAll('[data-cta]').forEach(el=>el.appendChild(document.getElementById('tpl-cta').content.cloneNode(true)));
  document.querySelectorAll('[data-contact]').forEach(el=>el.appendChild(document.getElementById('tpl-contact').content.cloneNode(true)));

  // ---- router
  const routes={inicio:'inicio',solucoes:'solucoes',conta:'solucoes',pix:'solucoes',boletos:'solucoes',cobranca:'solucoes',baas:'solucoes','api-pix':'solucoes','api-boletos':'solucoes',provedores:'provedores',integracao:'integracao',desenvolvedores:'desenvolvedores',ajuda:'ajuda',sobre:'sobre','abrir-conta':'abrir-conta',acessar:'acessar'};
  const pages=[...document.querySelectorAll('.page')];
  const segLinks=document.querySelectorAll('.topbar .seg a');
  function go(){
    const key=(location.hash||'#inicio').slice(1);
    const page=routes[key]||'inicio';
    pages.forEach(p=>{p.hidden=p.dataset.page!==page});
    document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===page));
    segLinks.forEach(a=>a.toggleAttribute('aria-current',(page==='provedores')===(a.getAttribute('href')==='#provedores')));
    closeAll(); drawer.hidden=true; document.body.style.overflow='';
    const target=(key!==page)?document.getElementById(key):null;
    requestAnimationFrame(()=>{
      if(target){const y=target.getBoundingClientRect().top+window.scrollY-90;window.scrollTo({top:y,behavior:'smooth'});}
      else window.scrollTo({top:0});
    });
  }
  // ---- dropdowns
  const drops=[...document.querySelectorAll('[data-drop]')];
  function closeAll(){drops.forEach(b=>{b.parentElement.classList.remove('open');b.setAttribute('aria-expanded','false')})}
  drops.forEach(b=>{
    const li=b.parentElement;
    b.addEventListener('click',e=>{e.stopPropagation();const o=!li.classList.contains('open');closeAll();if(o){li.classList.add('open');b.setAttribute('aria-expanded','true')}});
    li.addEventListener('mouseenter',()=>{if(matchMedia('(hover:hover)').matches){closeAll();li.classList.add('open');b.setAttribute('aria-expanded','true')}});
    li.addEventListener('mouseleave',()=>{if(matchMedia('(hover:hover)').matches){li.classList.remove('open');b.setAttribute('aria-expanded','false')}});
  });
  document.addEventListener('click',closeAll);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeAll();drawer.hidden=true;document.body.style.overflow=''}});
  // ---- drawer
  const drawer=document.getElementById('drawer');
  document.getElementById('burger').addEventListener('click',()=>{drawer.hidden=false;document.body.style.overflow='hidden'});
  document.getElementById('closeDrawer').addEventListener('click',()=>{drawer.hidden=true;document.body.style.overflow=''});
  window.addEventListener('hashchange',go); go();

  // ---- hero: tilt + glow
  const stage=document.getElementById('stage'),card=document.getElementById('card'),hero=document.getElementById('hero');
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!reduce){
    hero.addEventListener('pointermove',e=>{
      const s=stage.getBoundingClientRect();
      const x=(e.clientX-(s.left+s.width/2))/s.width, y=(e.clientY-(s.top+s.height/2))/s.height;
      card.style.setProperty('--ry',(x*22)+'deg');card.style.setProperty('--rx',(-y*16)+'deg');
    });
    hero.addEventListener('pointerleave',()=>{card.style.setProperty('--ry','-14deg');card.style.setProperty('--rx','8deg')});
  }
  // ---- hero: simulated feed
  const feed=document.getElementById('feed');
  const items=[
    ['PIX recebido','Fatura #20841 · baixada no IXC','+ R$ 99,90'],
    ['Boleto pago','Fatura #20796 · baixado no IXC','+ R$ 129,90'],
    ['PIX recebido','Fatura #20903 · cliente liberado','+ R$ 79,90'],
    ['PIX recebido','Fatura #20912 · baixada no IXC','+ R$ 149,90'],
    ['Boleto pago','Fatura #20877 · baixado no IXC','+ R$ 109,90']
  ];
  const icon='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  let i=0;
  function push(){
    const [t,s,v]=items[i++%items.length];
    const el=document.createElement('div');el.className='toast';
    el.innerHTML='<span class="ic">'+icon+'</span><span class="t"><b></b><small></small></span><span class="v"></span>';
    el.querySelector('b').textContent=t;el.querySelector('small').textContent=s;el.querySelector('.v').textContent=v;
    feed.appendChild(el);
    while(feed.children.length>2) feed.firstElementChild.remove();
  }
  push();push();
  if(!reduce) setInterval(push,3200);

  // ---- calculator
  const fmt=new Intl.NumberFormat('pt-BR'),brl=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0});
  const $=id=>document.getElementById(id);
  function calc(){
    const f=+$('c-fat').value,m=+$('c-min').value,h=+$('c-hora').value;
    const horas=f*m/60;
    $('o-fat').textContent=fmt.format(f);
    $('o-min').textContent=m.toLocaleString('pt-BR')+' min';
    $('o-hora').textContent=brl.format(h);
    $('r-horas').textContent=fmt.format(Math.round(horas))+' h';
    $('r-dias').textContent=(horas/8).toLocaleString('pt-BR',{maximumFractionDigits:1});
    $('r-custo').textContent=brl.format(horas*h);
  }
  ['c-fat','c-min','c-hora'].forEach(id=>$(id).addEventListener('input',calc));calc();

  // ---- code tabs
  document.querySelectorAll('[data-code]').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('[data-code]').forEach(x=>x.setAttribute('aria-selected',x===b));
    document.querySelectorAll('[data-code-pane]').forEach(p=>p.hidden=p.dataset.codePane!==b.dataset.code);
  }));

  // ---- faq search
  const q=$('faq-q');
  q.addEventListener('input',()=>{
    const t=q.value.trim().toLowerCase();let n=0;
    document.querySelectorAll('#faq details').forEach(d=>{const hit=!t||d.textContent.toLowerCase().includes(t);d.hidden=!hit;if(hit)n++;if(t&&hit)d.open=true});
    $('faq-empty').hidden=n>0;
  });

  // ---- Internet Banking por cima do site
  // "Acessar minha conta" abre a caixa de acesso (CPF e teclado virtual) sobre o site; depois de entrar,
  // o Internet Banking ocupa a tela inteira. "Abra sua conta" abre o assistente de abertura de conta.
  const IB_URL=window.PAYAX_IB||'../ib/index.html';
  let janela=null;
  function abrirIB(rota){
    if(!janela){
      janela=document.createElement('div');janela.className='ib-sobre';
      janela.innerHTML='<iframe title="Internet Banking PAY AX"></iframe>';
      document.body.appendChild(janela);
    }
    janela.classList.remove('logado');drawer.hidden=true;
    janela.querySelector('iframe').src=IB_URL+'?embutido=1'+(rota||'');
    document.body.style.overflow='hidden';
    requestAnimationFrame(()=>janela.querySelector('iframe').focus());
  }
  function fecharIB(){
    if(!janela) return;
    janela.remove();janela=null;document.body.style.overflow='';
  }
  window.addEventListener('message',e=>{
    if(!janela||e.source!==janela.querySelector('iframe').contentWindow) return;
    const ev=e.data&&e.data.payax;
    if(ev==='fechar') fecharIB();
    else if(ev==='logado') janela.classList.add('logado');
    else if(ev==='deslogado') janela.classList.remove('logado');
  });
  document.addEventListener('click',e=>{
    const a=e.target.closest('a[href="#acessar"],#ib-link,a[href="#abrir-conta"]');
    if(!a) return;
    e.preventDefault();
    abrirIB(a.getAttribute('href')==='#abrir-conta'?'#/abrir-conta':'');
  });
  const ib=$('ib-link');
  ib.href='#acessar';ib.removeAttribute('aria-disabled');$('ib-note').textContent='O acesso abre no ambiente seguro da PAY AX.';
  // Sessão aberta (ex.: página recarregada): volta direto para o Internet Banking.
  try{ if(sessionStorage.getItem('payax.ib.sessao')) abrirIB(''); }catch(_){}
})();
