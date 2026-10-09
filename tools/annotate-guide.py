"""Create annotated PNGs from browser captures of fictional local examples.

Usage: python tools/annotate-guide.py CAPTURE_DIR
Requires Pillow. Captures must be reviewed for private data before this step.
This tool adds annotations; it does not automate or alter the browser.
"""
from pathlib import Path
import math
import sys
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
CAPTURES = Path(sys.argv[1])
FONT = Path('C:/Windows/Fonts/msyh.ttc')
# Coordinates from the reviewed 1280 px browser viewport. Full-page captures
# retain the same width; each annotation ends at its control boundary.
FIGURES = {
    'home': [
        ([16, 11, 128, 53], [195, 48], '点击 SciHub 图标返回主页。'),
        ([1002, 11, 1098, 53], [965, 96], '点击“小工具”打开计算器菜单。'),
        ([132, 121, 1133, 173], [1190, 156], '通过导航栏切换主页、实验方案和科研记录。')],
    'tools': [
        ([439, 215, 825, 301], [873, 249], '选择配制溶液计算器。'),
        ([439, 307, 825, 393], [873, 348], '选择铂氯酸计算器。'),
        ([439, 399, 825, 485], [873, 442], '选择热解程序计算器。')],
    'solution': [
        ([309, 103, 938, 185], [991, 146], '选择试剂并输入目标浓度，单位为 mol/L。'),
        ([309, 196, 938, 276], [991, 236], '输入最终配制体积并选择 mL 或 L。'),
        ([309, 393, 938, 569], [991, 485], '按瓶签或证书核对原液浓度和密度。')],
    'solution-result': [
        ([309, 321, 938, 433], [991, 376], '读取需加入原液的体积和质量。'),
        ([309, 435, 938, 526], [991, 477], '核对原液摩尔浓度及最终配制体积。'),
        ([309, 534, 938, 587], [991, 559], '酸加入水中，冷却后定容至目标体积。')],
    'plan': [
        ([137, 253, 236, 304], [90, 279], '核对步骤后，点击“开始实验”。'),
        ([240, 253, 340, 304], [365, 219], '点击“编辑方案”修改方案草稿。'),
        ([462, 253, 594, 304], [527, 215], '点击“返回方案列表”查看其他方案。')],
    'run': [
        ([148, 544, 463, 595], [510, 571], '填写实际测量值，并核对字段单位。'),
        ([148, 642, 1117, 745], [1170, 689], '填写实际操作情况及偏差备注。'),
        ([235, 975, 367, 1026], [415, 1002], '完成当前步骤后，点击“完成并下一步”。')],
    'record': [
        ([150, 386, 1115, 434], [1170, 410], '填写记录标题。'),
        ([150, 634, 1115, 839], [1170, 730], '填写科研记录内容。'),
        ([150, 850, 217, 901], [105, 875], '点击“保存”，等待保存成功提示。')]
}

def build(name, annotations):
    image = Image.open(CAPTURES / (name + '.jpg')).convert('RGB')
    width, height = image.size
    scale = width / 1280
    footer = round(155 * scale)
    out = Image.new('RGB', (width, height + footer), '#ffffff')
    out.paste(image, (0, 0))
    draw = ImageDraw.Draw(out)
    font = ImageFont.truetype(str(FONT), round(20 * scale))
    number_font = ImageFont.truetype(str(FONT), round(19 * scale))
    red = '#df2525'
    for i, (rect, tail, text) in enumerate(annotations, 1):
        x1, y1, x2, y2 = [round(x * scale) for x in rect]
        tx, ty = [round(x * scale) for x in tail]
        if y2 > height:
            raise ValueError(f'{name}: annotation extends outside capture')
        draw.rectangle((x1,y1,x2,y2), outline=red, width=round(3*scale))
        ex = min(max(tx, x1), x2)
        ey = min(max(ty, y1), y2)
        angle = math.atan2(ey-ty, ex-tx)
        radius = round(17*scale)
        sx, sy = tx+math.cos(angle)*radius, ty+math.sin(angle)*radius
        draw.line((sx,sy,ex,ey), fill=red, width=round(3*scale))
        arrow = round(12*scale)
        draw.polygon([(ex,ey), (ex-arrow*math.cos(angle-.5),ey-arrow*math.sin(angle-.5)),
                     (ex-arrow*math.cos(angle+.5),ey-arrow*math.sin(angle+.5))],fill=red)
        draw.ellipse((tx-radius,ty-radius,tx+radius,ty+radius),fill=red,outline='white',width=2)
        draw.text((tx,ty-1),str(i),font=number_font,fill='white',anchor='mm')
        ly = height+round((30+(i-1)*40)*scale)
        draw.text((round(24*scale),ly),f'{i}. {text}',font=font,fill='#17342e',anchor='lm')
    dest = ROOT / 'assets' / 'guide' / (name+'.png')
    dest.parent.mkdir(parents=True, exist_ok=True)
    out.save(dest, optimize=True)
    print(f'{name}: {out.width} x {out.height}')

for name, annotations in FIGURES.items():
    build(name, annotations)
