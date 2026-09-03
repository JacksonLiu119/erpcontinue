from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import ImageReader
from PIL import Image
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'output', 'pdf', 'ERP進銷存應收應付會計操作流程手冊.pdf')
IMG = os.path.join(ROOT, 'tmp', 'pdfs', 'erp-operation-guide')
os.makedirs(os.path.dirname(OUT), exist_ok=True)
pdfmetrics.registerFont(TTFont('TC', r'C:\Windows\Fonts\msjh.ttc'))
pdfmetrics.registerFont(TTFont('TCB', r'C:\Windows\Fonts\msjhbd.ttc'))
W, H = landscape(A4)
BROWN, DARK, PALE, BLUE = HexColor('#8A4518'), HexColor('#2C241E'), HexColor('#FFF6E8'), HexColor('#246B8E')
c = canvas.Canvas(OUT, pagesize=(W, H))
c.setTitle('ERP進銷存應收應付會計操作流程手冊')
c.setAuthor('進銷存 ERP 專案')

def text(x, y, value, size=11, bold=False, color=DARK):
    c.setFillColor(color); c.setFont('TCB' if bold else 'TC', size); c.drawString(x, y, value)

def footer(page):
    c.setStrokeColor(HexColor('#D8C7B3')); c.line(30, 24, W-30, 24)
    text(34, 10, 'SC 示範公司｜來源資料庫唯讀｜新單據寫入 inventory_erp_sc', 8, color=HexColor('#6E6258'))
    text(W-70, 10, f'{page}', 8, color=HexColor('#6E6258'))

def header(title, subtitle, page):
    c.setFillColor(BROWN); c.rect(0, H-54, W, 54, fill=1, stroke=0)
    text(28, H-35, title, 20, True, white)
    text(W-260, H-34, subtitle, 9, color=white)
    footer(page)

def note_box(lines, y_top):
    height = 18 + len(lines)*16
    c.setFillColor(PALE); c.setStrokeColor(HexColor('#D9B58F'))
    c.roundRect(28, y_top-height, W-56, height, 7, fill=1, stroke=1)
    yy=y_top-20
    for line in lines:
        text(42, yy, line, 10); yy-=16
    return y_top-height-10

def screenshot(name, y_top):
    p=os.path.join(IMG,name)
    im=Image.open(p); iw,ih=im.size
    maxw,maxh=W-56,y_top-34
    scale=min(maxw/iw,maxh/ih)
    dw,dh=iw*scale,ih*scale
    c.drawImage(ImageReader(im), (W-dw)/2, y_top-dh, dw, dh, preserveAspectRatio=True, mask='auto')

# Cover
c.setFillColor(DARK); c.rect(0,0,W,H,fill=1,stroke=0)
c.setFillColor(BROWN); c.roundRect(45,H-245,W-90,150,18,fill=1,stroke=0)
text(70,H-150,'ERP 進銷存、應收應付與會計總帳',28,True,white)
text(70,H-195,'逐步操作與實際流程驗證手冊',22,True,white)
text(70,H-285,'示範公司：SC（盛慶股份有限公司）',14,True,HexColor('#F3D3B5'))
text(70,H-315,'示範品號：DEMO-20260819-01　｜　日期：2026-08-19',12,color=white)
text(70,H-345,'原始客戶資料庫維持唯讀；本手冊建立的交易寫入獨立標準 ERP 資料庫 inventory_erp_sc。',11,color=white)
text(70,70,'版本 1.0　2026-08-19',10,color=HexColor('#CDBBAA'))
c.showPage()

# Flow page
header('完整作業流程', '先接單、再依缺料採購，最後拋轉會計', 2)
steps=['1 建立品號','2 建立客戶訂單','3 查庫存／確認缺料','4 建立請購','5 建立採購單','6 進貨驗收與入庫','7 銷貨出庫','8 應收立帳','9 應付立帳','10 拋轉並過帳總帳']
for i,s in enumerate(steps):
    x=38+(i%5)*155; y=H-125-(i//5)*120
    c.setFillColor(PALE); c.setStrokeColor(BROWN); c.roundRect(x,y-50,135,58,8,fill=1,stroke=1)
    text(x+12,y-20,s,11,True,BROWN)
    if i%5<4:
        text(x+138,y-22,'→',18,True,BLUE)
note_box([
    '示範數據：訂單 6 PCS × 售價 120＝應收 720；採購 10 PCS × 成本 80＝應付 800。',
    '庫存驗證：期初 0 → 進貨後 10 → 銷貨後 4。',
    '會計驗證：應收傳票同時記錄收入與銷貨成本；應付傳票記錄存貨與應付帳款。'
], H-390)
c.showPage()

pages=[
 ('步驟 1　建立品號','庫存管理 → 品號主檔建立作業','01-item-master.png',[
  '輸入品號 DEMO-20260819-01、品名「ERP操作手冊測試商品」、單位 PCS，再按「新增資料」。',
  '建立後以關鍵字查詢確認資料存在；此主檔屬於 SC 公司，不會混入其他公司。']),
 ('步驟 2　建立客戶訂單','銷售管理 → 訂單建立作業','02-sales-order.png',[
  '選擇訂單單別，日期 2026-08-19，客戶 DEMO-CUST，品號 DEMO-20260819-01。',
  '數量 6、單價 120、成本 80；儲存後核準。示範訂單：SO-20260819-0001。']),
 ('步驟 3　確認庫存與缺料','庫存管理 → 新 ERP 庫存餘額','03-stock-balance.png',[
  '以品號查詢可用庫存。接單時此品號為 0，因此不足以交付 6 PCS，必須啟動採購。',
  '本頁只讀取 SC 對應的 inventory_erp_sc 庫存，不讀取其他公司的標準 ERP 資料。']),
 ('步驟 4　建立請購','採購管理 → 請購建立作業','04-requisition.png',[
  '選擇請購單別，輸入需求倉別 111 原料倉、品號、需求數量 10 與需求日期。',
  '儲存並核準。核準後才可轉採購；示範請購單：3101-20260819-0001。']),
 ('步驟 5　建立採購單','採購管理 → 採購建立作業','05-purchase-order.png',[
  '參考已核準請購明細，選擇採購單別 3310、廠商 DEMO-SUPP、數量 10、單價 80。',
  '儲存並核準。示範採購單：3310-20260819-0001；請購與採購的單別、單號分開保存。']),
 ('步驟 6　進貨驗收並增加庫存','採購管理 → 進貨建立／驗收；庫存管理 → 進貨過帳','06-receipt-entry.png',[
  '參考採購單建立進貨，實收 10、驗收合格 10、不良 0，接著執行庫存過帳。',
  '示範進貨單：3401-20260819-0001。過帳後庫存由 0 增至 10，存貨金額為 800。']),
 ('步驟 7　銷貨出庫並扣庫存','銷售管理 → 銷貨建立／出庫','07-shipment.png',[
  '從已核準訂單轉出銷貨單，出貨 6 PCS，核準後執行庫存過帳。',
  '銷貨過帳後庫存由 10 降至 4；系統禁止庫存不足時過帳。']),
 ('步驟 8　建立應收客戶帳款','應收／應付管理 → 銷貨轉應收／應收帳款','08-accounts-receivable.png',[
  '選擇已過帳銷貨單，建立並核準應收立帳。示範應收單：AR-20260819-0001。',
  '應收金額＝6 × 120＝720；核準後狀態為 open，後續可接收款與票據流程。']),
 ('步驟 9　建立應付廠商帳款','應收／應付管理 → 進貨轉應付／應付帳款','09-accounts-payable.png',[
  '選擇已驗收且已入庫的進貨單，建立並核準應付立帳。示範應付單：AP-20260819-0001。',
  '應付金額＝10 × 80＝800；核準後狀態為 open，後續可接付款與票據流程。']),
 ('步驟 10　拋轉會計總帳','應收／應付管理 → 會計傳票／總帳','10-general-ledger.png',[
  '分別選擇應收、應付立帳資料按「拋轉會計」，檢查借貸平衡後再按「過帳」。',
  '應收傳票 JV-20260819-0001；應付傳票 JV-20260819-0002，兩張皆已過帳。'])
]

page_no=3
for title,sub,img,lines in pages:
    header(title,sub,page_no)
    y=note_box(lines,H-70)
    screenshot(img,y)
    c.showPage(); page_no+=1

# Accounting & verification appendix
header('流程驗證結果與會計分錄', '自動化端對端驗證通過', page_no)
note_box([
 '庫存：0 → 進貨 +10 → 銷貨 -6 → 結存 4 PCS；期末存貨金額 320。',
 '應收：720，狀態 open；應付：800，狀態 open。',
 '所有測試交易均位於 inventory_erp_sc；SC 舊資料來源保持唯讀。'
],H-75)
rows=[
 ('應收傳票 JV-20260819-0001','借：應收帳款 720','貸：銷貨收入 720'),
 ('','借：銷貨成本 480','貸：商品存貨 480'),
 ('應付傳票 JV-20260819-0002','借：商品存貨 800','貸：應付帳款 800')]
y=H-230
for a,b,d in rows:
    c.setFillColor(HexColor('#F8F2EA')); c.rect(35,y-28,W-70,38,fill=1,stroke=0)
    text(48,y-12,a,10,True,BROWN); text(280,y-12,b,10); text(525,y-12,d,10); y-=48
note_box([
 '本次為可辨識示範資料：品號 DEMO-20260819-01、客戶 DEMO-CUST、廠商 DEMO-SUPP。',
 '若要刪除示範資料，應依「總帳→應收應付→庫存異動→銷貨→進貨→採購→請購→主檔」反向清除，避免破壞關聯。',
 '正式上線前仍需確認稅額、發票、會計科目與公司實際會計政策；本示範金額為未稅流程驗證。'
],H-405)
c.showPage()
c.save()
print(OUT)
