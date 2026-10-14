"""Recreate the original GRIND FM artwork. Optional tool; never needed to run the site."""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import math, random

OUT = Path(__file__).resolve().parent
S = 1600
im = Image.new('RGB', (S, S), '#f3f0e6')
d = ImageDraw.Draw(im)
bold = 'C:/Windows/Fonts/arialbd.ttf'
regular = 'C:/Windows/Fonts/consola.ttf'
def font(size, heavy=False):
    return ImageFont.truetype(bold if heavy else regular, size)
def text_center(text, y, size, heavy=False):
    f = font(size, heavy)
    d.text((800, y), text, font=f, fill='#141418', anchor='mt', stroke_width=1 if heavy else 0)

# Abstract original pirate-radio stencil: hard geometry, scratched ink, no game assets.
d.ellipse((24,24,1576,1576),outline='#141418',width=9)
d.ellipse((45,45,1555,1555),outline='#141418',width=2)
d.ellipse((510,510,1090,1090),outline='#141418',width=7)
for a in range(0,360,3):
    rad=math.radians(a)
    r1=729 if a%15 else 714
    d.line((800+math.cos(rad)*r1,800+math.sin(rad)*r1,800+math.cos(rad)*744,800+math.sin(rad)*744),fill='#141418',width=3)
text_center('GRIND // FM', 228, 128, True)
text_center('UNLICENSED FREQUENCIES', 375, 28)
text_center('ALL CITY. ALL SOUND.', 1172, 63, True)
text_center('98.6 MHZ  /  UNDERGROUND RADIO', 1260, 27)
text_center('NO SIGNAL CAN HOLD US.', 1313, 22)
for x,flip in [(235,1),(1365,-1)]:
    pts=[(x,600),(x+130*flip,600),(x+65*flip,760),(x+145*flip,760),(x-40*flip,1010),(x+5*flip,828),(x-75*flip,828)]
    d.polygon(pts,fill='#141418')
    d.line((x-85*flip,1060,x+130*flip,1090),fill='#141418',width=10)
for k in range(35):
    x=560+k*14
    d.rectangle((x,1403,x+random.Random(k).choice([3,4,6]),1447 if k%3 else 1458),fill='#141418')
text_center('ORIGINAL STATION ARTWORK · SIDE A', 1490, 17)
for angle in [45,135,225,315]:
    rad=math.radians(angle)
    x,y=800+math.cos(rad)*620,800+math.sin(rad)*620
    d.line((x-16,y,x+16,y),fill='#141418',width=4)
    d.line((x,y-16,x,y+16),fill='#141418',width=4)
# The actual hole/clear hub is geometry, not painted black on the texture.
im.save(OUT/'label.jpg',quality=96,subsampling=0)
print(f'Original label saved: {OUT / "label.jpg"}')
