#!/usr/bin/env python3
# Uso: python3 ferramentas/desenhar-ilustracoes.py public/img/ilustracoes
# Para um desenho novo: crie a funcao/chamada aqui, rode, e acrescente a regra em public/js/ilustracoes.js.
# Gera as ilustrações dos produtos (SVG). Estilo: vetor chapado com volume (degradês suaves),
# brilho branco e sombra no chão, sobre fundo transparente (o cartão já é branco).
import os, sys
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
SOMBRA = '<ellipse cx="120" cy="222" rx="{rx}" ry="9" fill="#0B1928" opacity=".13"/>'

def svg(nome, corpo, defs=''):
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><defs>{defs}</defs>{corpo}</svg>'
    with open(os.path.join(OUT, nome + '.svg'), 'w', encoding='utf-8') as f:  # os rótulos têm acento
        f.write(s)

def lin(id, *paradas, h=True):
    p = ''.join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in paradas)
    return f'<linearGradient id="{id}" x1="0" y1="0" x2="{1 if h else 0}" y2="{0 if h else 1}">{p}</linearGradient>'

def escurecer(hexcor, f):
    h = hexcor.lstrip('#'); r, g, b = int(h[0:2],16), int(h[2:4],16), int(h[4:6],16)
    return '#%02X%02X%02X' % tuple(max(0, min(255, int(c*f))) for c in (r,g,b))

# ---------- garrafa PET ----------
def garrafa(nome, liquido, rotulo, tampa, nivel=78, translucida=False, texto='', cor_texto='#fff'):
    corpo_path = 'M98 58 h44 v10 c0 10 26 20 26 46 v92 c0 9 -7 14 -15 14 h-66 c-8 0 -15 -5 -15 -14 v-92 c0 -26 26 -36 26 -46 z'
    defs = (lin('vidro', (0,'#FFFFFF'), (.5,'#EEF6FB'), (1,'#D9E6EF'))
            + lin('liq', (0, escurecer(liquido,.8)), (.45, liquido), (1, escurecer(liquido,.7)))
            + lin('rot', (0, escurecer(rotulo,.85)), (.5, rotulo), (1, escurecer(rotulo,.75)))
            + f'<clipPath id="c"><path d="{corpo_path}"/></clipPath>')
    op = '.55' if translucida else '1'
    c = SOMBRA.format(rx=52)
    c += f'<path d="{corpo_path}" fill="url(#vidro)" stroke="#0B1928" stroke-opacity=".12" stroke-width="2"/>'
    c += f'<g clip-path="url(#c)"><rect x="60" y="{nivel}" width="120" height="160" fill="url(#liq)" opacity="{op}"/></g>'
    c += '<path d="M72 150 c0 0 24 -6 48 0 s48 0 48 0" stroke="#fff" stroke-opacity=".25" stroke-width="3" fill="none"/>' if translucida else ''
    c += f'<rect x="72" y="128" width="96" height="54" rx="4" fill="url(#rot)"/>'
    if texto: c += f'<text x="120" y="162" font-family="Arial, sans-serif" font-weight="700" font-size="17" fill="{cor_texto}" text-anchor="middle">{texto}</text>'
    c += f'<rect x="96" y="30" width="48" height="26" rx="6" fill="{tampa}"/>'
    c += ''.join(f'<rect x="{x}" y="33" width="3" height="20" fill="#000" opacity=".12"/>' for x in range(101, 142, 8))
    c += '<path d="M84 104 c-4 10 -4 70 0 100" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".55" fill="none"/>'
    svg(nome, c, defs)

garrafa('garrafa-agua', '#8FD3FF', '#1E88E5', '#1565C0', nivel=74, translucida=True, texto='ÁGUA')
garrafa('garrafa-refri', '#3A1C14', '#E53935', '#B71C1C', nivel=70, texto='COLA')
garrafa('garrafa-suco', '#7B1FA2', '#FFFFFF', '#6A1B9A', nivel=72, texto='SUCO', cor_texto='#6A1B9A')
garrafa('garrafa-oleo', '#F6C445', '#2E7D32', '#E65100', nivel=72, translucida=True, texto='ÓLEO')

# ---------- lata ----------
def lata(nome, cor, faixa, texto='', topo='#C9D3DC', cor_texto='#fff'):
    defs = lin('l', (0, escurecer(cor,.6)), (.35, cor), (.55, escurecer(cor,1.15) if cor!='#FFFFFF' else '#FFFFFF'), (1, escurecer(cor,.55)))
    defs += lin('t', (0,'#9AA6B2'), (.5,'#E9EEF2'), (1,'#8C98A4'))
    c = SOMBRA.format(rx=50)
    c += '<rect x="76" y="50" width="88" height="164" rx="10" fill="url(#l)"/>'
    c += f'<rect x="76" y="104" width="88" height="56" fill="{faixa}" opacity=".95"/>'
    if texto: c += f'<text x="120" y="139" font-family="Arial, sans-serif" font-weight="800" font-size="16" fill="{cor_texto}" text-anchor="middle">{texto}</text>'
    c += '<ellipse cx="120" cy="52" rx="44" ry="11" fill="url(#t)"/><ellipse cx="120" cy="52" rx="34" ry="7" fill="#AEB8C2"/>'
    c += '<rect x="112" y="47" width="16" height="6" rx="3" fill="#8C98A4"/>'
    c += '<path d="M76 206 q44 14 88 0" stroke="#8C98A4" stroke-width="3" fill="none"/>'
    c += '<path d="M90 66 v130" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".45"/>'
    svg(nome, c, defs)

lata('lata-cerveja', '#E8B33A', '#B71C1C', 'LAGER')
lata('lata-energetico', '#22262B', '#3BD16F', 'ENERGY')
lata('lata-refri', '#C62828', '#1B1B1B', 'REFRI')
lata('lata-molho', '#C62828', '#FFFFFF', 'MOLHO', cor_texto='#C62828')

# ---------- caixa de leite ----------
def caixa(nome, cor, faixa, texto):
    defs = lin('f', (0,'#FFFFFF'), (1,'#EEF2F5')) + lin('s', (0,'#D5DEE6'), (1,'#BFCAD4'))
    c = SOMBRA.format(rx=56)
    c += '<path d="M82 78 L120 46 L158 78 Z" fill="#E6ECF1"/>'           # topo
    c += '<path d="M158 78 L120 46 L132 40 L170 72 Z" fill="#C9D3DC"/>'
    c += '<rect x="112" y="30" width="16" height="18" rx="3" fill="#F5F7F9"/><rect x="108" y="22" width="24" height="12" rx="5" fill="'+faixa+'"/>'
    c += '<rect x="82" y="78" width="76" height="136" fill="url(#f)"/>'      # frente
    c += '<path d="M158 78 L170 72 L170 206 L158 214 Z" fill="url(#s)"/>'   # lado
    c += f'<rect x="82" y="128" width="76" height="46" fill="{faixa}"/>'
    c += f'<text x="120" y="158" font-family="Arial, sans-serif" font-weight="800" font-size="16" fill="#fff" text-anchor="middle">{texto}</text>'
    c += f'<path d="M120 92 c-8 12 -12 18 -12 23 a12 12 0 0 0 24 0 c0 -5 -4 -11 -12 -23 z" fill="{cor}"/>'
    svg(nome, c, defs)

caixa('caixa-leite', '#90CAF9', '#1E88E5', 'LEITE')

# ---------- pote (sorvete, iogurte) ----------
def pote(nome, tampa, corpo, faixa, texto, alto=False, fonte=16):
    y0, y1 = (78, 210) if alto else (110, 210)
    defs = lin('p', (0, escurecer(corpo,.9)), (.5, corpo), (1, escurecer(corpo,.85)))
    c = SOMBRA.format(rx=60)
    c += f'<path d="M66 {y0} L174 {y0} L162 {y1} Q120 {y1+8} 78 {y1} Z" fill="url(#p)"/>'
    c += f'<path d="M70 {y0+40} L170 {y0+40} L166 {y0+82} L74 {y0+82} Z" fill="{faixa}"/>'
    c += f'<text x="120" y="{y0+68}" font-family="Arial, sans-serif" font-weight="800" font-size="{fonte}" fill="#fff" text-anchor="middle">{texto}</text>'
    c += f'<ellipse cx="120" cy="{y0}" rx="58" ry="14" fill="{escurecer(tampa,.8)}"/><ellipse cx="120" cy="{y0-6}" rx="58" ry="14" fill="{tampa}"/>'
    c += f'<path d="M80 {y0+16} L88 {y1-8}" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity=".5"/>'
    svg(nome, c, defs)

pote('pote-sorvete', '#F06292', '#FFF3E0', '#EC407A', 'SORVETE', alto=True)
pote('pote-iogurte', '#F48FB1', '#FFFFFF', '#AD1457', 'IOGURTE', fonte=13)

# ---------- pacote (saco) ----------
def pacote(nome, cor, faixa, texto, janela=None, brilho=False, borda='#0B1928'):
    defs = lin('b', (0, escurecer(cor,.82)), (.5, cor), (1, escurecer(cor,.78)))
    if brilho: defs += lin('m', (0,'#FFFFFF'), (.5, escurecer(cor,1.25)), (1, escurecer(cor,.7)))
    c = SOMBRA.format(rx=60)
    c += f'<path d="M72 54 Q120 44 168 54 L174 200 Q120 214 66 200 Z" fill="url(#{"m" if brilho else "b"})" stroke="{borda}" stroke-opacity=".1" stroke-width="2"/>'
    c += f'<path d="M72 54 Q120 44 168 54 L168 66 Q120 58 72 66 Z" fill="{escurecer(cor,.7)}"/>'  # selagem
    c += ''.join(f'<rect x="{x}" y="50" width="2" height="16" fill="#000" opacity=".12"/>' for x in range(78, 166, 7))
    if janela == 'graos':
        c += '<rect x="96" y="96" width="48" height="58" rx="8" fill="#3E2214"/>'
        c += ''.join(f'<ellipse cx="{x}" cy="{y}" rx="6" ry="4" fill="#6D3B22" transform="rotate(30 {x} {y})"/>' for x,y in [(104,106),(118,110),(132,104),(108,124),(124,128),(138,122),(104,142),(120,146),(134,140)])
    elif janela == 'massa':
        c += '<rect x="92" y="80" width="56" height="100" rx="6" fill="#FFF8E1"/>'
        c += ''.join(f'<rect x="{x}" y="84" width="3" height="92" fill="#F2C14E"/>' for x in range(96, 146, 5))
    elif janela == 'biscoito':
        c += ''.join(f'<circle cx="{x}" cy="{y}" r="15" fill="#D9A066" stroke="#B57A3E" stroke-width="2"/>' for x,y in [(100,104),(140,104),(120,128)])
        c += ''.join(f'<circle cx="{x}" cy="{y}" r="2.2" fill="#8D5524"/>' for x,y in [(96,100),(104,108),(136,100),(144,108),(116,124),(124,132)])
    elif janela == 'chips':
        c += ''.join(f'<ellipse cx="{x}" cy="{y}" rx="17" ry="12" fill="#FFD54F" stroke="#F9A825" stroke-width="2" transform="rotate({r} {x} {y})"/>' for x,y,r in [(104,108,-20),(136,104,15),(120,128,5)])
    c += f'<rect x="66" y="150" width="108" height="40" fill="{faixa}"/>'
    c += f'<text x="120" y="176" font-family="Arial, sans-serif" font-weight="800" font-size="16" fill="#fff" text-anchor="middle">{texto}</text>'
    c += '<path d="M84 74 Q80 130 86 190" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".4" fill="none"/>'
    svg(nome, c, defs)

pacote('pacote-arroz', '#FFFFFF', '#1565C0', 'ARROZ')
pacote('pacote-feijao', '#F3E5D0', '#8D3B1E', 'FEIJÃO')
pacote('pacote-acucar', '#FFFFFF', '#0277BD', 'AÇÚCAR')
pacote('pacote-sal', '#FFFFFF', '#5C6BC0', 'SAL')
pacote('pacote-cafe', '#B07A4B', '#3E2214', 'CAFÉ', janela='graos')
pacote('pacote-macarrao', '#E3F2FD', '#E65100', 'MASSA', janela='massa')
pacote('pacote-biscoito', '#1E88E5', '#0D47A1', 'BISCOITO', janela='biscoito')
pacote('pacote-salgadinho', '#F9A825', '#C62828', 'CHIPS', janela='chips', brilho=True)
pacote('sabao-po', '#FFFFFF', '#00897B', 'SABÃO')

# ---------- padaria ----------
defs = lin('pf', (0,'#E8A85A'), (.5,'#C9782F'), (1,'#9C5A1F'), h=False)
c = SOMBRA.format(rx=70)
c += '<ellipse cx="120" cy="140" rx="86" ry="52" fill="url(#pf)"/>'
c += ''.join(f'<path d="M{x} 112 q14 14 6 40" stroke="#F3D6A4" stroke-width="7" stroke-linecap="round" fill="none"/>' for x in (78, 108, 138))
c += '<ellipse cx="96" cy="118" rx="26" ry="9" fill="#fff" opacity=".22"/>'
svg('pao-frances', c, defs)

defs = lin('pfo', (0,'#E4A157'), (1,'#B7712E'), h=False)
c = SOMBRA.format(rx=74)
c += '<rect x="48" y="104" width="144" height="100" rx="12" fill="#F5DEB3"/>'
c += '<path d="M44 112 q0 -48 40 -48 q20 -16 36 0 q16 -16 36 0 q40 0 40 48 Z" fill="url(#pfo)"/>'
c += '<rect x="48" y="112" width="144" height="92" rx="10" fill="#F7E3BC" stroke="#D9A866" stroke-width="3"/>'
c += ''.join(f'<line x1="{x}" y1="116" x2="{x}" y2="200" stroke="#E6C48A" stroke-width="2"/>' for x in (84, 120, 156))
svg('pao-forma', c, defs)

c = SOMBRA.format(rx=64)
c += '<path d="M60 196 L180 196 L180 120 Z" fill="#7B4A2A"/>'
c += '<path d="M60 196 L180 120 L180 150 L60 196" fill="#FBE3B0"/>'
c += '<path d="M60 196 L180 150 L180 168 L60 196" fill="#7B4A2A"/>'
c += '<path d="M60 196 L180 120 L172 108 Q120 120 56 186 Z" fill="#F48FB1"/>'
c += '<circle cx="170" cy="106" r="10" fill="#D32F2F"/><path d="M170 96 q4 -10 12 -10" stroke="#2E7D32" stroke-width="3" fill="none"/>'
svg('bolo', c)

# ---------- hortifrúti ----------
c = SOMBRA.format(rx=70)
dedo = 'M0 0 C 30 70, 110 84, 150 30 C 156 22, 150 14, 142 20 C 104 56, 46 52, 16 -6 Z'
for rot, dx, dy, cor in ((-26, 58, 84, '#F9C93C'), (-8, 50, 100, '#FBD34D'), (12, 46, 116, '#F5BE2B')):
    c += f'<g transform="translate({dx} {dy}) rotate({rot})"><path d="{dedo}" fill="{cor}" stroke="#D99A0B" stroke-width="3" stroke-linejoin="round"/>'
    c += '<path d="M20 8 C 46 46, 96 54, 132 26" stroke="#fff" stroke-width="5" opacity=".4" fill="none" stroke-linecap="round"/>'
    c += '<path d="M142 20 l14 -8" stroke="#5D4037" stroke-width="7" stroke-linecap="round"/></g>'
c += '<rect x="44" y="68" width="22" height="18" rx="6" fill="#6D4C2F"/>'
svg('banana', c)

defs = '<radialGradient id="tm" cx=".38" cy=".35" r=".7"><stop offset="0" stop-color="#FF7961"/><stop offset=".6" stop-color="#E53935"/><stop offset="1" stop-color="#B71C1C"/></radialGradient>'
c = SOMBRA.format(rx=60)
c += '<circle cx="120" cy="138" r="72" fill="url(#tm)"/>'
c += '<path d="M120 70 l10 18 l20 -6 l-12 16 l16 12 l-20 2 l-4 20 l-10 -18 l-10 18 l-4 -20 l-20 -2 l16 -12 l-12 -16 l20 6 z" fill="#2E7D32"/>'
c += '<ellipse cx="96" cy="112" rx="16" ry="10" fill="#fff" opacity=".35" transform="rotate(-30 96 112)"/>'
svg('tomate', c, defs)

defs = '<radialGradient id="bt" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#E0B97A"/><stop offset="1" stop-color="#A9783E"/></radialGradient>'
c = SOMBRA.format(rx=76)
c += '<path d="M54 170 q-10 -46 34 -60 q40 -14 56 12 q14 30 -10 54 q-30 28 -80 -6z" fill="url(#bt)"/>'
c += '<path d="M118 178 q-8 -40 30 -52 q34 -8 42 18 q8 32 -22 44 q-30 10 -50 -10z" fill="url(#bt)"/>'
c += ''.join(f'<circle cx="{x}" cy="{y}" r="2.5" fill="#7A5228"/>' for x,y in [(80,140),(104,160),(70,166),(150,150),(168,170),(140,180)])
svg('batata', c, defs)

defs = '<radialGradient id="cb" cx=".4" cy=".4" r=".7"><stop offset="0" stop-color="#F3C98B"/><stop offset="1" stop-color="#B9772F"/></radialGradient>'
c = SOMBRA.format(rx=58)
c += '<path d="M120 60 q-6 14 -8 22 q-62 22 -50 80 q12 52 58 52 q46 0 58 -52 q12 -58 -50 -80 q-2 -8 -8 -22 z" fill="url(#cb)"/>'
c += ''.join(f'<path d="M120 86 Q{x} 140 120 210" stroke="#A86A2A" stroke-width="2" fill="none" opacity=".5"/>' for x in (80, 100, 140, 160))
c += '<path d="M116 210 l-6 10 M124 210 l6 10 M120 212 v10" stroke="#D7B98A" stroke-width="2"/>'
svg('cebola', c, defs)

defs = '<radialGradient id="mc" cx=".38" cy=".35" r=".75"><stop offset="0" stop-color="#FF8A80"/><stop offset=".6" stop-color="#E53935"/><stop offset="1" stop-color="#9F1C1C"/></radialGradient>'
c = SOMBRA.format(rx=60)
c += '<path d="M120 84 q-30 -18 -56 6 q-26 30 -6 76 q22 50 62 34 q40 16 62 -34 q20 -46 -6 -76 q-26 -24 -56 -6z" fill="url(#mc)"/>'
c += '<path d="M120 86 q2 -22 12 -32" stroke="#6D4C2F" stroke-width="5" stroke-linecap="round" fill="none"/>'
c += '<path d="M128 66 q24 -14 38 2 q-20 14 -38 -2z" fill="#43A047"/>'
c += '<ellipse cx="88" cy="112" rx="12" ry="18" fill="#fff" opacity=".3" transform="rotate(20 88 112)"/>'
svg('maca', c, defs)

# ---------- frios e laticínios ----------
c = SOMBRA.format(rx=70)
c += '<path d="M44 160 L196 118 L196 176 L44 200 Z" fill="#F9C846"/>'
c += '<path d="M44 160 L196 118 L150 90 Z" fill="#FFE07A"/>'
c += '<path d="M196 118 L196 176 L196 176" stroke="#E0A800"/>'
c += ''.join(f'<ellipse cx="{x}" cy="{y}" rx="{r}" ry="{r*0.8}" fill="#E5AE24"/>' for x,y,r in [(90,176,9),(130,158,12),(170,170,7),(150,140,5),(110,190,5)])
c += ''.join(f'<ellipse cx="{x}" cy="{y}" rx="{r}" ry="{r*0.6}" fill="#E5AE24"/>' for x,y,r in [(130,116,8),(160,104,5)])
svg('queijo', c)

c = SOMBRA.format(rx=70)
for i, y in enumerate((170, 150, 130)):
    c += f'<ellipse cx="{120 + i*6}" cy="{y}" rx="72" ry="28" fill="#F48FB1" stroke="#EC407A" stroke-width="3"/>'
    c += f'<ellipse cx="{120 + i*6}" cy="{y}" rx="56" ry="20" fill="#F8BBD0" opacity=".7"/>'
c += '<path d="M76 124 q40 -16 88 0" stroke="#fff" stroke-width="5" opacity=".5" fill="none" stroke-linecap="round"/>'
svg('presunto', c)

c = SOMBRA.format(rx=70)
c += '<path d="M56 110 L184 110 L184 196 L56 196 Z" fill="#FFF3C4"/>'
c += '<path d="M56 110 L84 86 L212 86 L184 110 Z" fill="#FFE68A"/><path d="M184 110 L212 86 L212 172 L184 196 Z" fill="#F2CF5B"/>'
c += '<rect x="56" y="140" width="128" height="34" fill="#1E88E5"/><text x="120" y="163" font-family="Arial, sans-serif" font-weight="800" font-size="15" fill="#fff" text-anchor="middle">MANTEIGA</text>'
svg('manteiga', c)

# ---------- doces e congelados ----------
c = SOMBRA.format(rx=76)
c += '<g transform="rotate(-14 120 140)"><rect x="40" y="96" width="160" height="88" rx="8" fill="#5D3420"/>'
c += ''.join(f'<rect x="{x}" y="{y}" width="34" height="34" rx="4" fill="#6F4129" stroke="#4A2817" stroke-width="2"/>' for x in (48, 86, 124, 162) for y in (102, 142) if x < 190)
c += '<path d="M120 90 L200 90 L200 190 L120 190 Z" fill="#C62828"/><path d="M120 90 L132 100 L120 112 L132 124 L120 136 L132 148 L120 160 L132 172 L120 184" stroke="#E0E0E0" stroke-width="4" fill="none"/>'
c += '<text x="164" y="146" font-family="Arial, sans-serif" font-weight="800" font-size="14" fill="#fff" text-anchor="middle">CHOCO</text></g>'
svg('chocolate', c)

c = SOMBRA.format(rx=80)
c += '<circle cx="120" cy="134" r="86" fill="#E9A85C"/><circle cx="120" cy="134" r="72" fill="#F4C64A"/>'
c += '<circle cx="120" cy="134" r="70" fill="#E53935" opacity=".22"/>'
c += ''.join(f'<circle cx="{x}" cy="{y}" r="10" fill="#B71C1C"/>' for x,y in [(92,106),(146,110),(120,140),(86,158),(150,162),(118,184),(168,136)])
c += ''.join(f'<line x1="120" y1="134" x2="{120+80*a}" y2="{134+80*b}" stroke="#D9902F" stroke-width="3"/>' for a,b in [(1,0),(-1,0),(0,1),(0,-1),(.7,.7),(-.7,.7),(.7,-.7),(-.7,-.7)])
c += ''.join(f'<path d="M{x} {y} l6 4" stroke="#2E7D32" stroke-width="4" stroke-linecap="round"/>' for x,y in [(104,124),(136,148),(100,174),(160,120)])
svg('pizza', c)

# ---------- higiene e limpeza ----------
c = SOMBRA.format(rx=70)
c += '<rect x="52" y="112" width="136" height="80" rx="34" fill="#80DEEA"/><rect x="52" y="104" width="136" height="80" rx="34" fill="#B2EBF2"/>'
c += '<ellipse cx="120" cy="140" rx="40" ry="16" fill="#fff" opacity=".55"/>'
c += ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="none" stroke="#4DD0E1" stroke-width="3"/>' for x,y,r in [(170,86,12),(146,70,8),(186,62,6),(80,84,7)])
svg('sabonete', c)

c = SOMBRA.format(rx=80)
c += '<g transform="rotate(-18 120 140)"><path d="M40 112 L166 104 Q182 104 182 120 L182 160 Q182 176 166 176 L40 168 Z" fill="#FFFFFF" stroke="#CFD8DC" stroke-width="3"/>'
c += '<rect x="182" y="122" width="22" height="36" rx="5" fill="#1E88E5"/><path d="M40 112 L40 168" stroke="#90A4AE" stroke-width="6"/>'
c += '<path d="M66 128 L160 122 L160 154 L66 152 Z" fill="#E53935"/><text x="114" y="146" font-family="Arial, sans-serif" font-weight="800" font-size="14" fill="#fff" text-anchor="middle">DENTAL</text></g>'
svg('creme-dental', c)

c = SOMBRA.format(rx=80)
for x in (74, 166):
    c += f'<rect x="{x-38}" y="90" width="76" height="118" rx="8" fill="#FFFFFF" stroke="#D5DEE6" stroke-width="3"/>'
    c += f'<ellipse cx="{x}" cy="90" rx="38" ry="14" fill="#F1F5F8" stroke="#D5DEE6" stroke-width="3"/><ellipse cx="{x}" cy="90" rx="12" ry="5" fill="#B0BEC5"/>'
c += '<rect x="82" y="70" width="76" height="140" rx="8" fill="#FFFFFF" stroke="#D5DEE6" stroke-width="3"/>'
c += '<ellipse cx="120" cy="70" rx="38" ry="14" fill="#F1F5F8" stroke="#D5DEE6" stroke-width="3"/><ellipse cx="120" cy="70" rx="12" ry="5" fill="#B0BEC5"/>'
c += '<rect x="82" y="126" width="76" height="30" fill="#29B6F6"/>'
svg('papel', c)

defs = lin('dt', (0,'#2E9E5B'), (.5,'#43C77A'), (1,'#1F7A45'))
c = SOMBRA.format(rx=46)
c += '<path d="M90 76 Q90 62 104 60 L136 60 Q150 62 150 76 L156 196 Q156 212 140 212 L100 212 Q84 212 84 196 Z" fill="url(#dt)"/>'
c += '<rect x="106" y="34" width="28" height="28" rx="4" fill="#FFFFFF"/><rect x="112" y="24" width="16" height="12" rx="3" fill="#E0E0E0"/>'
c += '<rect x="90" y="124" width="60" height="50" rx="4" fill="#FFFFFF"/><text x="120" y="154" font-family="Arial, sans-serif" font-weight="800" font-size="12" fill="#1F7A45" text-anchor="middle">LIMPEZA</text>'
c += '<path d="M98 84 v100" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity=".45"/>'
svg('detergente', c, defs)

c = SOMBRA.format(rx=66)
c += '<path d="M70 92 Q70 74 90 72 L150 72 Q170 74 170 92 L174 196 Q174 212 158 212 L82 212 Q66 212 66 196 Z" fill="#FFFFFF" stroke="#CFD8DC" stroke-width="3"/>'
c += '<path d="M128 72 Q150 40 170 72" stroke="#CFD8DC" stroke-width="10" fill="none"/><rect x="88" y="50" width="30" height="24" rx="4" fill="#1E88E5"/>'
c += '<rect x="74" y="122" width="92" height="52" fill="#1E88E5"/><text x="120" y="154" font-family="Arial, sans-serif" font-weight="800" font-size="13" fill="#fff" text-anchor="middle">SANITÁRIA</text>'
svg('galao-sanitaria', c)

# ---------- genérico: sacola da loja ----------
defs = lin('sc', (0,'#13304D'), (.5,'#1B3F63'), (1,'#0E2740'))
c = SOMBRA.format(rx=70)
c += '<path d="M84 92 Q84 52 120 52 Q156 52 156 92" stroke="#0E2740" stroke-width="10" fill="none" stroke-linecap="round"/>'
c += '<path d="M56 88 L184 88 L194 210 L46 210 Z" fill="url(#sc)"/>'
c += '<path d="M104 128 q0 -14 16 -14 q16 0 16 14 v4 h10 v34 h-52 v-34 h10 z" fill="#2EE6B5"/><circle cx="120" cy="150" r="7" fill="#13304D"/>'
c += '<text x="120" y="194" font-family="Arial, sans-serif" font-weight="800" font-size="15" fill="#2EE6B5" text-anchor="middle">BINHO</text>'
svg('sacola', c, defs)

print(len([f for f in os.listdir(OUT) if f.endswith('.svg')]), 'ilustracoes')
