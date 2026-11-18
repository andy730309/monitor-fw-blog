---
layout: post
title: "顯示器 FW NPI gate criteria：EVT/DVT/PVT/MP 四階段驗收範本與 EDID/DDC/CI 自動驗收"
date: 2026-11-04
tags: [NPI, EVT, DVT, PVT, MP, DDC/CI, EDID, certification, gate criteria]
level: intermediate
prerequisites: ["DDC/CI 與 MCCS 入門：用 ddcutil 控制顯示器", "EDID 入門：用 edid-decode 解析顯示器身分證", "工廠色彩校正流程與 takt time 最佳化"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: practitioner
sources_checked: 2026-11-04
difficulty: intermediate
---
## 前置知識

把顯示器 FW 的開發想像成蓋房子：EVT 是蓋樁腳，確認地基穩不穩；DVT 是蓋房子主體，確認每間房功能都正常；PVT 是試住，確認大量生產的房子品質一致；MP 是交屋，確認每一棟交給客戶時都沒問題。每一階段交屋前都要有「驗收標準」（gate criteria），否則房子蓋完才發現牆面有裂縫，客戶退房（客退）就來不及了。

本篇核心規格是顯示器 FW 在系統廠/ODM 的 NPI（New Product Introduction）四階段 gate criteria。相關英文術語第一次出現時括號說明：

- NPI（New Product Introduction，新產品導入）：從 EVT 到 MP 的產品導入流程
- EVT（Engineering Validation Test，工程驗證測試）：工程樣品驗證階段
- DVT（Design Validation Test，設計驗證測試）：設計驗證階段
- PVT（Production Validation Test，量產驗證測試）：量產驗證階段
- MP（Mass Production，量產）：量產階段
- DDC/CI（Display Data Channel Command Interface，顯示資料通道命令介面）：透過 I2C 從電腦控制顯示器的協定，設備位址 0x37（MCCS 公開定義，已查證）
- EDID（Extended Display Identification Data，延伸顯示器識別資料）：顯示器身分證，存在 EEPROM 位址 0x50，經 I2C 讀取
- VCP（Virtual Control Panel，虛擬控制面板）：DDC/CI 下的控制代碼，例如 0x10 亮度、0x14 輸入源
- MCCS（Monitor Control Command Set，顯示器控制命令集）：VESA 定義的 DDC/CI 命令集

前置文章建議先讀：DDC/CI 與 MCCS 入門、EDID 入門、工廠色彩校正流程。這些文章已說明 ddcutil 如何讀寫亮度/輸入源，以及 EDID Base Block 結構。

## 技術核心

### NPI 四階段 FW gate criteria 概念

顯示器 FW 團隊在系統廠/ODM 機種開發中，必須在 EVT→DVT→PVT→MP 每個階段設定「進入條件」與「退出條件」。沒有書面 gate criteria，驗收標準靠口頭約定，缺乏 traceability，缺失會直接帶入量產機造成客退。

以下為 FW 相關驗收 checklist 的核心項目（示意範本，具體門檻數值請對照手上的 NDA 規格與內部 SOP）：

**EVT（工程驗證測試）**
- FW 能正常 boot 進主功能迴路，OSD 可顯示
- 所有輸入介面（HDMI/DP/Type-C/VGA）可基本訊號接通
- EDID Base Block 可透過 ddcutil 讀取，無 checksum 錯誤（EDID 位址 0x50，已查證）
- DDC/CI VCP 0x10（亮度）、0x14（輸入源）可讀寫（DDC/CI 位址 0x37，MCCS 公開定義，已查證）
- FW 版本字串與 build ID 可透過 UART/DDC/CI 讀取
- Flash 寫入與 CRC 驗證通過（dual-bank 切換基本可行）

**DVT（設計驗證測試）**
- HDMI CTS、VESA DP CTS、USB-IF PD/Type-C compliance 測試項目列表已確認，關鍵項目已送測或預測試通過
- EDID 1.4 + CTA-861 extension 與 DisplayID 2.x 共存策略驗證（E-DDC A0h/A4h 並存）
- DDC/CI regression 自動化腳本可跑通，setvcp 0x60 等關鍵 VCP 有 settle 等待（DDC/CI 40–200ms 協定等待語意，業界慣例，待查證）
- 色彩校正站（CA-410/色度計）白平衡閉式解可收斂，DDC/CI 寫入時序符合協定等待
- OTA/USB flash 斷電恢復測試通過（A/B bank 切換、anti-rollback）
- FW 版本與 build ID 與測試結果綁定（params_hash）

**PVT（量產驗證測試）**
- 所有 DVT 缺失已修正並回歸測試通過
- 認證報告（HDMI Adopter/ATC、VESA DisplayPort、USB-IF Integrators List）已齊全或有受理單
- 產線校正站 takt time 符合 UPH 目標，多 DUT 並行排程無儀器衝突
- 校正資料 traceability：序號綁定、MES 上傳、rework 追蹤可運作
- FW freeze：PVT 後不再接受非關鍵 Bug 修正

**MP（量產）**
- FW 版本鎖定，出貨 build 與 PVT 簽核 build 一致
- 產線 ISP 燒錄站 FW 版本自動比對，防止誤燒舊版
- RMA/8D 流程可接收場端回饋並回寫 FW spec
- SPC 監控（Cpk、drift 告警）已上線，校正結果分層（站別×probe×面板批次）

### EDID/DDC/CI 自動驗收腳本（Python）

以下腳本封裝 ddcutil 做 EDID checksum 與 DDC/CI capabilities 驗收。DDC/CI 設備位址 0x37 與 EDID 位址 0x50 已查證（MCCS 公開定義、ddcutil 文件）；Scaler 內部 handler 暫存器地址為示意，非實際晶片規格。

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NPI gate criteria: EDID/DDC/CI 驗收腳本（示意）
DDC/CI 0x37 與 EDID 0x50 為 MCCS 公開定義（已查證）。
Scaler 內部 handler 地址為示意，非實際晶片規格。
"""
import subprocess
import sys
from typing import Tuple, List

DDC_CI_ADDR = 0x37   # 已查證：MCCS DDC/CI 設備位址
EDID_ADDR = 0x50     # 已查證：EDID EEPROM 位址

# 示意地址，非實際晶片規格
SCALER_FW_VERSION_REG = 0x8000  # /* 示意地址，非實際晶片規格 */


def run_ddcutil(args: List[str]) -> Tuple[int, str, str]:
    cmd = ["ddcutil"] + args
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "ddcutil timeout"


def check_dcci_capabilities(bus: str) -> bool:
    rc, out, err = run_ddcutil(["--bus", bus, "capabilities"])
    if rc != 0:
        print(f"[FAIL] ddcutil capabilities 失敗: {err}")
        return False
    if "DDC/CI" not in out:
        print("[FAIL] 未偵測到 DDC/CI 能力字串")
        return False
    print("[PASS] DDC/CI capabilities 偵測正常")
    return True


def main() -> int:
    bus = sys.argv[1] if len(sys.argv) > 1 else "1"
    result = check_dcci_capabilities(bus)
    return 0 if result else 1


if __name__ == "__main__":
    sys.exit(main())
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某系統廠顯示器機種在 DVT 結案審查時，FW 團隊拿不出「哪些項目必須通過才能進 PVT」的書面 gate criteria。結果導致 DVT 期間發現的 HDMI CTS 相容性缺失與 DP MST daisy-chain 斷鏈 Bug，沒有納入 PVT 入口檢查，直接帶入量產機。客戶在串接第二台螢幕後出現 4K 畫面黑畫面客退。事後檢討發現，FW release 沒有對應的 EVT/DVT/PVT/MP gate 範本，各階段驗收標準靠口頭約定，缺乏 traceability 與可執行的 checklist。

量測現象：串接第二台螢幕後，主螢幕 4K 畫面黑畫面，副螢幕正常；單接主螢幕時 4K 正常。協定層分析指向 DP MST sideband message 分段與通知時序（DVT 已發現但未列為 PVT 入口強制檢查項目）。

## 新人避坑指南

1. **不要把 DDC/CI ack 當成執行完成**：setvcp 只收到 I2C ack 代表匯流排層收到命令，不代表 Scaler FW 已執行並持久化。關鍵 VCP（如 0x60、B0h store）需要 settle 等待與 verify 讀回。
2. **EDID 改完一定要重算 checksum 與 HPD toggle**：EDID 任一 byte 改動都要重算第 128 個 byte checksum，否則 Host 會拒絕 EDID；改完後 HPD toggle 迫使 Host 重讀 EDID。
3. **認證不是 PVT 後才補**：HDMI CTS、VESA DP CTS、USB-IF compliance 是 PVT 入口的強制條件，不是 MP 後才送的。送測前先做 pre-ATC gate（edid-decode 比對 CDF 宣告）。
4. **FW 版本要鎖定**：PVT 簽核 build 與 MP 出貨 build 必須一致，產線 ISP 燒錄站要自動比對 FW 版本，防止誤燒舊版造成現場不一致。
5. **示意地址不要當真實規格**：筆記與程式碼中的 Scaler 暫存器地址（如 0x8000）均為示意，非實際 RTD/Novatek/MStar 規格，實際開發請對照手上的 NDA datasheet。

## 思考題

EDID 1.4 Base Block 第 128 個 byte 是 checksum，使所有 128 個 byte 總和為 0x00 mod 256。如果你修改了 EDID 中的製造商名稱（byte 10–11），checksum 需要如何重算？這個規則出自哪份規格？（答案：VESA EDID 1.4 規格，本地無規格庫 PDF，標待查證）

<details>
<summary>提示</summary>
把 128 個 byte 加在一起，取低 8 bits，用 0x100 減去該值，再取低 8 bits，就是 checksum byte。若總和本身已是 0x00 mod 256，checksum 為 0x00。
</details>

## 參考資料

1. VESA 官網（https://vesa.org/）：VESA 認證計畫（DisplayPort、DisplayHDR、ClearMR、AdaptiveSync）、合規與認證頁面、Certified Components 清單。官方來源。
2. HDMI LA 官網（https://www.hdmi.org/）：HDMI Adopter 計畫、Testing Policies、Authorized Test Centers (ATC)、HDMI 2.2 規格概況。官方來源。
3. USB-IF 官網（https://www.usb.org/developers/compliance）：USB-IF Compliance Program、五大認證管道、Integrators List、Test Labs。官方來源。

> 說明：NPI gate criteria（EVT/DVT/PVT/MP）為系統廠/ODM 業界常見專案管理實務，並非單一公開規格文件所定義；上述 checklist 依 VESA/HDMI/USB-IF 公開認證資訊與一般 FW 開發流程推論，具體門檻數值請對照手上的 NDA 規格與內部 SOP。DDC/CI 0x37 與 EDID 0x50 已查證（MCCS 公開定義、ddcutil 文件）；Scaler 內部 handler 地址為示意，非實際晶片規格。
