---
layout: post
title: "貼紙貼了、燒錄卻沒對上？ISP 燒錄站接 MES 的四個交易邊界坑"
date: 2026-11-18
tags: [MES, ISP, Factory, Traceability, Python]
level: advanced
prerequisites: ["FW release management 與 versioning", "DDC/CI 與產線校正站基礎"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: senior
sources_checked: 2026-11-18
description: "ISP 燒錄站接 MES，序號標籤與燒錄內容對不上？說明配號、燒錄、驗證與 commit 順序，以及離線重送的四個交易邊界坑。"
difficulty: advanced
---
> **重點摘要**：MES 配號、燒錄器寫入、標籤機列印三個系統各自覺得成功，整台機器卻只能有一份身分。本文把燒錄流程當成分散式交易處理：ACK 不代表內容正確要做三段驗證，序號區要原子寫入、commit 最後寫，離線重送要用 outbox 加冪等鍵。

## 前置知識

先想一個很日常的場景：幫新生兒報戶口。

正確順序是戶政事務所先配一個號、醫院開出生證明、戶政把資料落檔、最後才印身分證。如果你先把身分證印好貼在嬰兒床上，之後才去報戶口，中間只要有人抱錯床，這張身分證就配到別的小孩身上；而且戶政那邊還可能出現兩筆不同時間、不同資料的登記，因為你重送了一次。

產線的 ISP 燒錄站就是這個故事。MES 是戶政事務所（配號、落檔），燒錄器是醫院產房（把內容寫進去），標籤機是印身分證的那台機器。三個系統各自覺得自己成功，但整台機器只有一份真正的身分。

要把這件事講清楚，得先知道工廠的系統分層。ISA-95 把製造現場分成五層：Level 0 是實體製程，Level 1 是感測與操作（sensor、智慧裝置），Level 2 是監控與監督控制（PLC、DCS），Level 3 是 MES 與 SCADA 這類製造作業管理系統，Level 4 是 ERP 這類業務規劃系統；ISA-95 標準主要處理的就是 Level 3 與 Level 4 之間的介面（ISA-95 官方頁面「The ISA-95 Model」段）。

燒錄站掛在 Level 1/2，MES 在 Level 3。設備層自己產生序號，等於把 Level 3 的職權下放給 Level 1，之後就沒有人能回答「這個序號到底是誰發的」。

## 技術核心

### 一、把「出生登記」當成一筆分散式交易

三個系統、一筆交易，順序錯了就全錯：

```
Reserve（MES 配號） → Program（燒錄） → Readback（讀回驗證） → Commit（MES 落檔） → Label（印標籤）
        ↑                                        ↑
   唯一發號源                          內容與 manifest 比對
```

每一步都要有明確的成功定義，而且前一步沒過就不能進下一步。實務上最常被偷掉的是 Readback 與 Commit 之間的那道門：站端只要看到燒錄器回 OK，就直接印標籤、直接回報 MES。

ISA-95 Part 8 談的是「資訊交換樣式（information exchange profiles）」，用動詞與名詞描述 Level 3 與 Level 4、或 Level 3 內部應用之間交換的物件模型（ISA-95 官方頁面 Part 8 段）。把這個概念縮小到站端，就是先把動詞定清楚：`Reserve`（取號）、`Commit`（落檔）、`Supersede`（重工覆蓋），而不是一個 `POST /ok` 打天下。

### 二、ACK 不是內容正確：三段驗證

OpenOCD 的文件把「送出」與「驗證」分得很清楚：`flash verify_bank` 會把檔案內容與 flash bank 內容逐位元組比對，不一致就 fail；`program` 這個 helper 的參數列有 `preverify` 與 `verify` 兩個獨立開關（OpenOCD User's Guide「Flash Commands」章）。沒顯式打開 verify，你拿到的是「我送出去了」。

還有個容易誤會的細節：`flash verify_image` 對每個 bank 只給整體 good/bad，不給個別 byte 位址（同一章說明）。另外，`program` 這個 helper 自己會先做 `init` 與 `reset init`（OpenOCD 原始碼 startup.tcl 的 `proc program`），站端不必再另外下；燒 `.bin` 檔則要在最後給燒錄位址。`flash read_bank` 沒給 length 時會讀到 bank 結尾（同一章），讀回來的大小跟 image 不同，hash 永遠對不上，所以一定要給 image 的長度。正確做法是三段：

```python
#!/usr/bin/env python3
# 示意：燒錄器 CLI 與路徑依現場而異；openocd 命令語意已對照 OpenOCD User's Guide。
import hashlib, os, subprocess, tempfile

def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def program_and_verify(cfg, image_bin, expected_sha, load_addr, bank=0, bank_off=0):
    # 第零段：燒之前先確認檔案就是 manifest 指定的那一份
    if file_sha256(image_bin) != expected_sha:
        return False, "image 與 manifest hash 不符"
    size = os.path.getsize(image_bin)

    # 第一段＋第二段：program 會自己做 init 與 reset init；.bin 要給燒錄位址
    p = subprocess.run(
        ["openocd", "-f", cfg,
         "-c", f"program {image_bin} verify reset exit {load_addr:#x}"],
        capture_output=True, text=True, timeout=180)
    if p.returncode != 0:
        return False, p.stderr.strip()[-400:]      # 回傳碼不為 0：燒錄或 verify 失敗

    # 第三段：只讀回 image 那一段（給 length），再跟 manifest 的 hash 比
    with tempfile.TemporaryDirectory() as d:
        rb = os.path.join(d, "readback.bin")
        subprocess.run(
            ["openocd", "-f", cfg,
             "-c", "init",
             "-c", "reset halt",
             "-c", f"flash read_bank {bank} {rb} {bank_off:#x} {size}",
             "-c", "shutdown"],
            check=True, capture_output=True, timeout=180)
        return file_sha256(rb) == expected_sha, "readback hash"
```

`load_addr`、`bank_off` 依晶片的 flash 位址對應填寫（示意參數）。`expected_sha` 不要讓操作員輸入。它應該來自 image manifest，跟工單一起被帶進站端程式。

### 三、序號區的原子寫入：commit 最後寫

序號、機種 ID、燒錄次數通常塞在 flash 的一小塊資料區。斷電發生在「erase 完、寫到一半」時，這塊資料會半新半舊；如果開機程式對 CRC 不對的處理是「用預設值繼續開」，機器就帶著一組不存在的序號出貨。

```c
/* 示意 offset 與 magic，非實際晶片規格 */
typedef struct {
    uint32_t magic;
    uint16_t format_ver;
    uint16_t attempt;          /* 第幾次燒錄，rework 追溯用 */
    uint32_t seq;              /* 單調遞增，決定哪一份較新 */
    uint8_t  product_id[8];
    uint8_t  panel_id[8];
    uint8_t  serial[16];       /* 由 MES 配發 */
    uint8_t  image_sha256[32];
    uint32_t fw_version;
    uint32_t crc32;            /* 涵蓋 crc32 之前的所有欄位 */
    uint32_t commit;           /* 最後才寫，不在 CRC 範圍內；erase 後為 0xFFFFFFFF＝未提交 */
} factory_id_t;

#define FACTORY_ID_COMMIT 0xA5C35A3Cu    /* 示意 commit 值 */

/* slot_off 必須對齊 erase sector，且這個 sector 只放這一份 slot */
int factory_id_write(const factory_id_t *in, uint32_t slot_off)
{
    factory_id_t tmp = *in;
    tmp.crc32 = crc32_ieee((const uint8_t *)&tmp,
                           offsetof(factory_id_t, crc32));

    if (nvram_erase(slot_off, sizeof(tmp)) != 0) return -1;      /* 示意 API */
    /* 只寫到 commit 之前；commit 保持 erase 狀態，NOR flash 之後才能再寫入 */
    if (nvram_program(slot_off, &tmp, offsetof(factory_id_t, commit)) != 0) return -1;

    factory_id_t rb;
    if (nvram_read(slot_off, &rb, sizeof(rb)) != 0) return -1;
    if (memcmp(&rb, &tmp, offsetof(factory_id_t, commit)) != 0) return -1;
    if (rb.commit != 0xFFFFFFFFu) return -1;                     /* commit 區必須還是空白 */

    uint32_t cw = FACTORY_ID_COMMIT;
    if (nvram_program(slot_off + offsetof(factory_id_t, commit), &cw, sizeof(cw)) != 0)
        return -1;
    if (nvram_read(slot_off + offsetof(factory_id_t, commit), &cw, sizeof(cw)) != 0)
        return -1;
    return (cw == FACTORY_ID_COMMIT) ? 0 : -1;                   /* commit 也要讀回確認 */
}
```

CRC 用哪個多項式不是重點，重點是參數要寫進團隊文件。RFC 1952 附錄那份樣板程式用的是多項式 0xedb88320、初值 0、前後各一次 one's complement（RFC 1952 §8），照抄就好，不必自己發明。

寫入順序是 erase → payload → 讀回比對 → commit。commit 擺在結構最後、且不列入 CRC 範圍，所以「CRC 對但資料半套」這種狀態不會被誤判成有效。寫 payload 時 commit 那 4 個 byte 一定要留空：NOR flash 只能把 bit 從 1 寫成 0，erase 後是 0xFFFFFFFF；如果先把 commit 寫成 0，之後再寫 commit 值，結果還是 0，而且函式照樣回報成功。所以 payload 只寫到 commit 之前，commit 寫完也要讀回確認。slot 要對齊 erase sector、一個 sector 只放一份，不然 erase 會連帶清掉旁邊的資料。開機時兩份 slot 都無效，就進工廠模式，不要用預設序號上線。

### 四、離線與重送：outbox 加冪等鍵

MES 掛掉時有兩種爛做法：整條線停擺，或站端自己生序號。前者傷 UPH，後者傷追溯。

可接受的折衷是「號段預配 + 本機 outbox」：MES 先給這個站一段可用序號，站端離線時從號段取用；號段用罄就停線，這是刻意的設計，不是 bug。紀錄先落本機 SQLite，再背景補送。

```python
# 示意：冪等鍵 = 序號 + attempt。重送摺成同一筆，重工則是新事件。
# MES 端也必須以 idem_key 去重（例如唯一索引），站端只負責每次都帶同一把鍵。
import json, time

SCHEMA = ("CREATE TABLE IF NOT EXISTS outbox("
          "idem_key TEXT PRIMARY KEY, payload TEXT NOT NULL, "
          "state TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL)")

def enqueue(db, idem_key, payload):
    db.execute(
        "INSERT OR IGNORE INTO outbox(idem_key,payload,state,next_at) "
        "VALUES(?,?,'pending',?)",
        (idem_key, json.dumps(payload), time.time()))
    db.commit()

def pump(db, mes, max_batch=20):
    rows = db.execute(
        "SELECT idem_key,payload,tries FROM outbox "
        "WHERE state='pending' AND next_at<=? ORDER BY next_at LIMIT ?",
        (time.time(), max_batch)).fetchall()
    for idem_key, payload, tries in rows:
        body = dict(json.loads(payload), idem_key=idem_key)   # 鍵要送到 MES，不能只存在本機
        try:
            r = mes.post("/api/v1/flash/commit", json=body,
                         headers={"Idempotency-Key": idem_key}, timeout=5)
            if 400 <= r.status_code < 500 and r.status_code not in (408, 429):
                db.execute("UPDATE outbox SET state='rejected' WHERE idem_key=?",
                           (idem_key,))                       # 資料被拒：重送也不會好，轉人工
            else:
                r.raise_for_status()
                db.execute("UPDATE outbox SET state='sent' WHERE idem_key=?",
                           (idem_key,))
        except Exception:
            backoff = min(60, 2 ** min(tries, 6))
            db.execute("UPDATE outbox SET tries=tries+1, next_at=? "
                       "WHERE idem_key=?", (time.time() + backoff, idem_key))
        db.commit()
```

為什麼冪等鍵不能只用序號？因為重工是合法的新事件。同一台機器第二次燒錄，需要留下第二筆紀錄（attempt 加一、新的 image hash），而不是把第一筆覆蓋掉。網路重送才應該被折成同一筆，這兩件事必須在鍵的設計上分開。還有一點：本機 `INSERT OR IGNORE` 只擋得住站端自己重複排隊。「回應在路上掉了、站端以為失敗又送一次」這種重送，要靠每次 POST 都帶同一把冪等鍵，而且 MES 端用這把鍵去重，兩邊缺一不可。MES 回 4xx（資料被拒）時重送也不會好，要轉人工，不要無限重試。

如果站端與 MES 之間走 OPC UA，安全設定別忘了開：OPC UA 用 X.509 憑證辨識每一個 client 與 server、以 message signing 驗來源與完整性、用序號封包防重放（OPC Foundation 頁面 Security 段）。產線網路常常被當成「內網所以沒關係」，但 ISP 站的寫入權限等於生產品質的根。

### 五、image manifest 要跟工單對得上

燒錯機種是試產線的經典事故：治具一樣、外殼一樣，只有 panel 參數不同。解法不是加人眼檢查，是讓 image 自帶 manifest：

```json
{
  "product_id": "M27Q-A",
  "panel_id": "AUO-M270QAN01",
  "hw_rev": "EVT2",
  "fw_version": "1.4.2",
  "sha256": "<64 hex>",
  "security_cnt": 14
}
```

站端在 Reserve 之前先比對 `product_id`、`panel_id`、`hw_rev` 與工單，不符就停線。manifest 裡的 hash 同時是前面讀回驗證的 `expected_sha`，中間沒有給人工輸入的機會。

順帶一個換料坑：燒錄器要知道 flash 的容量、page size、sector size 才能正確 erase/program。JEDEC 的 SFDP 就是為此存在，其中 Parameter ID FF00h 的 header 與 Basic Parameter Table 是強制項（JEDEC JESD216H 頁面，2025 年 8 月版）。OpenOCD 的 `stmqspi` driver 說明寫得很直白：內建硬編表優先，表上沒有才試 SFDP，SFDP 失敗或結果不合理就得手動設定（OpenOCD User's Guide，stmqspi 段）。換一顆「相容」但不在表上的 flash，站點就可能直接掛在那裡。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某機種 PVT 時，產線把燒錄 OK 直接當成通關條件：燒錄器回 OK、標籤機印貼紙、站端打一筆 `POST /ok` 給 MES。標籤是燒錄前就印好的，因為產線覺得「先印比較順」。

後來 RMA 收到幾台客退，症狀是畫面會閃、OSD 版本頁顯示的版本與標籤上的工單版本不同。查 MES，同一個序號有兩筆燒錄紀錄，兩個 image hash 不一樣；產線的說法是第一次燒到一半跳電，重壓一次就好了，但重壓時沒有人去改標籤，MES 也沒擋重複回報。

協定層面其實沒有神祕的 bug：燒錄器回 OK 只代表命令被接受，站端沒開 verify，也沒讀回比對；序號由標籤機自己產流水號，跟燒錄檔、跟 MES 工單三方各自為政；序號區沒有 commit 旗標，跳電後那台機器是用「CRC 不對就填預設值」的路徑開起來的，於是帶著一組不存在的序號進了下一站。三個「各自成功」疊起來，就是一台身分與內容對不起來的機器。

修法不是去追那一次跳電，而是把三個系統的交易邊界重新畫一次：MES 配號、站端燒錄後讀回比對 manifest、commit 成功才印標籤，重工用 attempt 表達。

## 新人避坑指南

- 看到「燒錄成功」先問一句：這是回傳碼，還是內容比對？兩者差很多。
- 燒錄器 CLI 的 verify 開關要寫進站點設定檔，不要靠操作員記得加參數。
- `flash verify_image` 的 good/bad 是 per-bank，不是 per-byte；要定位錯誤得自己讀回分段比對。
- CRC 的涵蓋範圍要寫在格式文件裡。commit 欄位刻意排除在 CRC 之外，這是設計，不是漏寫。
- 序號只能有一個發號源。站端自己產流水號，等於自斷追溯。
- 冪等鍵設計時先問：重送與重工在你的系統裡是不是同一件事？如果不是，鍵就不能只用序號。
- 標籤列印排在 commit 之後。真的要先印，貼紙上要有 pending 標示與重印同號的流程。
- 換 flash 料號要重跑站點自我測試，尤其是靠硬編表的燒錄器。
- 時間欄位以 MES 回傳的 server timestamp 為準，站端時間只當本地排序參考；產線 PC 的時鐘漂移是常態。

## 思考題

假設你的燒錄器在 SFDP 讀不到、硬編表也沒有這顆 flash 的情況下，仍然回報燒錄成功，但隔天同一批貨出現隨機的參數錯亂。你要如何在不拆機的前提下，證明問題出在 sector size 被猜錯，而不是 image 本身有問題？

<details>
<summary>提示</summary>

先看 OpenOCD 對 `stmqspi` 的說明：硬編表優先，表上沒有才試 SFDP，失敗就必須手動設定。再想：erase 的邊界如果比 image 大，會發生什麼事？讀回比對能不能抓到「多擦掉的那一段」？還需要哪一種比對（例如分段 CRC 或整區 hash）才抓得到？
</details>

## 參考資料

- JEDEC, Serial Flash Discoverable Parameters (SFDP), JESD216H（2025 年 8 月），https://www.jedec.org/standards-documents/docs/jesd216b （官方）
- ISA, ISA-95 Series of Standards: Enterprise-Control System Integration, https://www.isa.org/standards-and-publications/isa-standards/isa-95-standard （官方）
- OPC Foundation, Unified Architecture, https://opcfoundation.org/about/opc-technologies/opc-ua/ （官方）
- OpenOCD User's Guide, Flash Commands, https://openocd.org/doc/html/Flash-Commands.html （開源專案官方文件）
- P. Deutsch, GZIP file format specification version 4.3, RFC 1952, https://www.rfc-editor.org/rfc/rfc1952.txt （IETF）
- NIST, FIPS 180-4 Secure Hash Standard (SHS), https://csrc.nist.gov/pubs/fips/180-4/upd1/final （官方）
