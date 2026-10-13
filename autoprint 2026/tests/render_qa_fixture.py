from pathlib import Path
import sys, re, io, base64, json, time
sys.path.insert(0, str(Path('autoprint 2026').resolve()))
from app import main
from app.liquid_template import render_liquid
from PIL import Image
root=Path('tmp/print-label-qa').resolve()
root.mkdir(parents=True,exist_ok=True)
buf=io.BytesIO()
Image.new('RGB',(120,50),'navy').save(buf,format='PNG')
png='data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode()
summary=[]
for template_name in ('label.liquid','label_store2.liquid'):
    rows=[]
    for i in range(30):
        num=900001+i
        order={'order_number':num,'created_at':'2026-10-13T12:00:00+01:00','tags':'meta, ch' if i%2 else 'meta','currency_suffix':' DH','shipping_address':{'name':'Test Customer','phone':'0600000000','address1':'123 Test Street','city':'Casablanca','zip':'20000','country':'Morocco'},'line_items':[{'fulfillable_quantity':1,'final_line_price':149,'variant':{'title':'Fixture Product / Size M','featured_image':png}}], 'line_items_subtotal_price':149,'shipping_price':30,'tax_price':0,'total_price':179}
        rendered=render_liquid(main.BASE/'templates'/template_name,{'order':order,'logos_base':(main.BASE/'logos').as_uri(),'logos_available':['meta'],'order_qr_src':main._qr_data_uri(str(num)),'wa_qr_src':main._qr_data_uri('https://wa.me/212677624078')})
        rendered=re.sub(r'src="https://[^\"]+"','src="'+png+'"',rendered)
        rows.append((main._extract_body(rendered),main._extract_style(rendered),'test'))
    if template_name == 'label.liquid':
        old_html = root / 'label.liquid.before.html'
        old_pdf = root / 'label.liquid.before.pdf'
        old_html.write_text('<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + rows[0][1] + '</style><style>.page-break{page-break-after:always;}</style></head><body><div>' + '</div><div class="page-break"></div><div>'.join(row[0] for row in rows) + '</div></body></html>', encoding='utf-8')
        main.html_to_pdf(str(old_html), str(old_pdf))
    html=root/(template_name+'.html')
    pdf=root/(template_name+'.pdf')
    html.write_text(main._combined_label_html(rows),encoding='utf-8')
    started=time.monotonic()
    main.html_to_pdf(str(html),str(pdf))
    summary.append({'template':template_name,'pdf':str(pdf),'seconds':round(time.monotonic()-started,2)})
print(json.dumps(summary))
