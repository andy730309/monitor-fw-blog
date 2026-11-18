---
layout: post
title: "USB-IF Type-C 與 PD 認證闖關指南：VDM 握手、EPR 狀態機與 Integrators List 實戰"
date: 2026-11-03
tags: [USB-C, USB-PD, Compliance, VDM, Integrators-List]
level: intermediate
prerequisites: ["影像介面總覽：VGA / DVI / HDMI / DisplayPort / USB-C 的差異與演進", "DP Alt Mode VDM 流程、pin assignment 與 HPD/Attention 三個坑"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: practitioner
sources_checked: 2026-11-03
difficulty: intermediate
---
## 前置知識
在系統廠開發支援 USB Type-C 與 USB Power Delivery（PD）的顯示器時，硬體能夠點亮畫面、供應 65W 或 240W 電力只是基本功。要將產品正式推出市場並在包裝上使用 USB-IF 認證標誌（Certified USB Logo），產品必須通過 USB-IF 授權獨立測試實驗室（Authorized Independent Test Lab, ITL）的嚴格合規性測試（Compliance Testing），並成功取得 Test ID (TID) 列入 USB-IF Integrators List。

USB-C 與 PD 認證涵蓋實體層（PHY，如眼圖、訊號振幅）、協定層（Protocol，如 Baseband 封包結構、GoodCRC 回應時序）以及策略層（Policy Engine，如 PDO 宣告、VDM Discover Identity 握手）。對於韌體工程師而言，認證測試不僅是驗證功能的正確性，更是對時序控制與狀態機強健性（Robustness）的大考。

## 技術核心

### 1. VDM Discover Identity 握手與回應時序
當測試主機或測試儀器（如 Ellisys Protocol Analyzer）連接顯示器並發起 Vendor Defined Message (VDM) 的 `Discover Identity` 請求時，回應端（顯示器）必須在 tVDMReceiverResponse 內送出 ACK，上限 15 ms；發起端則在 tVDMSenderResponse（24–50 ms）後判定逾時（USB PD R3.2 V1.2，PDF p.238）。ACK 內要回填正確的 Product Type：ID Header VDO 裡分成 Product Type (UFP) 與 Product Type (DFP) 兩個欄位，UFP 可選 PDUSB Hub 或 PDUSB Peripheral 等（PDF p.155–156）。這是兩種不同的錯：韌體在 OSD 或主迴圈阻塞，超過 15 ms 才回，會被判逾時；Product Type 填錯（例如帶 USB hub 的顯示器卻宣告成 Peripheral），回應雖然準時，仍會在欄位檢查被判失敗。

### 2. USB PD 3.1 Extended Power Range (EPR) 與 Keep-Alive 狀態機
EPR 把功率上限從 SPR 的 100W 拉到 240W，EPR 的 Fixed PDO 只有 28V、36V、48V 三檔（USB PD R3.2 V1.2，PDF p.30；EPR Source Port 的 PDP 需大於 100W、不超過 240W，PDF p.42）。以 28V/5A 為例是 140W，要 48V/5A 才到 240W。在 EPR 模式下，韌體的 PD Controller 中斷處理與主迴圈（Super-loop）必須保持即時性。這裡要分清楚兩個層級的時限（以下數值都在 PDF p.237）：

- **GoodCRC（協定層）**：收到訊息後要在 tTransmit（195 μs）內回 GoodCRC，發送端等 tReceive（0.9–1.1 ms）沒收到就重送。這由 PD 控制器硬體或其內建韌體處理，不經過應用主迴圈。
- **上層回應（策略層）**：例如回 Request 的 Accept，要在 tReceiverResponse（15 ms）內送出。
- **EPR Keep-Alive（策略層）**：Sink 每 tSinkEPRKeepAlive（250–500 ms）送一次 EPR_KeepAlive；Source 端的 tSourceEPRKeepAlive 是 750–1000 ms，逾時沒收到就要離開 EPR（處理方式請對照規格 EPR 章節，本文未逐條核對，待查證）。

若背景任務過重，讓 Accept、VDM ACK 或 Keep-Alive 回應超過時限，PD stack 會進入錯誤處理（Soft Reset 或 Hard Reset，依情境而定），測試儀器就會判定失敗。

### 3. 韌體修正架構
修正方向不是把所有東西塞進中斷，而是把 PD 服務路徑清乾淨：GoodCRC 交給 PD 控制器硬體層即時回應；字型解壓縮這類長耗時工作移到低優先權背景 worker；PD stack 獨立成 task，以有界逾時（bounded timeout）收送訊息；VDM 回應則以 32-bit VDO 為單位正確組包：

```c
/* 示意程式碼：暫存器地址、巨集與函式名稱皆為示意，非實際晶片規格，未實機驗證。
   Discover Identity ACK 的 VDO 欄位依 USB PD R3.2 V1.2 §6.4.12（PDF p.154–158）；
   巨集與 helper 需依晶片 SDK 定義。*/
#define USB_PD_REG_BASE             0x40028000  /* 示意地址，非實際晶片規格 */
#define REG_PD_VDM_CTRL             (*(volatile unsigned int *)(USB_PD_REG_BASE + 0x04)) /* 示意地址，非實際晶片規格 */

#define VDM_RESPONSE_BUDGET_MS      10    /* 示意值；需小於 tVDMReceiverResponse 15 ms（PDF p.238） */
#define SRC_EPR_KEEP_ALIVE_MS       1000  /* tSourceEPRKeepAlive 上限 1000 ms（PDF p.237） */

/* 示意巨集，實際需依晶片 SDK 定義 */
#define GET_SYSTEM_VENDOR_ID()      board_usb_vid()  /* 應回傳 USB-IF 註冊的 VID */

/* rx_vdm_hdr：已去掉 Message Header、指向 VDM Header 的 32-bit 值。
   回傳 ACK 的 VDO 個數，-1 表示不是 Discover Identity REQ。 */
int USB_PD_Handle_Discover_Identity(unsigned int rx_vdm_hdr, unsigned int *tx_vdo)
{
    /* VDM Header：bit 4..0 = Command，bit 7..6 = Command Type（PDF p.152） */
    if ((rx_vdm_hdr & 0x1Fu) != VDM_CMD_DISCOVER_IDENTITY) {
        return -1;
    }
    if (((rx_vdm_hdr >> 6) & 0x3u) != VDM_CMD_TYPE_REQ) {
        return -1;
    }

    /* Discover Identity ACK 依序：VDM Header、ID Header VDO、Cert Stat VDO、
       Product VDO，再接 Product Type VDO（PDF p.154）。 */
    tx_vdo[0] = VDM_Build_Header_Ack();      /* Structured VDM Header，Command Type = ACK */
    tx_vdo[1] = VDM_Build_ID_Header_VDO(GET_SYSTEM_VENDOR_ID(),
                                        PRODUCT_TYPE_UFP_PDUSB_HUB); /* 規格沒有「Monitor」類型；帶 hub 的顯示器常見選 PDUSB Hub，依產品實際設計決定 */
    tx_vdo[2] = VDM_Build_Cert_Stat_VDO();   /* 內含 USB-IF 指派的 XID */
    tx_vdo[3] = VDM_Build_Product_VDO();     /* USB Product ID 與 bcdDevice */
    tx_vdo[4] = VDM_Build_UFP_VDO();         /* Product Type (UFP) 為 PDUSB Hub／Peripheral 時必送（PDF p.158） */

    REG_PD_VDM_CTRL = 0x01; /* 示意：Trigger VDM ACK TX */
    return 5;
}
```

## 真實血淚案例
情境模擬（依公開規格推演），非真實客戶或產品事件。在某次 PVT 階段的 USB-IF 預測試中，顯示器進行 EPR 相關的 PD 測試項目（正式測試項目編號與名稱待查證：USB-IF Power Delivery Compliance Test Specification），測試儀器以 Sink 角色要求 EPR 供電，裝置需在 tReceiverResponse（15 ms，USB PD R3.2 V1.2 PDF p.237）內回 Accept。此時韌體正在執行 OSD 動畫字型解壓縮，把 PD 服務路徑整個卡住，Accept 延遲了 40 ms 才送出（模擬數值）。GoodCRC 本身由 PD 控制器即時回應、不受主迴圈影響，但上層回應逾期，測試儀器照樣判定逾時，在 Log 中留下回應逾時的錯誤訊息（Log 字串為示意）。

工程師起初以為是硬體 PHY 訊號雜訊過大，耗費兩天用示波器量測 CC 腳位眼圖，結果發現眼圖完美無瑕。改用 Protocol Analyzer 抓封包，才看到 Request 到 Accept 之間隔了 40 ms，原因是主迴圈裡一個耗時過長的字型迴圈。修正後：字型解壓縮移出 PD 服務路徑、交給低優先權背景 worker；拿掉長時間關中斷與高優先權 busy-wait；PD stack 獨立成 task，以 bounded timeout 收送訊息。重測時 Accept 回應時間回到 15 ms 以內。

## 新人避坑指南
1. **切勿輕信晶片 SDK 的預設值**：部分 PD 晶片 SDK 會提供預設的 VID/PID 與 Product Type 設定（業界現象，出處待查證），送測前務必核對硬體實際規格與 USB-IF 官方註冊資訊；Product Type 屬系統端設定值，SDK 預設未必符合產品定位。
2. **嚴格管控主迴圈延遲**：在進行 PD 或 DP Alt Mode 狀態機切換時，禁止在 ISR 中夾帶任何長時間的輪詢（Polling）或外部 Flash 讀取。
3. **善用前測工具**：正式送交 ITL 測試合格前，務必在內部架設 GRL 或 Ellisys 測試台進行 Pre-compliance 測試，先過濾掉大部分協定與時序類的軟體錯誤。

## 思考題
為什麼 USB PD 的 EPR 模式需要 Keep-Alive 機制？如果 Port partner 突然拔除或發生線材過溫，韌體應該採取什麼保護動作？

<details>
<summary>提示（點擊展開）</summary>

EPR 會輸出 28V 以上的電壓，Source 必須持續確認對方還在 EPR 模式、而且還能正常通訊；Keep-Alive 中斷就代表對方可能已經拔除或當機，繼續輸出高壓有風險。拔除時 Type-C 層會偵測到 CC 斷開，Source 要依規格關閉 VBUS；過溫則應先降回 SPR 或停止供電，再記錄事件。確切的時限與狀態轉移請對照 USB PD 規格 EPR 章節與 Type-C 規格（本文未逐條核對，待查證）。

</details>

## 參考資料
- USB-IF Compliance Program（認證流程與 Integrators List／TID 制度）：https://www.usb.org/compliance
- USB-IF Compliance Tools（測試工具與測試規格文件入口）：https://www.usb.org/compliance/tools
- USB Power Delivery Specification Revision 3.2 Version 1.2（2026-08-19），usb.org 公開免費下載：https://www.usb.org/document-library/usb-power-delivery — EPR 240W 與 28V／36V／48V（PDF p.30、p.42）；tTransmit、tReceive、tReceiverResponse、tSourceEPRKeepAlive、tSinkEPRKeepAlive（PDF p.237）；tVDMReceiverResponse、tVDMSenderResponse（PDF p.238）；Discover Identity ACK 與 Product Type（PDF p.154–158）。
- USB Type-C Cable and Connector Specification Release 2.5（2026-03），usb.org 公開下載。
- 測試項目編號與名稱待查證：USB-IF Power Delivery Compliance Test Specification（請由 Compliance Tools 頁面確認適用版本與章節）。
