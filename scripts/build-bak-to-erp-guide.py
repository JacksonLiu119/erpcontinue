from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, PageBreak, KeepTogether
from PIL import Image as PILImage

ROOT = Path(r"C:\Users\jacks\OneDrive\文件\套erp模板")
OUT = ROOT / "output" / "pdf" / "客戶資料庫BAK轉ERP執行流程說明書.pdf"
TMP = ROOT / "tmp" / "pdfs" / "bak_erp_guide"
OUT.parent.mkdir(parents=True, exist_ok=True)
TMP.mkdir(parents=True, exist_ok=True)

FONT = Path(r"C:\Windows\Fonts\msjh.ttc")
FONT_BOLD = Path(r"C:\Windows\Fonts\msjhbd.ttc")
pdfmetrics.registerFont(TTFont("CJK", str(FONT)))
pdfmetrics.registerFont(TTFont("CJK-Bold", str(FONT_BOLD if FONT_BOLD.exists() else FONT)))

PAGE = landscape(A4)
W, H = PAGE
ACCENT = colors.HexColor("#8A4518")
ACCENT2 = colors.HexColor("#D9822B")
PALE = colors.HexColor("#FFF7EA")
INK = colors.HexColor("#202733")
MUTED = colors.HexColor("#607080")
GREEN = colors.HexColor("#238B57")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="CJKTitle", fontName="CJK-Bold", fontSize=25, leading=32, textColor=ACCENT, alignment=TA_CENTER, spaceAfter=12))
styles.add(ParagraphStyle(name="CJKSub", fontName="CJK", fontSize=12, leading=18, textColor=MUTED, alignment=TA_CENTER))
styles.add(ParagraphStyle(name="H1CJK", fontName="CJK-Bold", fontSize=18, leading=24, textColor=ACCENT, spaceAfter=8))
styles.add(ParagraphStyle(name="H2CJK", fontName="CJK-Bold", fontSize=13, leading=18, textColor=INK, spaceBefore=5, spaceAfter=4))
styles.add(ParagraphStyle(name="BodyCJK", fontName="CJK", fontSize=10, leading=15, textColor=INK, spaceAfter=4))
styles.add(ParagraphStyle(name="SmallCJK", fontName="CJK", fontSize=8.5, leading=12, textColor=MUTED))
styles.add(ParagraphStyle(name="Callout", fontName="CJK", fontSize=10, leading=15, textColor=INK, backColor=PALE, borderColor=ACCENT2, borderWidth=0.8, borderPadding=7, spaceBefore=5, spaceAfter=7))
styles.add(ParagraphStyle(name="CodeCJK", fontName="CJK", fontSize=8.5, leading=12, textColor=colors.HexColor("#16324A"), backColor=colors.HexColor("#EDF4F8"), borderPadding=6))

shots = {
    "ssms_home": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-d28900ea-b936-4517-904f-ef93cc9d56b6.png"),
    "restore_empty": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-0024deb0-22f8-46ad-84f9-1d942d676fb4.png"),
    "restore_selected": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-ed501ea6-ca15-40f2-b937-f9be5a76e4c0.png"),
    "restore_named": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-b5e898c9-eb31-4a88-8a3a-913372526d59.png"),
    "restore_files": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-99850ec3-0528-430a-b297-68e622d80a3e.png"),
    "restore_options": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-c9072234-5fc2-4122-aa3f-36636efa1e0f.png"),
    "restore_success": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-3cc5bb45-47a5-4f46-a744-64739b05bfa6.png"),
    "checkdb": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-8e147188-f8ca-4469-9877-d8bc1622b763.png"),
    "status": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-277d47e9-9c08-44ff-b180-dfbe418a156f.png"),
    "readonly_fail": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-cb9af24a-d2f0-4638-b9e5-b4b0997cabff.png"),
    "readonly_ok": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-401cfb13-4967-4d74-8abd-945cc3d90ef4.png"),
    "tables": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-2aeab572-2613-4674-989d-fe86ab4dd954.png"),
    "company": Path(r"C:\Users\jacks\AppData\Local\Temp\codex-clipboard-cdf57672-ac2e-4b66-a4b9-5baa6a81d66f.png"),
}
for name, path in shots.items():
    if not path.exists():
        raise FileNotFoundError(f"Missing screenshot: {name} {path}")

def img(path, max_w=720, max_h=390):
    with PILImage.open(path) as im:
        iw, ih = im.size
    scale = min(max_w / iw, max_h / ih)
    return Image(str(path), width=iw * scale, height=ih * scale)

def caption(text):
    return Paragraph(text, styles["SmallCJK"])

def bullet(text):
    return Paragraph("• " + text, styles["BodyCJK"])

def step_page(title, description, shot_key, notes):
    story.extend([Paragraph(title, styles["H1CJK"]), Paragraph(description, styles["BodyCJK"]), Spacer(1, 3*mm), img(shots[shot_key]), Spacer(1, 2*mm), caption(notes), PageBreak()])

def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#D8C9B8"))
    canvas.line(15*mm, 12*mm, W-15*mm, 12*mm)
    canvas.setFont("CJK", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(15*mm, 7*mm, "客戶資料庫 BAK 轉 ERP 執行流程說明書")
    canvas.drawRightString(W-15*mm, 7*mm, f"第 {doc.page} 頁")
    canvas.restoreState()

story = []
story += [Spacer(1, 25*mm), Paragraph("客戶資料庫 BAK 轉 ERP<br/>執行流程說明書", styles["CJKTitle"]),
          Paragraph("SQL Server 還原 → 唯讀封存 → MySQL raw → 獨立標準 ERP → 公司切換", styles["CJKSub"]), Spacer(1, 12*mm)]
summary = [
    ["本次案例", "盛慶股份有限公司（COMPANY=SC）"],
    ["SQL Server 暫存庫", "stg_SC_20260819（READ_ONLY）"],
    ["MySQL raw", "raw_sc_20260819（700 表，逐表差異 0）"],
    ["標準 ERP", "inventory_erp_sc（與 SH 分離）"],
    ["匯入結果", "基本主檔錯誤 0；歷史單據 113,682 筆，錯誤 0"],
]
t = Table(summary, colWidths=[45*mm, 145*mm], hAlign="CENTER")
t.setStyle(TableStyle([("FONTNAME",(0,0),(-1,-1),"CJK"),("FONTNAME",(0,0),(0,-1),"CJK-Bold"),("FONTSIZE",(0,0),(-1,-1),10),("BACKGROUND",(0,0),(0,-1),PALE),("GRID",(0,0),(-1,-1),0.5,colors.HexColor("#D8C9B8")),("VALIGN",(0,0),(-1,-1),"MIDDLE"),("TOPPADDING",(0,0),(-1,-1),7),("BOTTOMPADDING",(0,0),(-1,-1),7)]))
story += [t, Spacer(1, 10*mm), Paragraph("原則：原始 BAK、SQL Server 暫存庫與 raw MySQL 都不接受新 ERP 寫入；新單據只寫入該客戶的獨立標準庫。", styles["Callout"]), PageBreak()]

story += [Paragraph("一、整體架構與命名", styles["H1CJK"]),
          Paragraph("每一家客戶建立一組穩定路由，不以顯示名稱直接當作資料庫識別。", styles["BodyCJK"])]
arch = [["階段","本次名稱","用途","可否寫入"],
        ["原始備份","SC_backup_*.bak","法律／追溯保存","否"],
        ["SQL Server 暫存","stg_SC_20260819","完整性檢查、來源盤點","設為唯讀"],
        ["MySQL raw","raw_sc_20260819","完整原始表、重新匯入來源","否"],
        ["控制庫","inventory_erp","公司、登入、權限、資料庫路由","控制資料"],
        ["標準 ERP","inventory_erp_sc","主檔、歷史單據、未來新單據","是"]]
t=Table(arch,colWidths=[35*mm,50*mm,105*mm,30*mm])
t.setStyle(TableStyle([("FONTNAME",(0,0),(-1,-1),"CJK"),("FONTNAME",(0,0),(-1,0),"CJK-Bold"),("BACKGROUND",(0,0),(-1,0),ACCENT),("TEXTCOLOR",(0,0),(-1,0),colors.white),("GRID",(0,0),(-1,-1),0.5,colors.HexColor("#D8C9B8")),("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white,PALE]),("FONTSIZE",(0,0),(-1,-1),9),("VALIGN",(0,0),(-1,-1),"MIDDLE"),("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6)]))
story += [t, Spacer(1,6*mm), Paragraph("命名範例：stg_客戶代號_日期、raw_客戶代號_日期、inventory_erp_客戶代號。來源 COMPANY 必須由資料內容確認，不可只用 BAK 檔名推定。",styles["Callout"]), PageBreak()]

step_page("二、在 SSMS 確認連線與現有資料庫", "連線到正確的 SQL Server 執行個體，先確認現有 SH、SMARTDSCSYS 等資料庫，避免還原時覆蓋正式庫。", "ssms_home", "圖 1　SSMS 物件總管。本次連線為 JACKSON，後續一律建立新的 staging 名稱。")
step_page("三、選擇 BAK 備份裝置", "資料庫節點按右鍵 → 還原資料庫 → 來源選擇「裝置」→ 瀏覽選取客戶提供的 .bak。選取前下方備份組會是空白。", "restore_empty", "圖 2　尚未選取有效備份組時，不要按確定。")
step_page("四、確認備份組可讀取", "選到正確 BAK 後，畫面會列出備份集、來源伺服器、原始資料庫與備份日期。勾選要還原的完整備份。", "restore_selected", "圖 3　備份來源資料庫為 SC，備份類型為完整。")
step_page("五、指定新的暫存資料庫名稱", "目的地資料庫不可沿用正式 SC 名稱。本次使用 stg_SC_20260819，未來依客戶代號與還原日期命名。", "restore_named", "圖 4　使用 staging 名稱可避免覆蓋正式資料庫，並方便後續封存。")
step_page("六、調整 MDF／LDF 目的路徑", "在「檔案」頁確認資料檔與記錄檔會放到目前 SQL Server 的 DATA 目錄，檔名同樣使用 staging 名稱，避免與舊檔案撞名。", "restore_files", "圖 5　資料檔 stg_SC_20260819.mdf，記錄檔 stg_SC_20260819.LDF。")
step_page("七、確認還原選項", "新 staging 資料庫不需要勾選覆寫現有資料庫。復原狀態維持 RESTORE WITH RECOVERY，確認後執行還原。", "restore_options", "圖 6　不要勾選 WITH REPLACE，除非已明確確認要覆蓋且另有備份。")
step_page("八、確認還原成功", "還原完成後重新整理資料庫節點，應看到新的 stg_SC_20260819。不要刪除原始 BAK。", "restore_success", "圖 7　stg_SC_20260819 已出現在物件總管。")

story += [Paragraph("九、完整性檢查與等待方式", styles["H1CJK"]), Paragraph("先查狀態，再執行 DBCC CHECKDB。大型資料庫可能需要數分鐘；本次約 5 分鐘完成。執行期間不要重複按 F5，也不要因畫面暫時沒有結果就中止。", styles["BodyCJK"]),
          Paragraph("SELECT name,state_desc,user_access_desc,recovery_model_desc,is_read_only FROM sys.databases WHERE name=N'stg_SC_20260819';<br/>DBCC CHECKDB (N'stg_SC_20260819') WITH NO_INFOMSGS;", styles["CodeCJK"]), Spacer(1,3*mm), img(shots["checkdb"]), caption("圖 8　DBCC CHECKDB 執行中的畫面。若最後沒有錯誤訊息，即可進入唯讀設定。"), PageBreak()]

story += [Paragraph("十、設定 SQL Server staging 唯讀", styles["H1CJK"]), Paragraph("第一次使用 WITH NO_WAIT 可能因資料庫仍有連線而失敗，這不代表資料庫損壞。改在 master 執行 WITH ROLLBACK IMMEDIATE，會中止 staging 上既有連線後切成唯讀。", styles["BodyCJK"])]
two = Table([[img(shots["readonly_fail"],340,300), img(shots["readonly_ok"],340,300)]], colWidths=[110*mm,110*mm])
two.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),2),("RIGHTPADDING",(0,0),(-1,-1),2)]))
story += [two, Table([[caption("圖 9　NO_WAIT 因使用中而失敗。"), caption("圖 10　ROLLBACK IMMEDIATE 成功，is_read_only=1。")]], colWidths=[110*mm,110*mm]),
          Spacer(1,4*mm), Paragraph("USE master;<br/>ALTER DATABASE [stg_SC_20260819] SET READ_ONLY WITH ROLLBACK IMMEDIATE;", styles["CodeCJK"]), PageBreak()]

story += [Paragraph("十一、盤點表數、筆數與 COMPANY", styles["H1CJK"]), Paragraph("盤點所有使用者資料表，再檢查 COMPANY 欄位分布。不同 COMPANY 必須分成不同公司上下文，不得整庫混成同一家公司。", styles["BodyCJK"])]
two = Table([[img(shots["tables"],350,315), img(shots["company"],350,315)]], colWidths=[112*mm,112*mm])
two.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP")]))
story += [two, Spacer(1,3*mm), Paragraph("本次確認：700 張 SQL Server 基礎表；COMPANY=SC；公司全名為盛慶股份有限公司。", styles["Callout"]), PageBreak()]

story += [Paragraph("十二、SQL Server 轉 MySQL raw", styles["H1CJK"]),
          bullet("使用 Windows／SSMS 可用身分連線 SQL Server，來源保持 READ_ONLY。"),
          bullet("建立新 raw_sc_20260819，不覆蓋 SH、SMARTDSCSYS、DSCRPT 或 inventory_erp。"),
          bullet("完整轉換欄位結構與 700 張表資料；image／binary 欄位先轉 varbinary(max) 再輸出。"),
          bullet("CSV 暫存路徑使用純英文，避免 MySQL 無法讀取中文 OneDrive 路徑。"),
          bullet("local_infile 僅匯入期間暫時開啟，完成後必須關回 OFF。"), Spacer(1,5*mm)]
mysql_result=[["檢查項目","結果"],["SQL Server 表數","700"],["MySQL raw 表數","700"],["逐表筆數一致","700"],["筆數差異","0"],["local_infile","OFF"]]
t=Table(mysql_result,colWidths=[80*mm,80*mm],hAlign="LEFT")
t.setStyle(TableStyle([("FONTNAME",(0,0),(-1,-1),"CJK"),("FONTNAME",(0,0),(-1,0),"CJK-Bold"),("BACKGROUND",(0,0),(-1,0),ACCENT),("TEXTCOLOR",(0,0),(-1,0),colors.white),("GRID",(0,0),(-1,-1),0.5,colors.HexColor("#D8C9B8")),("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white,PALE]),("ALIGN",(1,1),(-1,-1),"CENTER"),("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6)]))
story += [t, Spacer(1,5*mm), Paragraph("完整逐表核對報告：output/migration_stg_SC_20260819/row-count-comparison.csv", styles["SmallCJK"]), PageBreak()]

story += [Paragraph("十三、建立獨立標準 ERP 與匯入", styles["H1CJK"]),
          Paragraph("raw 僅供查核；真正供使用者繼續建立單據的是 inventory_erp_sc。控制庫 inventory_erp 只保存登入、權限與路由。", styles["BodyCJK"])]
imports=[["資料群","來源","目標筆數／結果"],["公司","CMSML","1"],["庫別","CMSMC","8"],["部門","CMSME","10"],["員工","CMSMV","33"],["品號","INVMB","1,970"],["客戶","COPMA","38"],["廠商","PURMA","300"],["歷史單據","COP/PUR/ACR/ACP","113,682 筆，錯誤 0"]]
t=Table(imports,colWidths=[45*mm,65*mm,90*mm])
t.setStyle(TableStyle([("FONTNAME",(0,0),(-1,-1),"CJK"),("FONTNAME",(0,0),(-1,0),"CJK-Bold"),("BACKGROUND",(0,0),(-1,0),ACCENT),("TEXTCOLOR",(0,0),(-1,0),colors.white),("GRID",(0,0),(-1,-1),0.5,colors.HexColor("#D8C9B8")),("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white,PALE]),("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6)]))
story += [t, Spacer(1,5*mm), Paragraph("每筆標準資料保留 tenant_id=SC、company_id=SC、source_system=iSM、source_database=SC、source_table、source_key 與匯入批次，確保可追溯且可重跑。", styles["Callout"]), PageBreak()]

story += [Paragraph("十四、公司切換與驗收", styles["H1CJK"])]
for x in [
    "公司選單顯示：盛慶股份有限公司；統編 23520952。",
    "SC 原始查詢讀取 raw_sc_20260819，不寫回來源。",
    "SC 的新增、修改、核準與新單據寫入 inventory_erp_sc。",
    "採購近期 10 筆可查；驗收第一筆為 3310/20260818009。",
    "應收近期 10 筆可查；驗收第一筆為 6102/20260806001。",
    "SH 與 SC 使用不同 target_database，切換公司時由伺服器決定路由，前端不能任意指定其他公司。",
]: story.append(bullet(x))
story += [Spacer(1,5*mm), Paragraph("注意：本次來源 COPTA/COPTB 的銷售訂單筆數為 0，但 COPTG/COPTH 銷貨資料存在；應呈現『查無資料』，不可誤判匯入失敗。", styles["Callout"]), PageBreak()]

story += [Paragraph("十五、下一家客戶重複執行檢查表", styles["H1CJK"])]
checks = [
"保存原始 BAK、大小、日期與 SHA-256。", "RESTORE HEADERONLY／FILELISTONLY／VERIFYONLY。",
"還原到新的 stg_客戶_日期，不覆蓋正式庫。", "執行 DBCC CHECKDB 並保存結果。",
"設定 staging READ_ONLY，確認 is_read_only=1。", "盤點表數、逐表筆數與 COMPANY 分布。",
"建立新的 raw_客戶_日期，不覆蓋既有 raw。", "轉 MySQL 後逐表核對，差異必須為 0 或有書面說明。",
"建立 inventory_erp_客戶並套用完整 migrations。", "依序匯入主檔、庫存、採購、銷售、應收應付。",
"建立匯入批次與錯誤清單；保存來源鍵。", "驗證公司切換、近期 10 筆、查無資料與新單據寫入位置。",
"完成後關閉 local_infile，raw 與 staging 保持唯讀。", "備份標準 ERP，保留回復方案後才切換正式使用。"
]
data=[]
for i in range(0,len(checks),2): data.append([Paragraph("☐ "+checks[i],styles["BodyCJK"]),Paragraph("☐ "+checks[i+1],styles["BodyCJK"])])
t=Table(data,colWidths=[110*mm,110*mm])
t.setStyle(TableStyle([("GRID",(0,0),(-1,-1),0.4,colors.HexColor("#D8C9B8")),("ROWBACKGROUNDS",(0,0),(-1,-1),[colors.white,PALE]),("VALIGN",(0,0),(-1,-1),"TOP"),("TOPPADDING",(0,0),(-1,-1),7),("BOTTOMPADDING",(0,0),(-1,-1),7)]))
story += [t, Spacer(1,5*mm), Paragraph("完成條件：來源可追溯、raw 唯讀、逐表核對通過、公司資料隔離、標準 ERP 可繼續建立新單據，且可回復。", styles["Callout"])]

doc = SimpleDocTemplate(str(OUT), pagesize=PAGE, rightMargin=15*mm, leftMargin=15*mm, topMargin=14*mm, bottomMargin=17*mm, title="客戶資料庫BAK轉ERP執行流程說明書", author="CFuture ERP")
doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
print(OUT)
