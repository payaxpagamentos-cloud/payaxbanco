import { esc, icon, request, toast } from './shared.js';
import { LOGO } from './limites.js';
let c, currentBanner = 0, timers = [], lastCep = '';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const money = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
const action = (key, label, type = 'glass-button', svg = '') => `<button type="button" class="${type}" data-action="${key}">${svg ? icon(svg) : ''}<span>${esc(label)}</span></button>`;

async function boot() {
  try {
    const preview = new URLSearchParams(location.search).get('preview') === '1';
    const result = await request(preview ? '/api/admin/preview' : '/api/site'); c = result.config;
    if (preview) { c.banners = c.banners.filter(v => v.active); c.plans = c.plans.filter(v => v.active); }
    document.title = c.seo.title; document.querySelector('meta[name="description"]').content = c.seo.description;
    render(preview); wire();
  } catch { document.querySelector('#site').innerHTML = '<main class="load-error"><h1>Estamos preparando sua conexão.</h1><p>Não foi possível carregar o site neste momento.</p><button class="primary" id="reload">Tentar novamente</button></main>'; document.querySelector('#reload').addEventListener('click', boot); }
}
function render(preview) {
  const banner = c.banners[0], logo = `<img class="logo" src="${LOGO}" alt="${esc(c.brand.name)}" width="190" height="65">`;
  document.querySelector('#site').innerHTML = `
    ${preview ? '<div class="preview-bar">Prévia do rascunho — visível apenas para quem está no painel.</div>' : ''}
    <header class="header glass container"><a href="#inicio" aria-label="${esc(c.brand.name)} — início">${logo}</a>
      <button class="mobile-toggle" aria-label="Abrir menu" aria-expanded="false" aria-controls="navigation">${icon('menu')}</button>
      <nav id="navigation" aria-label="Menu principal"><a class="nav-active" href="#inicio">Início</a><a href="#planos">Planos</a><a href="#cobertura">Cobertura</a><a href="#atendimento">Atendimento</a></nav>
      ${action('account', 'Área do cliente', 'glass-button header-account', 'user')}
    </header>
    <main id="conteudo">
      <section class="hero container" id="inicio" aria-label="Destaques da LK TECH" aria-roledescription="carrossel">
        <picture class="hero-picture"><source id="hero-mobile" media="(max-width: 700px)" srcset="${esc(banner.mobileImage || banner.image)}"><img id="hero-image" src="${esc(banner.image)}" alt="" fetchpriority="high" width="1800" height="1000"></picture>
        <div class="hero-shade"></div><div class="hero-content" id="hero-copy">${c.banners.map((b, i) => `<div class="hero-slide${i ? '' : ' ativo'}"${i ? ' aria-hidden="true" inert' : ''}>${heroCopy(b)}</div>`).join('')}</div>
        <div class="hero-badge glass">${icon('network')}<span>${esc(c.hero.badge)}</span></div>
        ${c.banners.length > 1 ? `<div class="hero-controls glass"><button id="banner-prev" aria-label="Banner anterior">${icon('chevron','flip')}</button><div id="banner-dots">${c.banners.map((b,i) => `<button class="dot ${i===0?'active':''}" data-banner="${i}" aria-label="Ir para banner ${i+1}" ${i===0?'aria-current="true"':''}></button>`).join('')}</div><button id="banner-next" aria-label="Próximo banner">${icon('chevron')}</button><button id="banner-pause" aria-label="Pausar rotação dos banners" aria-pressed="false">Ⅱ</button></div>` : ''}
      </section>
      <div class="utility glass container">${action('coverage','Consultar cobertura','utility-item','pin')}${action('invoice','2ª via da fatura','utility-item','invoice')}${action('contact','Falar com a equipe','utility-item','headset')}</div>
      <section class="plans container section" id="planos" aria-labelledby="plans-title"><span class="section-rule"></span><h2 id="plans-title">${esc(c.plansSection.title)}</h2><p class="section-subtitle">${esc(c.plansSection.subtitle)}</p>
        <div class="carousel" aria-roledescription="carrossel" aria-label="Planos de internet"><button class="carousel-arrow prev glass" id="plan-prev" aria-label="Planos anteriores">${icon('chevron','flip')}</button><div class="plan-track" id="plan-track" tabindex="0" aria-label="Deslize para ver os planos">${c.plans.map(planCard).join('')}</div><button class="carousel-arrow next glass" id="plan-next" aria-label="Próximos planos">${icon('chevron')}</button></div>
        <div class="plan-dots" id="plan-dots" aria-label="Páginas do carrossel"></div><p class="plan-note">${esc(c.plansSection.note)}</p>
      </section>
      <section class="service-section container section" id="atendimento"><div><span class="section-rule"></span><h2 class="multiline">${esc(c.services.title)}</h2><p class="section-subtitle">${esc(c.services.description)}</p></div><div class="service-actions">${action('contact',c.services.first,'service-link glass','headset')}${action('account',c.services.second,'service-link glass','user')}</div></section>
      <section class="coverage container" id="cobertura" aria-labelledby="coverage-title"><div class="coverage-copy"><h2 id="coverage-title">${esc(c.coverage.title)}</h2><p>${esc(c.coverage.subtitle)}</p><form id="coverage-form"><label class="sr-only" for="cep">Digite seu CEP</label><input id="cep" name="cep" placeholder="Digite seu CEP" inputmode="numeric" autocomplete="postal-code" maxlength="9" pattern="[0-9]{5}-?[0-9]{3}" required><button type="submit" class="primary">Consultar</button></form><div id="coverage-result" role="status" aria-live="polite"></div></div><div class="map-art" aria-hidden="true"><span class="map-plane"></span>${icon('pin')}</div></section>
      <section class="customer container section"><span class="section-rule"></span><h2>${esc(c.customer.title)}</h2><div class="customer-actions">${action('account',c.customer.account,'customer-link glass','user')}${action('invoice',c.customer.invoice,'customer-link glass','invoice')}${action('support',c.customer.support,'customer-link glass','headset')}</div></section>
      ${c.faqs.length ? `<section class="faq container section"><h2>Podemos ajudar?</h2>${c.faqs.map(v=>`<details class="glass"><summary>${esc(v.question)}</summary><p>${esc(v.answer)}</p></details>`).join('')}</section>` : ''}
    </main>
    <footer class="container footer"><div class="footer-brand">${logo}<p>${esc(c.brand.tagline)}</p></div><nav aria-label="Rodapé"><a href="#planos">Planos</a><a href="#atendimento">Atendimento</a>${action('account','Área do cliente','text-button')}</nav>${c.contact.phone || c.contact.email || c.contact.address ? `<div class="footer-contact">${c.contact.phone?`<span>${esc(c.contact.phone)}</span>`:''}${c.contact.email?`<a href="mailto:${esc(c.contact.email)}">${esc(c.contact.email)}</a>`:''}${c.contact.address?`<span>${esc(c.contact.address)}</span>`:''}</div>`:''}${c.contact.privacyUrl?`<a href="${esc(c.contact.privacyUrl)}">Privacidade</a>`:''}</footer>
    <button class="floating-contact primary" data-action="contact" aria-label="Falar com a LK TECH">${icon('chat')}</button>`;
  document.querySelector('#hero-image').style.objectPosition = banner.imagePosition;
}
function heroCopy(b) { return `<p class="eyebrow">${esc(b.eyebrow)}</p><h1>${esc(b.title)} <strong>${esc(b.highlight)}</strong></h1><span class="section-rule"></span><p class="hero-subtitle">${esc(b.subtitle)}</p><div class="hero-buttons">${b.primaryLabel?`<a class="primary" href="${esc(b.primaryUrl || '#planos')}"><span>${esc(b.primaryLabel)}</span></a>`:''}${b.secondaryLabel?`<a class="glass-button" href="${esc(b.secondaryUrl || '#cobertura')}"><span>${esc(b.secondaryLabel)}</span></a>`:''}</div>`; }
function planCard(p) {
  return `<article class="plan-card glass ${p.featured?'featured':''}" data-plan-id="${esc(p.id)}"><div class="plan-label">${icon('router')}<span>${esc(p.label)}</span></div><h3 title="${esc(p.name)}">${esc(p.name)}</h3><p class="plan-description">${esc(p.description)}</p><div class="plan-price">${p.price === null ? 'Valores sob consulta' : `<strong>${money(p.price)}</strong><span>${esc(p.priceSuffix)}</span>`}</div>${p.features.length?`<ul>${p.features.map(v=>`<li>${icon('check')}<span>${esc(v)}</span></li>`).join('')}</ul>`:''}${p.terms?`<p class="plan-terms">${esc(p.terms)}</p>`:''}<button class="${p.featured?'primary':'glass-button'} plan-cta" data-plan="${esc(p.id)}"><span>${esc(p.button)}</span></button></article>`;
}
function showBanner(index) {
  currentBanner = (index + c.banners.length) % c.banners.length;
  const b = c.banners[currentBanner];
  document.querySelectorAll('.hero-slide').forEach((el, i) => { const ativo = i === currentBanner; el.classList.toggle('ativo', ativo); el.toggleAttribute('inert', !ativo); if (ativo) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', 'true'); });
  document.querySelector('#hero-image').src = b.image; document.querySelector('#hero-image').style.objectPosition = b.imagePosition;
  document.querySelector('#hero-mobile').srcset = b.mobileImage || b.image;
  document.querySelectorAll('[data-banner]').forEach((el,i)=>{ el.classList.toggle('active',i===currentBanner); if(i===currentBanner)el.setAttribute('aria-current','true');else el.removeAttribute('aria-current'); });
}
function openContact(plan = '') {
  const dialog = document.querySelector('#contact-dialog');
  dialog.innerHTML = `<button type="button" class="dialog-close" aria-label="Fechar">${icon('close')}</button><p class="eyebrow">FALE COM A LK TECH</p><h2 id="contact-title">Vamos conectar você.</h2><p>Deixe seu contato para nossa equipe falar com você.</p><form id="lead-form"><label>Seu nome<input name="name" autocomplete="name" maxlength="100" required></label><label>Telefone com DDD<input name="phone" type="tel" autocomplete="tel" maxlength="20" required></label><label>CEP <span class="muted">(opcional)</span><input name="cep" inputmode="numeric" autocomplete="postal-code" maxlength="9" value="${esc(lastCep)}"></label><input type="hidden" name="plan" value="${esc(plan)}"><div class="honeypot" aria-hidden="true"><label>Site<input name="website" tabindex="-1" autocomplete="off"></label></div><label class="consent"><input type="checkbox" name="consent" required><span>Autorizo a LK TECH a entrar em contato sobre este pedido.${c.contact.privacyUrl?` <a href="${esc(c.contact.privacyUrl)}" target="_blank" rel="noopener">Privacidade</a>`:''}</span></label><p class="form-error" role="alert"></p><button class="primary" type="submit">Solicitar contato</button></form>`;
  dialog.querySelector('.dialog-close').addEventListener('click',()=>dialog.close());
  dialog.showModal();
  dialog.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault(); const form = event.currentTarget, button=form.querySelector('[type=submit]'); button.disabled=true;
    try { const data = Object.fromEntries(new FormData(form)); data.consent=form.elements.consent.checked; const result=await request('/api/leads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); dialog.close();toast(result.message || 'Pedido enviado.'); }
    catch(e){form.querySelector('.form-error').textContent=e.message;} finally {button.disabled=false;}
  });
}
function contact(plan = '') {
  if (c.contact.whatsapp) { const text = plan ? `Olá! Gostaria de saber mais sobre o plano ${plan} da LK TECH.` : 'Olá! Gostaria de falar com a equipe da LK TECH.'; window.open(`https://wa.me/${c.contact.whatsapp}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer'); }
  else openContact(plan);
}
function perform(key) {
  if (key==='coverage') return document.querySelector('#cobertura').scrollIntoView({behavior:reduced.matches?'instant':'smooth'});
  const url = { account:c.contact.portalUrl, invoice:c.contact.invoiceUrl || c.contact.portalUrl, support:c.contact.supportUrl }[key];
  if (url) window.open(url,'_blank','noopener,noreferrer'); else contact();
}
function wire() {
  const toggle=document.querySelector('.mobile-toggle'), nav=document.querySelector('#navigation');
  toggle.addEventListener('click',()=>{const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',open);nav.classList.toggle('open',open);});
  nav.addEventListener('click',()=>{nav.classList.remove('open');toggle.setAttribute('aria-expanded','false');});
  document.querySelector('#site').addEventListener('click',event=>{const el=event.target.closest('[data-action],[data-plan]');if(!el)return;if(el.hasAttribute('data-plan'))contact(c.plans.find(p=>p.id===el.dataset.plan)?.name || '');else perform(el.dataset.action);});
  document.querySelector('#coverage-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),result=document.querySelector('#coverage-result');button.disabled=true;try{lastCep=form.elements.cep.value;const data=await request('/api/coverage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cep:lastCep})});result.textContent=data.message;const next=document.createElement('button');next.className='coverage-next';next.type='button';next.textContent='Quero falar com a equipe';next.addEventListener('click',()=>openContact());result.append(next);}catch(e){result.textContent=e.message;}finally{button.disabled=false;}});
  document.querySelector('#cep').addEventListener('input',e=>{let v=e.target.value.replace(/\D/g,'').slice(0,8);e.target.value=v.length>5?v.slice(0,5)+'-'+v.slice(5):v;});
  let bannerPaused=false;
  const hero=document.querySelector('.hero');
  if(c.banners.length>1){document.querySelector('#banner-prev').addEventListener('click',()=>showBanner(currentBanner-1));document.querySelector('#banner-next').addEventListener('click',()=>showBanner(currentBanner+1));document.querySelectorAll('[data-banner]').forEach(el=>el.addEventListener('click',()=>showBanner(Number(el.dataset.banner))));document.querySelector('#banner-pause').addEventListener('click',event=>{bannerPaused=!bannerPaused;event.currentTarget.setAttribute('aria-pressed',bannerPaused);event.currentTarget.setAttribute('aria-label',bannerPaused?'Retomar rotação dos banners':'Pausar rotação dos banners');event.currentTarget.textContent=bannerPaused?'▶':'Ⅱ';});if(c.hero.autoplay&&!reduced.matches)timers.push(setInterval(()=>{if(!document.hidden&&!bannerPaused&&!hero.matches(':hover')&&!hero.contains(document.activeElement))showBanner(currentBanner+1);},c.hero.interval));}
  const track=document.querySelector('#plan-track'), prev=document.querySelector('#plan-prev'), next=document.querySelector('#plan-next'), dots=document.querySelector('#plan-dots');
  let step=1,maximum=0,selected=0;
  const move=index=>{const target=(index+maximum+1)%(maximum+1);track.scrollTo({left:target*step,behavior:reduced.matches?'instant':'smooth'});};
  const update=()=>{selected=Math.min(maximum,Math.round(track.scrollLeft/step));dots.querySelectorAll('button').forEach((b,i)=>{b.classList.toggle('active',i===selected);b.setAttribute('aria-current',i===selected?'true':'false');});};
  const resize=()=>{const card=track.firstElementChild;if(!card)return;step=card.getBoundingClientRect().width+parseFloat(getComputedStyle(track).columnGap);maximum=Math.max(0,Math.round((track.scrollWidth-track.clientWidth)/step));prev.disabled=next.disabled=maximum===0;dots.innerHTML=Array.from({length:maximum+1},(_,i)=>`<button class="dot" aria-label="Ir para grupo de planos ${i+1}" data-index="${i}"></button>`).join('');dots.hidden=maximum===0;update();};
  prev.addEventListener('click',()=>move(selected-1));next.addEventListener('click',()=>move(selected+1));dots.addEventListener('click',e=>{const b=e.target.closest('[data-index]');if(b)move(Number(b.dataset.index));});track.addEventListener('scroll',update,{passive:true});track.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();move(selected+(e.key==='ArrowRight'?1:-1));}});new ResizeObserver(resize).observe(track);resize();
  if(c.plansSection.autoplay&&!reduced.matches)timers.push(setInterval(()=>{if(!document.hidden&&!track.matches(':hover')&&!document.querySelector('.plans').contains(document.activeElement))move(selected+1);},c.plansSection.interval));
  const sections=document.querySelectorAll('main section[id]');const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)document.querySelectorAll('#navigation a').forEach(a=>a.classList.toggle('nav-active',a.hash==='#'+entry.target.id));},{rootMargin:'-15% 0px -60% 0px'});sections.forEach(el=>observer.observe(el));
}
window.addEventListener('pagehide',()=>timers.forEach(clearInterval));
boot();
