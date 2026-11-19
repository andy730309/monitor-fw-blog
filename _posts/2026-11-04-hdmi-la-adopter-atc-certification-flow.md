---
layout: post
title: "送測 HDMI 認證被 ATC 退件？Adopter 資格、CDF 宣告與 FW freeze 的三個流程坑"
date: 2026-11-04
tags: [HDMI, HDMI LA, HDMI Forum, ATC, CTS, CDF, 認證, EDID]
level: intermediate
prerequisites: ["EDID 入門：用 edid-decode 解析顯示器身分證", "4K144 只出 4K60、HDR 選項灰掉、改個 EDID 螢幕直接消失？CTA-861 extension 設計的三層坑"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: practitioner
sources_checked: 2026-11-04
description: "HDMI 認證被 ATC 退件，問題常在流程而不是技術。本文說明 Adopter 資格、送測義務、CDF 宣告一致性與 FW freeze。"
seo_title: "HDMI 認證被退件？Adopter、CDF 與 FW freeze"
difficulty: intermediate
---
> **重點摘要**：HDMI 認證的坑常不在技術，而在誰有資格送測、送什麼、測什麼。廠商要先成為 Adopter，每種產品類型的第一個產品要送 ATC 測試，ATC 會依照 CDF 宣告來測。FW freeze 之後若再改 EDID，就要重跑 self-test，否則 ATC 抽測會抓到。

寫韌體的人常覺得認證是 PM 的事，反正規格書丟過來照做就好。直到送測退件、fail 報告寄到客戶那邊，你才發現 HDMI 認證的坑不在技術，而在「誰有資格送、送什麼、測什麼」。這篇把 HDMI LA 的 Adopter 制度、ATC 送測義務、CDF 宣告一致性一次講清楚，全部依 HDMI LA 與 HDMI Forum 官網公開頁面，需要會員權限的部分會標「待查證」。

## 前置知識

先把三個名詞分開，很多人混著用：

- **HDMI LA（HDMI Licensing Administrator）**：收授權費、管商標、管合約的單位。官網寫得很清楚：HDMI LA 是 HDMI Forum 指定、負責授權 HDMI 2.2 規格的代理，同時也是 HDMI Founders 指定、負責授權較舊版本的代理。你可以把它想成「規格的戶政事務所」：你要做 HDMI 產品，得先在這裡登記。
- **HDMI Forum**：制定規格的開放貿易協會，會員超過 90 家公司，負責開發未來版本。想參與「寫規格」才需要加入 Forum，年費 USD $12,500（Forum 官網 Join Us 頁明載）。大多數 monitor 廠只需要 Adopter 資格，不需要 Forum 會員。用工程類比：Forum 是標準委員會，Adopter 是拿 spec 去做產品的授權戶，兩者是兩張不同的票。
- **ATC（Authorized Test Center）**：被授權執行 HDMI Compliance Testing 的測試機構。官網分兩種：HDMI ATC（HDMI Founders 建立，測較舊版本）與 HDMI Forum ATC（HDMI Forum 授權，測 HDMI 2.x）。台灣在地就有好幾家 HDMI Forum ATC，例如 Allion Labs Taipei、Granite River Labs Taiwan、Insight Test Labs、Simplay Labs Taiwan（IST）、UL Taiwan。

還有一個關鍵文件：**CTS（Compliance Test Specification）**，就是認證測試的「考卷」。官網 Testing Policies 頁明載 CTS 代表 Licensed Product 的最低合規測試要求。CTS 全文需要 Adopter 權限才能取得；官網公開下載的只有 Compliance Testing Policies and Procedures 1.4c（PDF）與 Capabilities Declaration Form（CDF）1.4b（xls）。

## 技術核心

### Adopter 怎麼來的：四步流程

HDMI LA 官網的流程是 Register → Review → Sign → Welcome：

1. **Register**：官網填表，HDMI LA 確認聯絡資訊後給你 Adopter Agreement 連結。
2. **Review**：把 Agreement 交給管理層或法務審。官網特別註明 Agreement 必須以英文完成。
3. **Sign**：透過 DocuSign 電子簽署，HDMI LA 承諾 24 小時內回覆簽署完成的版本。
4. **Welcome**：收到 Adopter 與 initial Licensing fees 之後啟用會員，取得 Adopter Extranet 存取權——規格全文、royalty 與 compliance 指引、白皮書都在裡面。

Adopter 的權益包括：使用現行與未來版本規格、依商標指引使用 HDMI 商標、公司列在 HDMI LA 官網、參與 Premium HDMI Certification Program 等官方計畫、海關保護（Worldwide compliance protection via Customs Authorities）、每年核發 Adopter Certificate。

對 ODM 最重要的一句話：**Adopter 是公司實體的合約資格，不是產品線的屬性**。你代工的客戶是 Adopter，不代表你的公司實體可以拿客戶的名義去送測——送測文件上的 licensee 名稱與受測公司對不上，ATC 就會退件。ODM 該怎麼掛（affiliate 或 embedded licensee），官網公開頁面沒有寫細節，待查證，需問 HDMI LA 的 Adopter Services 或客戶法務。

### 送測義務：self-test 加上「每種 type 第一個產品送 ATC」

官網 Testing Policies 頁的規則，逐條翻成工程師的話：

1. **量產前 self-test**：在量產或出貨任何宣稱符合 HDMI 規格的產品之前，每個 Adopter 必須依「當時版本的 CTS」對代表性樣品完成 self-test。這是合約義務，不是建議。
2. **每種 type 第一個產品送 ATC**：Licensed Product 分四種 type——source、sink、repeater、cable。每種 type 的第一個產品必須送 ATC 測試；同 type 一旦通過，後續同 type 產品不再強制送測。官網舉的例子：你的電視通過 ATC 之後，不需要再送另一台電視或其他顯示器。但官方仍鼓勵繼續用 ATC。
3. **責任自負**：官網原文明載，通過 CTS 或 ATC 測試不保證產品正確運作、不保證與其他產品互操作，每個 Adopter 對產品功能、合規與互操作自負全責。

第 3 點對系統廠的意義最實際：ATC pass 不等於量產不會出客訴。各家 game console、GPU、dock 的互操作矩陣，還是要自己建、自己跑。個人經驗推論：換 scaler 平台時，雖然同 type 已通過過 ATC、合約上不強制重送，但 PHY 與 link training 實作整個換掉，重送一次比較保險。

### CDF：ATC 是照你的宣告測的

CDF（Capabilities Declaration Form）是你告訴 ATC「我的產品宣告了哪些功能」的表單。ATC 依 CDF 的宣告項目執行測試。所以 fail 最常見的形態不是「功能做不出來」，而是「宣告有、實測無」：

- CDF 由 PM 依行銷需求填，寫了 FRL 高速模式與 VRR，但 FW 的 EDID 最後一版被砍掉對應 feature bit；
- EDID 改版加了 timing，checksum 與 extension flag 改了，CDF 沒跟著改；
- FW freeze 之後又偷改 EDID，self-test 沒重跑，ATC 抽測抓到。

根因都一樣：**CDF、EDID binary、FW 實際行為三方不同步**。解法是把一致性檢查做成 CI 關卡，送測前自動跑：

```python
#!/usr/bin/env python3
"""pre_atc_gate.py — 送 ATC 前的 EDID/CDF 一致性關卡（CI 用）。
已查證部分：EDID block 結構與 checksum 位置（VESA E-EDID 公開定義）、
edid-decode 為公開工具（X.Org / Linux 發行版皆有打包）。
CDF 欄位格式為 HDMI LA 提供的表單（官網 Testing Policies 頁有 1.4b 版 xls 下載），
2.1/2.2 版表單需 Adopter Extranet，此處以 YAML 描述檔代替，欄位名為示意。
"""
import subprocess, sys, yaml

def edid_blocks_ok(raw: bytes) -> list[str]:
    """檢查每個 128-byte block 的 checksum（block 最後一位元組使整 block 總和 ≡ 0 mod 256）。
    此規則出自 VESA E-EDID 公開定義。"""
    errs = []
    for i in range(0, len(raw), 128):
        blk = raw[i:i+128]
        if len(blk) < 128:
            errs.append(f"block {i//128}: 長度不足 128 bytes")
            continue
        if sum(blk) % 256 != 0:
            errs.append(f"block {i//128}: checksum 錯（sum={sum(blk) % 256}）")
    return errs

def ext_flag_ok(raw: bytes) -> list[str]:
    """byte 126 = extension flag（E-EDID 公開定義），必須等於實際 extension 數。"""
    n_ext = (len(raw) - 128) // 128
    if raw[126] != n_ext:
        return [f"ext flag={raw[126]} 但實際 extension 數={n_ext}"]
    return []

def features_via_edid_decode(raw: bytes, declared: dict) -> list[str]:
    """用 edid-decode 的文字輸出比對 CDF 宣告的 feature 關鍵字。
    declared 範例（示意 YAML 欄位，非官方表單格式）：
      keywords:
        FRL_6LANE: "HDMI Forum VSDB"
        VRR: "VRR"
        ALLM: "ALLM"
    """
    out = subprocess.run(["edid-decode"], input=raw.hex(),
                         capture_output=True, text=True, check=True).stdout
    errs = []
    for feat, kw in declared.get("keywords", {}).items():
        if kw.lower() not in out.lower():
            errs.append(f"CDF 宣告 {feat} 但 EDID 找不到關鍵字 '{kw}'")
    return errs

def main():
    raw = open(sys.argv[1], "rb").read()          # EDID binary dump
    cdf = yaml.safe_load(open(sys.argv[2]))       # CDF 描述檔（示意格式）
    errs = edid_blocks_ok(raw) + ext_flag_ok(raw) + \
           features_via_edid_decode(raw, cdf)
    if errs:
        print("PRE-ATC GATE FAIL:")
        for e in errs:
            print("  -", e)
        sys.exit(1)
    print("PRE-ATC GATE PASS")

if __name__ == "__main__":
    main()
```

這支腳本刻意不硬解 HF-VSDB 內部欄位——那些 offset 需要 Adopter 權限的規格文件，屬 NDA 範圍。它只檢查公開可查證的部分：每個 128-byte block 的 checksum（VESA E-EDID 公開定義）、byte 126 的 extension flag、以及用公開工具 edid-decode 的輸出比對 CDF 宣告的關鍵字。HF-VSDB 欄位層級的交叉驗證請對照你手上的 HDMI 規格文件（需 Adopter 權限）。

### FW freeze 與認證模式

送測最怕 FW 在測試中途自己切 EDID 或動 HPD。做法是在 scaler FW 加一個認證模式旗標，由 Factory Mode 選單或 DDC/CI 廠商自訂 VCP code 開啟（VCP code 的廠商自訂區間屬 MCCS 公開定義的 reserved 範圍，實際 code 選擇為示意）：

```c
/* cert_mode.c — 認證模式：送 ATC 期間鎖定 EDID 與 HPD 行為
 * 注意：Scaler_Write_Register_Byte 與 REGADDR_* 為示意地址，非實際晶片規格；
 * 實際暫存器請對照手上 scaler SDK（多屬 NDA，此處不引用）。 */
static unsigned char g_ucCertMode = 0;   /* 0=正常, 1=認證模式（NVRAM 常駐） */

void UserApp_SetCertMode(unsigned char ucOn)
{
    g_ucCertMode = ucOn;
    /* 示意地址，非實際晶片規格：把旗標寫進 NVRAM 保留區 */
    Scaler_Write_Register_Byte(REGADDR_NVRAM_CTRL /* 示意 */, ucOn);
}

/* 動態 EDID 切換與 HPD toggle 的共同出口：認證模式下直接擋下 */
unsigned char UserApp_CanSwitchEdid(void)
{
    return (g_ucCertMode == 0);
}
```

規則很簡單：所有 EDID 重構、HPD toggle、動態 timing 增減，都必須經過 `UserApp_CanSwitchEdid()` 這個單一出口。認證模式下 DUT 行為完全可預期，也從機制上杜絕「FW freeze 後偷改」——要改就得走正式流程，重新評估影響範圍、重跑 self-test，必要時重送 ATC。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 ODM 為品牌客戶開發一台 4K120 monitor，客戶要求掛 HDMI logo、宣稱支援 HDMI 2.1 功能。專案 DVT 尾聲，連續踩到三個坑：

1. **送測資格對不上**：ODM 自己不是 Adopter，PM 直覺認為「客戶是 Adopter，我們代工就行」。ATC 收件時發現送測文件上的 licensee 名稱與受測公司實體不一致，直接退件，排程空轉一週。事後回頭查 HDMI LA 官網才發現，Adopter Agreement 是公司實體層級的合約，連官網都有 Terminated Adopters 名單與 Enforcement Search Tool 讓海關與通路查授權狀態——資格這關根本不該等到送測才確認。
2. **CDF 與 FW 不同步**：CDF 由 PM 依行銷需求手填，宣告了 FRL 高速模式與 VRR；但 FW 的 EDID 在最後一版被砍掉一個 feature bit。ATC 依 CDF 宣告項目測試，fail 在「宣告有、實測無」。fail 報告寄到客戶端，客戶問的第一句話是「你們內部 self-test 是怎麼過的」——答不出來，因為 self-test 用的 EDID 跟送測樣品不是同一版。
3. **FW freeze 後偷改 EDID**：出貨前 PM 要求加一個客戶指定的 timing。EDID 改了 checksum 與 extension flag，但沒重跑 self-test 也沒通知 ATC，抽測 fail，時程掉兩週，還多付一次重測費用（各 ATC 報價不同，待查證）。

協定層分析：三個坑對應三層根因。組織層是 Adopter 資格的公司實體屬性（HDMI LA 官網 Adopter 頁）；流程層是 self-test 與「每 type 第一個產品送 ATC」的合約義務（官網 Testing Policies 頁）；資料層是 CDF/EDID/FW 三方一致性。三層都有明確的官方規則可查，坑不在規格太難，在沒人把規則讀完。

## 新人避坑指南

看懂這幾件事，就不會在認證流程上摔跤：

1. **分清三張票**：Adopter（做產品的授權）、Forum 會員（參與制定規格，年費 USD $12,500）、ATC（測試機構）。monitor 廠通常只需要第一張。
2. **送測前查資格**：licensee 公司實體名稱、Terminated Adopters 名單、Enforcement Search Tool，都在 HDMI LA 官網公開可查。
3. **CTS 是考卷，CDF 是你的答案卷**：ATC 照 CDF 測。CDF 必須由 FW 與 PM 共同簽核，逐項對照 EDID binary 與 FW 實作；把一致性檢查做成 CI 關卡（上面那支 pre-ATC gate）。
4. **self-test 留紀錄**：依當時版本 CTS 對代表性樣品 self-test 是合約義務，紀錄要能對到送測樣品的 FW hash。
5. **FW freeze 加認證模式**：送測樣品的 FW 版本凍結、認證模式開啟、動態行為收斂到單一出口；任何 EDID/FW 變更都重新評估影響範圍。
6. **ATC 選擇看 discipline group**：同一地點可能同時掛 HDMI ATC（舊版）與 HDMI Forum ATC（2.x），官網 ATC 名單有標示各 ATC 支援的 test discipline groups，送測前確認。
7. **ATC pass 不是終點**：官網明載通過測試不保證互操作。nightly regression 與 console/GPU/dock 互操作矩陣仍要自己跑，客訴不會因為你有 logo 就不上門。
8. **時程安排**：DVT 做 pre-compliance（自有儀器或實驗室），PVT 前完成正式送測；ATC 的樣品數、費用與排程 lead time 各家不同（待查證），早問早排。

## 思考題

「每種 Licensed Product type 的第一個產品必須送 ATC，同 type 通過後續不再強制」[^1]。那麼問題來了：你的公司已經有一台通過 ATC 的 monitor（sink type），現在開發新機種，換了新的 scaler 平台、EDID 架構整個改掉、還新增了 HDMI 2.1 功能宣告。合約上你可以不重送 ATC，但從互操作風險與客訴成本的角度，你會送還是不送？你的判斷依據是哪幾條？（提示：想想 PHY、link training 實作與 EDID 宣告哪個變了；再想想官網那句「Adopter 對互操作自負全責」。）

## 參考資料

以下均為 HDMI LA／HDMI Forum 官方公開頁面（本地規格庫無 HDMI 相關標準全文；HDMI 規格與 CTS 全文需 Adopter 權限，屬 NDA 範圍，請對照手上的授權文件）：

1. HDMI LA 官網：HDMI Specifications and Programs（HDMI LA 授權代理身分、HDMI 1.3a 免費下載）— https://www.hdmi.org/spec/index （官方）
2. HDMI LA 官網：How to Become an HDMI Adopter & Overview（四步流程、權益清單、HDMI Forum 簡介與 90+ 會員數）— https://www.hdmi.org/adopter/index （官方）
3. HDMI LA 官網：Authorized Test Centers (ATC)（ATC 定義、HDMI ATC 與 HDMI Forum ATC 之分、全球 ATC 名單與 test discipline groups）— https://www.hdmi.org/adopter/atcs （官方）
4. HDMI LA 官網：Testing Policies（self-test 義務、每 type 第一個產品送 ATC、CTS 為最低要求、互操作責任自負、1.4c 政策文件與 1.4b CDF 表單下載）— https://www.hdmi.org/resource/testing （官方）
5. HDMI Forum 官網：Join Us（年費 USD $12,500、Technical Working Group 參與資格、申請步驟）— https://hdmiforum.org/join-us/ （官方）

待查證項目：Adopter 年費與 per-unit royalty 費率（官網文件需填表單取得）、ODM 以客戶名義送測的 affiliate／embedded licensee 程序、HDMI 2.1/2.2 CTS 測試項細節與 CDF 表單格式（需 Adopter Extranet）、各 ATC 費用與 lead time。官網 Adopter 數字同頁兩處不一致（almost 1700 與 over 1900），引用時不要寫死。

[^1]: HDMI LA 官網：Testing Policies，見參考資料 4。網頁文件，章節待查證。
