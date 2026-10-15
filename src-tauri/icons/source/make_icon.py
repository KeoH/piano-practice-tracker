import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1]
S = 4          # supersampling
N = 1024 * S   # lienzo final 1024


def s(v):
    return int(round(v * S))


INK_TOP = (30, 30, 37)
INK_BOT = (14, 14, 17)
IVORY = (244, 241, 232)
IVORY_SHADE = (214, 210, 198)
BRASS = (233, 180, 76)
BRASS_DARK = (190, 138, 40)
BLACK = (17, 17, 20)

# Fondo: cuadrado redondeado con degradado vertical (margen estándar de iconos Linux)
bg = Image.new("RGBA", (N, N), (0, 0, 0, 0))
grad = Image.new("RGBA", (N, N))
gp = grad.load()
for y in range(N):
    t = y / (N - 1)
    c = tuple(int(INK_TOP[i] + (INK_BOT[i] - INK_TOP[i]) * t) for i in range(3)) + (255,)
    for x in range(N):
        gp[x, y] = c
mask = Image.new("L", (N, N), 0)
m = s(64)
ImageDraw.Draw(mask).rounded_rectangle([m, m, N - m, N - m], radius=s(200), fill=255)
bg.paste(grad, (0, 0), mask)

# Teclado
art = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(art)

kx0, kx1 = 172, 852           # ancho del teclado
ky0, ky1 = 330, 800           # alto de las teclas blancas
n_white = 5
gap = 12
kw = (kx1 - kx0 - gap * (n_white - 1)) / n_white
active = 2                    # tecla "tocada" en latón

whites = []
for i in range(n_white):
    x0 = kx0 + i * (kw + gap)
    whites.append((x0, x0 + kw))
    col = BRASS if i == active else IVORY
    shade = BRASS_DARK if i == active else IVORY_SHADE
    # sombra inferior (borde de la tecla) y cuerpo
    d.rounded_rectangle([s(x0), s(ky0), s(x0 + kw), s(ky1)], radius=s(34), fill=shade)
    d.rounded_rectangle([s(x0), s(ky0), s(x0 + kw), s(ky1 - 14)], radius=s(34), fill=col)

# Teclas negras entre las blancas 0-1, 1-2 y 3-4 (patrón de un piano real)
bw, bh = 82, 270
for i in (0, 1, 3):
    cx = whites[i][1] + gap / 2
    d.rounded_rectangle(
        [s(cx - bw / 2), s(ky0 - 6), s(cx + bw / 2), s(ky0 - 6 + bh)],
        radius=s(18),
        fill=BLACK,
        outline=(46, 46, 56),
        width=s(4),
    )

# Barra de latón superior (la "línea de tiempo")
d.rounded_rectangle([s(kx0), s(236), s(kx1), s(262)], radius=s(13), fill=(60, 60, 70))
d.rounded_rectangle([s(kx0), s(236), s(kx0 + (kx1 - kx0) * 0.52), s(262)], radius=s(13), fill=BRASS)
cx = kx0 + (kx1 - kx0) * 0.52
d.ellipse([s(cx - 26), s(249 - 26), s(cx + 26), s(249 + 26)], fill=IVORY)

# Recorta el teclado al fondo y compone
art_mask = Image.new("L", (N, N), 0)
ImageDraw.Draw(art_mask).rounded_rectangle([m, m, N - m, N - m], radius=s(200), fill=255)
bg.alpha_composite(art)
final = Image.new("RGBA", (N, N), (0, 0, 0, 0))
final.paste(bg, (0, 0), mask)
final = final.resize((1024, 1024), Image.LANCZOS)
final.save(OUT)
