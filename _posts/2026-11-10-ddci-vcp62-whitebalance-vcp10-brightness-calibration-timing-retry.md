---
layout: post
title: "VCP 0x62 寫下去，動的是喇叭音量：產線白平衡校正的時序、重試與超時"
date: 2026-11-10
tags: [DDC/CI, MCCS, VCP, 白平衡, 校正, ddcutil, CA-410, 產線]
level: intermediate
prerequisites: ["DDC/CI 與 MCCS 入門：用 ddcutil 控制顯示器", "工廠色彩校正流程與 takt time"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: practitioner
sources_checked: 2026-11-10
description: "VCP 0x62 在 MCCS 標準裡是喇叭音量，不是白平衡。本文說明白平衡正確的 VCP 碼，以及校正腳本的時序、重試與超時。"
seo_title: "VCP 0x62 是喇叭音量：白平衡校正時序與重試"
difficulty: intermediate
---
> **重點摘要**：VCP 0x62 在 MCCS 2.2a 是 Audio speaker volume，不是白平衡 gain。白平衡的標準路徑是 16h、18h、1Ah 的 RGB gain 與 6Ch、6Eh、70h 的 black level。寫入時要依規格等待、設定重試次數，並分辨 Null Message 的意義，避免假成功。

校正站的腳本照著 scaler SDK 的文件寫，用 DDC/CI 的 VCP 0x62 當白平衡 gain，跑了幾個月都沒事，直到品牌客戶拿 ddcutil 來驗收，才發現這個碼在標準裡根本不是白平衡——是喇叭音量。這篇要講清楚三件事：0x62 的標準語意到底是什麼、白平衡的正確寫法走哪幾個碼、以及校正腳本的重試與超時該怎麼設計才不會假成功。

## 前置知識

先建立一個工程類比：把 DDC/CI 想成飯店的房務對講機。

- I2C 是那條對講機線路。顯示器在這條線上的位址是固定的：以 7-bit 表示法是 0x37（EDID 在 0x50），這也是 ddcutil 與 i2cdetect 用的表示法；VESA 文件有時寫成 0x6E/0x6F，那是把讀寫位元算進去的 8-bit 寫法，兩種指的是同一個裝置（ddcutil References 頁對這個混淆有專門說明）。
- DDC/CI（Display Data Channel Command Interface）是對講機的通話規則：誰先講、講完等多久、講不通怎麼重試。
- MCCS（Monitor Control Command Set）是通話的「內容字典」：每個 VCP（Virtual Control Panel）feature code 代表顯示器上的一個控制項，例如 0x10 是亮度、0x12 是對比。

關鍵在於：這本字典是 VESA 標準，不是各家 SDK 自己愛怎麼編就怎麼編。你私接一個房間編號，總機（任何走標準語意的工具）撥過去，接起來的就是別人。

## 技術核心

### 0x62 在 MCCS 2.2a 的真身：Audio speaker volume

直接查 VESA MCCS 2.2a 標準原文（2011 年 7 月 13 日發布，是發布日期最新的版本；另有 2006 年的 MCCS 3.0，業界較少採用），第 7.4 節 Audio Adjustments（PDF p.29）明列：

- Audio: speaker volume — VCP Code 62h — R/W — C（Continuous，詳細定義在 Table 8-15，PDF p.90）

整份 MCCS 2.2a 沒有任何名為 "White balance" 的 VCP code。ddcutil 的 VCP 資料庫也一樣：62 列為 Audio speaker volume，而且 MCCS 2.0、2.1、3.0、2.2 四個版本都是這個語意。

那「0x62 是白平衡」從哪來的？是 scaler SDK 的私有用法：廠商在自己的 FW 裡把 0x62 實作成白平衡 gain，SDK 文件跟著這樣寫。自家腳本配自家 FW，閉門造車不會出事；但只要有一方回到標準語意——客戶的驗收工具、使用者的 OS 端監控軟體、一個 ddcutil——寫 0x62 就是在調喇叭音量。

### 白平衡的標準路徑：16h/18h/1Ah 與 6Ch/6Eh/70h

MCCS 2.2a 裡，白平衡該用的是這兩組（R/W、Continuous；總覽在 PDF p.27，詳細定義在 Table 8-4 Image Adjustment VCP Codes，PDF p.34–39；§10.6 是連續控制項的相容性測試程序，不是定義處）：

| VCP code | 名稱 | 用途 |
| --- | --- | --- |
| 16h | Video Gain (Drive): Red | 白平衡 gain |
| 18h | Video Gain (Drive): Green | 白平衡 gain |
| 1Ah | Video Gain (Drive): Blue | 白平衡 gain |
| 6Ch | Video Black Level: Red | 白平衡 offset/black level |
| 6Eh | Video Black Level: Green | 白平衡 offset/black level |
| 70h | Video Black Level: Blue | 白平衡 offset/black level |

兩個附帶規則要記住：14h Select Color Preset 會與 16h/18h/1Ah/6Ch/6Eh/70h 連動（preset 一切，gain 跟著變）；MCCS 也要求這幾個碼的變化要透過 02h 與 52h 回報。另外 0x10 的標準名稱是 Luminance，MCCS 原文特別註明對外稱呼用 Brightness——它是影像亮度，不是絕對背光位準，會被 picture mode 與 gamma 設定影響。MCCS 2.2 另有 6Bh/6Dh/6Fh/71h（Backlight Level: White/Red/Green/Blue），但量產 FW 對這組的支援度各廠不一（待查證：需對手上 SDK 文件確認）。

### 寫入時序：40ms、至少重試 3 次、null message

DDC/CI 1.1 標準（2004 年 10 月 29 日）對時序寫得很具體：

- host 送出訊息後，必須至少等 40 ms 才能開始讀回應，讓顯示器有時間解碼並準備回覆（DDC/CI 1.1 PDF p.22、p.29）。
- 通訊建立失敗時，host 至少重試 3 次，重試前與每次重試之間等 40 ms（PDF p.25）。
- 走 expander/duplicator（一對多分配器，例如視訊牆）時，回應時間要從 40 ms 放寬到 120 ms（PDF p.35）。
- 顯示器被 host 讀取、但沒有答案可給（還沒準備好或不支援）時，應回 null message：`S - 6Fa - 6Ea - 80a - CHKn - P`，長度位元組 80h 代表長度 0（PDF p.28）。checksum 是 XOR，而且計算時要把虛擬 host 位址 0x50 算進去（PDF p.27）。
- 注意：Set VCP Feature 本身沒有回覆封包，顯示器忙碌時無法用 null message「回絕寫入」；host 要靠後續的 Get VCP 讀回來確認。

ddcutil 的實作文件補了實務面：它把規則摘要成「送出後等 40–200 ms（依操作而定）」，並提供 --sleep-multiplier 調整、--maxtries 調整嘗試次數上限（write-only 預設 4 次、write-read 10 次、multi-part 8 次，最高可設 15；重試次數是嘗試次數減 1）。

最容易被忽略的一條：setvcp 收到的 I2C 層回應只代表「封包收到了」，不代表「執行完了」[^1]。所以 ddcutil 的 setvcp 預設會再做一次 getvcp 驗證，--noverify 只是省時間的選項。校正腳本如果寫完 gain 立刻叫 CA-410 量測，可能量到上一輪的畫面。

### 修正程式碼：寫入層與 FW 端對稱修正

Python 寫入層（校正站端）：

```python
# 已查證：VCP 語意（MCCS 2.2a）、40ms 最小等待與至少 3 次重試（DDC/CI 1.1）、
#         ddcutil 選項行為（ddcutil 官方文件）。
# 示意：0x62 當白平衡是廠商私有用法，僅在 capabilities string 證實後才可用。
import subprocess, time, re

VCP_LUMINANCE = 0x10   # Luminance（對外名 Brightness）
VCP_GAIN_R, VCP_GAIN_G, VCP_GAIN_B = 0x16, 0x18, 0x1A  # Video Gain (Drive)
VCP_SETTINGS  = 0xB0   # 01h=store, 02h=restore
VCP_AUDIO_SPEAKER = 0x62  # MCCS 2.2a＝Audio: speaker volume，不是白平衡！

def ddc_setvcp_batch(bus, pairs, sleep_mult=1.0, tries_outer=2):
    # ddcutil 一條 setvcp 可帶多組 feature/value（官方範例：setvcp 10 50 12 75）
    # 注意：ddcutil 把 feature code 當十六進位解析，必須送 "16"，不能送 str(0x16)＝"22"
    argv = ["ddcutil", "--bus", str(bus),
            "--sleep-multiplier", str(sleep_mult),
            "--disable-dynamic-sleep",   # 防多 DUT 並行污染統計檔
            "setvcp"] + [v for p in pairs for v in (f"{p[0]:02x}", str(p[1]))]
    wait = 0.040 * sleep_mult            # DDC/CI 1.1：至少 40ms
    # ddcutil 內部已對 write-only 嘗試 4 次；外層只補少量重試，避免 4×4 次把 DUT 打得更忙
    for attempt in range(1, tries_outer + 1):
        rc = subprocess.run(argv, capture_output=True, text=True)
        if rc.returncode == 0:
            return True
        time.sleep(wait * attempt)       # 線性退讓
    return False

def verify_value(bus, vcp, expect, tol=0, settle_s=0.15):
    time.sleep(settle_s)                 # 給 pipeline 生效時間
    out = subprocess.run(
        ["ddcutil", "--bus", str(bus), "--brief",
         "--disable-dynamic-sleep", "getvcp", f"{vcp:02x}"],
        capture_output=True, text=True).stdout.strip()
    # --brief 連續型輸出示例：VCP 16 C 50 100（倒數第二欄是目前值，最後一欄是最大值；格式待實機確認）
    m = re.search(r"\bC\s+(\d+)\s+(\d+)\s*$", out)
    if not m or abs(int(m.group(1)) - expect) > tol:
        raise RuntimeError(f"verify failed: VCP {vcp:02X} -> {out!r}")   # ack 不等於執行完成

def calibrate_white_point(bus, gains):
    # 標準碼優先；私有碼必須由 capabilities string 證實，寧可停線也不猜
    pairs = [(VCP_GAIN_R, gains["r"]), (VCP_GAIN_G, gains["g"]),
             (VCP_GAIN_B, gains["b"])]
    if not ddc_setvcp_batch(bus, pairs):
        raise RuntimeError("no response")
    for vcp, val in pairs:
        verify_value(bus, vcp, val)
    if not ddc_setvcp_batch(bus, [(VCP_SETTINGS, 0x01)]):  # B0h=01h store（MCCS PDF p.32）
        raise RuntimeError("store failed")
```

FW 端（顯示器這一側）要對稱修正：host 來讀、但答案還沒準備好時，回 null message，不要讓 host 讀到舊資料或亂碼；Set 寫入塞不進佇列時，記下錯誤，讓後續 Get 讀回能反映「沒生效」。

```c
/* display 位址 0x6E/6Fh、虛擬 host 位址 0x50、null message 長度 80h、
 * XOR checksum：出自 DDC/CI 1.1（PDF p.13、p.27、p.28）。 */
#define DDC_ADDR_DISPLAY_SRC  0x6Eu  /* 回覆封包的 source byte */
#define DDC_ADDR_VHOST        0x50u  /* checksum 要算進去的虛擬 host 位址 */
#define DDC_NULL_LEN          0x80u  /* 長度 0 的編碼 */

/* 示意地址，非實際晶片規格：scaler 內部佇列剩餘空間 */
#define REG_DDC_QUEUE_FREE  (*(volatile unsigned char *)0x3A02u)

static unsigned char ddc_checksum(const unsigned char *p, int n)
{
    unsigned char c = 0;
    while (n--) c ^= *p++;   /* XOR checksum（DDC/CI 1.1 Table 3） */
    return c;
}

/* 準備 null message，等 host 下一次從 0x6F 讀取時送出（slave 不能主動發送） */
void ddc_prepare_null_reply(void)
{
    unsigned char m[3];
    unsigned char vh = DDC_ADDR_VHOST;
    m[0] = DDC_ADDR_DISPLAY_SRC;  /* source = 0x6E */
    m[1] = DDC_NULL_LEN;          /* 0x80：長度 0 */
    m[2] = ddc_checksum(&vh, 1) ^ ddc_checksum(m, 2);  /* 0x50 ^ 0x6E ^ 0x80 */
    i2c_slave_load_reply(m, 3);   /* 底層驅動，示意 */
}

void ddc_on_get_vcp(unsigned char vcp)
{
    if (!vcp_value_ready(vcp)) {      /* 示意：pipeline 尚未套用完成 */
        ddc_prepare_null_reply();     /* 沒答案：回 null，host 等 40ms 後重試 */
        return;
    }
    ddc_prepare_get_vcp_reply(vcp);   /* 示意 */
}

void ddc_on_set_vcp(unsigned char vcp, unsigned char val)
{
    if (REG_DDC_QUEUE_FREE == 0u) {   /* 佇列滿：Set 沒有回覆封包可用 */
        vcp_mark_rejected(vcp);       /* 示意：之後 Get 讀回舊值，host 驗證會發現 */
        return;
    }
    queue_push(vcp, val);             /* 入佇列，pipeline 同 vblank 生效（示意） */
}
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某機種的白平衡校正站照 SDK 建議用 VCP 0x62 寫 gain、0x10 定亮度位準。小量產沒事，量產三個月後三件事同時爆：

1. 客訴（Claim）：內建喇叭的 SKU，使用者回報喇叭音量自己跑掉。遠端收 log 發現出貨前有第三方色彩工具讀寫過 0x62——在標準語意裡，那就是在動音量。
2. 驗收 fail：品牌客戶用 ddcutil 做相容性測試，`ddcutil getvcp 62` 回報 Audio speaker volume，跟校正報告裡「0x62 = 白平衡」對不起來，判定 VCP 實作與 MCCS 語意衝突。
3. 校正站假成功：setvcp 的 ack 有回來，腳本立刻觸發 CA-410 量測，量到的是上一輪畫面，重測率從 2% 爬到 9%，takt time 跟著崩。

三個症狀共用兩個根因：VCP 碼的語意沒有對標準（0x62 撞掉 MCCS 2.2a §7.4 的定義），以及把 I2C ack 當執行完成（DDC/CI 1.1 的 40ms 等待與 ddcutil 的寫後驗證語意都沒進腳本）。修正後：白平衡走 16h/18h/1Ah、寫後 settle 加讀回驗證、B0h store 加斷電複測，重測率回到個位數下緣，客戶驗收重跑過關。

## 新人避坑指南

- SDK 給你的 VCP code，先去 MCCS 2.2a 原文對一遍再寫進腳本。特別小心 0x62 這種「私有白平衡／標準音量」兩棲碼：自家 FW 配自家腳本不會爆，爆的時候一定是在客戶面前。
- 白平衡走標準路徑：gain 用 16h/18h/1Ah，black level 用 6Ch/6Eh/70h；0x62 只有在 DUT 的 capabilities string 證實為廠商私有語意時才可用，而且要跟客戶工具約定好。
- 寫入時序三件事：送出後至少等 40ms（DDC/CI 1.1）；失敗至少重試 3 次、每次間隔 40ms；走分配器的工位 timeout 放寬到 120ms。
- ack 不是執行完成。寫後讀回驗證（對齊 ddcutil setvcp 預設行為），對 0x10 這種連動 pipeline 的碼加 settle 時間；驗證不過才重試，不要盲試。
- 錯誤要分類：讀取時收到 null message（長度 0）＝還沒準備好或不支援，退讓重試；NACK＝匯流排層問題，查線材與位址；讀回不符＝pipeline 未生效，加長 settle。三種混在一起用同一個 timeout，只會把 DUT 打到更忙。
- 校正完寫 B0h=01h store，下一站斷電重開複測，才算真的持久化。
- 多 DUT 並行時用 --bus 綁定實體埠、--disable-dynamic-sleep 關掉統計檔共享，否則 ddcutil 的動態睡眠統計會互相污染（細節見 2026-11-04 的並行校正站筆記）。
- CA-410 的量測 timeout 依亮度分檔，低灰階量測時間長，單一 timeout 會造成低灰階假失敗（細節見 2026-11-01 的 CA-410 筆記）。

## 思考題

MCCS 2.2a 規定 14h Select Color Preset 會與 16h/18h/1Ah/6Ch/6Eh/70h 連動。假設你的校正腳本寫完 gain、驗證通過、也 store 了，但使用者拿到機器後把 color preset 從 User 切到 sRGB 再切回來——校正值還在嗎？FW 端要怎麼設計，才能讓「使用者模式」與「出廠校正值」互不踩腳？提示：去查 MCCS 2.2a 對 14h 的 MH byte（tolerance）定義，以及 02h/52h 的回報機制。

<details>
<summary>方向提示（先自己查再開）</summary>

校正值要放在使用者模式碰不到的 factory slot，picture mode 切換只允許在使用者槽內套用；FW 收到 14h 變更時，對 16h/18h/1Ah 的連動寫入必須限定在使用者槽，並照 MCCS 要求用 02h/52h 回報變化，讓外部工具看得到「誰改了 gain」。
</details>

## 參考資料

1. VESA Monitor Control Command Set (MCCS) Standard Version 2.2a, July 13, 2011。官方清單：VESA Standards 頁（https://vesa.org/vesa-standards/ ，官方）；公開鏡像：https://milek7.pl/ddcbacklight/mccs.pdf （非官方）。頁碼為該鏡像 PDF 頁序：62h＝Audio: speaker volume（§7.4 p.29、Table 8-15 p.90）；16h/18h/1Ah Video Gain (Drive) 與 6Ch/6Eh/70h Video Black Level（總覽 p.27、Table 8-4 p.34–39）；10h Luminance／Brightness（p.23、p.35）；14h 連動（p.38）；B0h Settings（p.32）。
2. VESA Display Data Channel Command Interface (DDC/CI) Standard Version 1.1, October 29, 2004。官方清單：VESA Standards 頁（https://vesa.org/vesa-standards/ ，官方）；公開鏡像：https://milek7.pl/ddcbacklight/ddcci.pdf （非官方）。頁碼為該鏡像 PDF 頁序：display 位址 0x6E/6Fh（p.13）、40ms 最小等待（p.22、p.29）、至少重試 3 次（p.25）、checksum 含虛擬 host 位址 0x50（p.27）、null message 長度 80h（p.28）、expander 120ms（p.35）。
3. ddcutil 官方文件（官方）：Command Overview（https://www.ddcutil.com/commands/）；Performance and Tuning Options（https://www.ddcutil.com/performance_options/ ，40–200ms 摘要、--sleep-multiplier、--maxtries 預設 4/10/8 上限 15）；setvcp（https://www.ddcutil.com/command_setvcp/ ，--noverify 與寫後驗證語意）；vcpinfo 輸出（https://www.ddcutil.com/vcpinfo_output/ ，62＝Audio speaker volume）；References（https://www.ddcutil.com/bibliography/ ，標準清單與 I2C 位址表示法）。
4. Konica Minolta CA-410 官方 catalog（官方）：https://www.konicaminolta.com/instruments/download/catalog/display/pdf/ca410_catalog_eng.pdf 。RS-232C＋USB 虛擬 COM、基本通訊指令相容 CA-210/310、CA-SDK2、電動零位校正快門、同步偵測功能、CA-VP410A/CA-VP427A 保證精度自 0.0003 cd/m² 起。完整遠端指令表屬授權文件（待查證：需對手上授權手冊核對）。

[^1]: ddcutil 官方文件（見參考資料 3）。網頁文件，章節待查證。
