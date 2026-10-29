---
layout: post
title: "顯示器系統方塊圖入門：Scaler、T-CON、Panel、Backlight、PD、Hub 是怎麼分工的？"
date: 2026-10-29
tags: [Monitor, Scaler, T-CON, Panel, Backlight, USB-PD, USB-Hub, Block-Diagram]
level: beginner
prerequisites: ["基本電子電路觀念（電壓、電流、訊號）", "知道什麼是 HDMI/DisplayPort/USB-C"]
series: "系列 A：顯示器是怎麼運作的"
roadmap_stage: foundations
sources_checked: 2026-10-29
difficulty: beginner
mermaid: true
---
## 為什麼重要

你拿到一台新監視器，插上 HDMI 或 USB-C，畫面就亮了。但在機殼裡，其實有 **六大子系統** 在同時運作：

1. **Scaler (主板/擴大器板)** — 系統大腦
2. **T-CON (Timing Controller/時序控制器)** — 翻譯官
3. **Panel (顯示面板)** — 畫布
4. **Backlight (背光模組/驅動)** — 光源 (LCD 專用)
5. **USB Power Delivery (PD/Type-C 電源傳輸)** — 充電站 + 訊號橋樑
6. **USB Hub / KVM** — 周邊擴充與多電腦切換

身為韌體工程師，**帶新機種帶新面板、除錯「畫面不亮」或「USB-C 充不了電」**，第一步都是畫出、看懂這張系統方塊圖。不懂分工，就無法定位問題在「誰的鍋」。

---

## 核心概念

| 術語 | 中文 | 一句話解釋 |
|------|------|------------|
| **Scaler** | 擴大器/主板晶片 | 收 HDMI/DP/Type-C 訊號 → 解碼/縮放/色彩處理/OSD → 送給 T-CON |
| **T-CON** | 時序控制器 | 把 Scaler 送來的高速序列資料，轉成 Panel 逐行逐列需要的驅動時序 |
| **Panel** | 顯示面板 | 真正顯示畫面的玻璃基板 (LCD: IPS/VA/TN；OLED: WOLED/QD-OLED) |
| **Backlight** | 背光模組 | LCD 專用的 LED 光源；OLED 不需要 |
| **Local Dimming** | 區域調光 | 把背光分成幾十~幾千個 zones 獨立控制亮度，提升對比度 |
| **PD Controller** | 電源傳輸控制器 | 專門處理 USB-C PD 協商、Alt Mode、Role Swap 的獨立 IC |
| **Alt Mode** | 替代模式 | USB-C 實體介面上跑 DisplayPort 或 HDMI 訊號的機制 |
| **Billboard** | 機制裝置 | USB 2.0 端點，告訴 Host「我支援 DP Alt Mode」 |

---

## 一步一步：訊號怎麼從 GPU 跑到畫面上？

### 1. 訊號進入：Host → Scaler
- **HDMI/DP/Type-C** 訊號進入 Scaler 內部的 **Receiver**。
- Scaler 做 **Link Training**（DP/HDMI 2.1 FRL）、**HDCP 解密**、**EDID 讀取**。
- 解碼後得到純數位像素流 (RGB/YCbCr)。

### 2. 影像處理管線：Scaler 內部
```
Video Input → Scaling → CSC/Range → Gamma/LUT → HDR Tone Map → Sharpness/NR → Overdrive → OSD Insert → Panel Tx
```
- **Scaling**：把 1080p 縮放到 4K 面板原生解析度 (polyphase filter)。
- **Gamma/LUT**：把線性亮度轉成人眼感知均勻的曲線 (γ=2.2 或 PQ)。
- **Overdrive (OD)**：預判下一幀，施加過衝電壓加速液晶轉向 (降低 GtG)。
- **OSD Insert**：選單/Logo 疊加在畫面上。

### 3. 面板介面傳輸：Scaler → T-CON
- 依 Panel 規格選介面：
  - **eDP** (Embedded DisplayPort)：筆電/高階監視器主流，1~4 lanes，HBR1/2/3。
  - **V-by-One HS**：大尺寸/高刷新率，單通道高達 4 Gbps。
  - **LVDS**：舊款/低階，雙通道 8/10-bit。
- Scaler 端 Tx、T-CON 端 Rx，中間走差分線對。

### 4. T-CON 時序產生與分發
- 收到序列資料 → 解序列化 → 產生 **Vsync/Hsync/DE/CLK** → 驅動 **Source Driver (列)** 與 **Gate Driver (行)**。
- 部分 T-CON 支援 **PSR (Panel Self-Refresh)**：靜態畫面關閉 Main Link，靠內建 Frame Buffer 維持顯示，省電。

### 5. Panel 真正發光/控光
- **LCD**：TFT 矩陣控制液晶扭轉角度 → 決定背光通過多少 → 配合彩色濾光片產生 RGB。
- **OLED**：每個次像素自我發光，電流大小決定亮度，真正的 0 nit 黑位。

### 6. 背光系統 (僅 LCD)
- **Edge-lit**：LED 在邊框，導光板導光 → 單一亮度控制。
- **Direct-lit**：LED 直下排列 → 可分區但非逐像素。
- **Mini-LED / FALD**：幾百~上千 zones 獨立電流控制 → Scaler 算好 zone brightness → 經 SPI/I²C 送給 Backlight Driver → Driver 內部 MCU 執行電流控制、保護、平滑。

### 7. USB-C PD 與 Alt Mode (現代商用機必備)
```
[AC/DC] → [Buck-Boost] → [VBUS] → [Type-C Port] ↔ [PD Controller]
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              [CC Line/PD]      [High-Speed MUX]    [AUX/HPD Detect]
              (PDO 請商)         (DP/USB 切換)        (Alt Mode HPD)
                    │                 │                 │
                    └─────────────────┼─────────────────┘
                                      ▼
                              [I²C/SMBus → Scaler MCU]
```
- Monitor 扮演 **PD Source (DFP)** 供電給 Notebook (最高 240W EPR)。
- 同時扮演 **UFP** 接收 Notebook 的 **DP Alt Mode** 訊號。
- PD Controller 獨立處理 PD 協商，再透過 I²C 告訴 Scaler：「現在契約是 20V/5A、已進入 DP Alt Mode、Pin Assignment C、4-lane DP」。
- Scaler 據此啟用 DP Rx、切換 MUX、通知 Hub 上游連線。

### 8. USB Hub / KVM
- **Integrated Hub**：Scaler SoC 內建。
- **External Hub IC**：掛在 Scaler USB 介面下 (如 Genesys GL35xx, VIA VL820)。
- **KVM**：兩組 Upstream (Type-C + USB-B/HDMI) + 共用下游 Hub；FW 管切換邏輯 (熱鍵/OSD/自動偵測)、PD 角色互換、Video MUX 切換。

---

## 圖解

### 系統級方塊圖 (Mermaid)

```mermaid
flowchart LR
    subgraph Host["Host (GPU/Notebook)"]
        GPU[GPU]
    end

    subgraph Monitor["Monitor 內部"]
        direction TB
        
        subgraph IO["輸入介面"]
            HDMI[HDMI Rx]
            DP[DP Rx + AUX]
            USBC[Type-C Receptacle]
        end
        
        subgraph Scaler["Scaler / Mainboard"]
            VideoSel[Video Input Selection]
            ImgProc[Image Processing Pipeline\nScaling, Gamma, HDR, OD, OSD]
            PanelTx[Panel Tx\n(eDP/V-by-One/LVDS)]
            BLctrl[Backlight Control\nPWM/DC + Local Dimming Data]
            MCU[MCU / RTOS\n8051/ARM/RISC-V]
            Hub[USB Hub / Billboard / KVM]
            PDif[PD Controller I/F\nI²C/SMBus]
        end
        
        subgraph TCON["T-CON Board"]
            Rx[High-Speed Rx]
            TimingGen[Timing Generator\nVsync/Hsync/DE/CLK]
            SrcDrv[Source Drivers]
            GateDrv[Gate Drivers]
            PSR[PSR Frame Buffer\n(選配)]
        end
        
        subgraph Panel["Panel (LCD/OLED)"]
            TFT[TFT Matrix + Color Filter]
            LED[LED Backlight\n(LCD only)]
        end
        
        subgraph BLdrv["Backlight Driver"]
            BuckBoost[Buck/Boost LED Driver]
            Zones[Local Dimming Zones\n(Mini-LED: 數百~上千)]
            Protection[OVP/OCP/OTP\nThermal Protection]
        end
        
        subgraph PDctrl["PD Controller (獨立 IC)"]
            PE[Policy Engine / DPM]
            MUX[High-Speed MUX/Re-driver]
            AUXdet[AUX/HPD Detect]
            BB[Billboard Device]
        end
    end

    GPU -->|HDMI/DP/Type-C| IO
    IO --> VideoSel
    VideoSel --> ImgProc
    ImgProc --> PanelTx
    ImgProc --> BLctrl
    ImgProc --> MCU
    MCU --> Hub
    MCU --> PDif
    MCU --> OSD[OSD Engine]
    
    PanelTx --> Rx
    Rx --> TimingGen
    TimingGen --> SrcDrv
    TimingGen --> GateDrv
    TimingGen -.-> PSR
    SrcDrv --> TFT
    GateDrv --> TFT
    
    BLctrl --> BuckBoost
    BuckBoost --> Zones
    Zones --> LED
    LED -.-> TFT
    
    USBC -.->|VBUS/CC/SBU| PDctrl
    PDctrl --> PE
    PE --> MUX
    PE --> AUXdet
    PE --> BB
    PDctrl -.->|I²C/SMBus| MCU
    
    MUX -.->|DP Lanes| PanelTx
    MUX -.->|USB SS| Hub
```

### 電源路徑簡圖 (ASCII)

```
[AC In] → [AC/DC PSU] → +12V/+5V/+3.3V 主機板電源軌
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              [Scaler Core]   [Backlight Drv]  [PD Controller]
                    │               │               │
                    ▼               ▼               ▼
              [T-CON VDD]    [LED Array]      [Buck-Boost] → [VBUS 5~20V]
                    │               │               │
                    ▼               ▼               ▼
              [Panel VDDIO/   [Local Dimming]  [Type-C Port]
               AVDD/VGH/VGL]    (zones)             │
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
                              [Notebook 充電]
```

---

## 常見陷阱

| 現象 | 可能原因 | 排查方向 |
|------|----------|----------|
| **畫面全黑、背光亮** | Panel VDD/VGH/VGL 電源序列錯誤、T-CON 未收到訊號 | 示波器量 Panel 電源腳位上電順序、確認 Scaler Panel Tx 輸出、檢查 Panel ID 讀取 |
| **畫面花屏/撕裂** | Panel timing 不符 (HTotal/VTotal/Porch)、SSC 設定衝突 | 對照 Panel Spec 與 Scaler 設定、關掉 SSC 試試、確認 Link Rate/Lane Count |
| **USB-C 不充電 / 充電功率不夠** | PD Contract 請商失敗、Cable 不支援 EPR、功率預算超支 | 抓 CC 線封包 (PD Analyzer)、查 PD Controller Log、試算 AC/DC 輸出 - 系統消耗 |
| **USB-C 有電無畫面** | Alt Mode 未進入、Pin Assignment 錯誤、MUX 未切換、HPD 未拉高 | 確認 Billboard descriptor、抓 AUX/VDM 交換、查 MUX 切換 GPIO |
| **Local Dimming 閃爍/暈影** | Zone mapping 錯誤、Backlight Driver 平滑參數不當、Scaler 算法與 Driver 時序不同步 | 關掉 Local Dimming 定位、抓 SPI/I²C 介面波形、調整 smoothing/gamma compensation |
| **OSD 設定重開機消失** | NVRAM CRC 驗證失敗、wear-leveling 寫入區塊錯誤、版本遷移邏輯漏寫 | 讀回 NVRAM 原始資料、檢查 CRC、追蹤遷移代碼 |
| **VRR 下 Overdrive 鬼影** | OD table 只針對固定 Refresh Rate、VRR 變頻時未插值/切表 | 確認 Scaler 支援 Variable OD、建立多組 Refresh Rate OD table、測試 GtG 曲線 |

---

## 動手練習 (零成本 / 免費工具)

1. **抓一台監視器的 EDID 看懂它**
   ```bash
   # Linux/macOS
   sudo apt install edid-decode   # 或 brew install edid-decode
   # 從 sysfs 讀取 (需載入 i2c-dev, i2c-i801)
   sudo modprobe i2c-dev
   edid-decode /sys/class/drm/card0-HDMI-A-1/edid
   ```
   - 試著解讀：`Manufacturer`、`Product Code`、`Serial Number`、`Established Timings`、`Detailed Timing Descriptors`、`Color Characteristics`、`DisplayID Block`。

2. **用 ddcutil 讀寫亮度、輸入源**
   ```bash
   sudo apt install ddcutil
   ddcutil detect                    # 列出支援 DDC/CI 的顯示器
   ddcutil capabilities             # 看支援哪些 VCP codes
   ddcutil getvcp 10                # 讀亮度 (VCP 0x10)
   ddcutil setvcp 10 50             # 設亮度 50%
   ddcutil setvcp 60 0x0f           # 切換輸入源 (VCP 0x60, 值依廠商)
   ```

3. **畫出你手邊產品的系統方塊圖**
   - 拿產品規格書/原理圖/BoM，標出：Scaler 型號、T-CON 型號、Panel 型號、Backlight Driver 型號、PD Controller 型號、Hub IC 型號。
   - 畫出 **訊號流**、**電源流**、**控制流** 三條線，標註介面類型 (eDP 4-lane HBR3? V-by-One 8-lane? I²C address 0x3C?)。

4. **查閱 Panel Spec 練習找關鍵參數**
   - 找一份 Panel Spec (公開的或簽 NDA 後拿到的)，圈出：
     - Resolution / Refresh Rate / Timing Type (VESA DMT / CVT / Custom)
     - Interface: eDP 1.4 / V-by-One HS / LVDS Dual Channel
     - Lane Count / Link Rate / SSC Range
     - Power Sequence: T1~T12 各段延遲 (ms)
     - Color Chromaticity (Rx, Ry, Gx, Gy, Bx, By, Wx, Wy)
     - Gamma / OD 參數表格式

---

## 自我檢測

<details>
<summary>點擊展開答案</summary>

**Q1. Scaler 和 T-CON 最大的分工差別是什麼？**
> Scaler 負責「收訊號、處理圖、管系統」；T-CON 負責「把處理好的圖轉成 Panel 逐行逐列的驅動時序」。Scaler 面向 Host/介面標準；T-CON 面向 Panel 物理特性。

**Q2. 為什麼 LCD 需要 Backlight 而 OLED 不需要？**
> LCD 的液晶本身不發光，只能控制「通光/遮光」，必須要有背光模組提供光源；OLED 每個次像素都是自發光二極體，電流通過即發光，不需額外背光。

**Q3. USB-C 監視器同時要「充電給筆電」又要「收筆電的 DP 訊號」，這在 PD 角色上叫什麼？**
> 監視器扮演 **PD Source (DFP, Downstream Facing Port)** 輸出 VBUS 供電；同時在資料角色上扮演 **UFP (Upstream Facing Port)** 接收 DP Alt Mode。這需要 **Power Role Swap (PR_Swap)** 和 **Data Role Swap (DR_Swap)** 協商。

**Q4. Local Dimming 的 zone brightness data 通常怎麼從 Scaler 傳到 Backlight Driver？**
> 透過 **SPI 或 I²C** (或專用高速介面) 傳送 zone 亮度陣列；Driver 內部 MCU 接收後轉換成各通道 LED 電流，並執行保護/平滑/熱補償。

**Q5. 什麼是 PSR (Panel Self-Refresh)？它省在哪裡？**
> 靜態畫面時，T-CON 內建 Frame Buffer 維持顯示，關閉 Scaler→T-CON 的 Main Link (eDP/DP)，讓 GPU 和 Link 進入低功耗狀態，省下 Link 功耗與 GPU 記憶體頻寬。

</details>

---

## 參考資料

1. **Monitor Insider — "Anatomy of a Monitor"** — http://monitorinsider.com/monitor_anatomy  
   系統方塊圖、Scaler/T-CON/Panel/Backlight 功能分工、介面說明 (公開部落格，技術內容準確)。

2. **Component Labz — "Parts of a Computer Monitor | Every Component Explained"** — https://componentlabz.wordpress.com/2026/08/03/parts-of-a-computer-monitor-every-component-explained  
   組件功能表格、Mainboard/T-Con/Backlight/Power Supply 角色區分。

3. **iTechGuides — "How Do Monitors Work? The Complete Guide"** — https://itechguides.com/how-do-monitors-work-the-complete-guide-to-how-pc-screens-work  
   訊號流向、Scaler/T-CON/Panel/Backlight 運作原理、LCD/OLED 差異、背光架構。

4. **Diodes Inc. — "AP43781 USB-C-Link Monitor PD Charging & Video" Application Note** — https://www.diodes.com/assets/Evaluation-Boards/AP43781-C-Link-Monitor-PD-Charging-and-Video.pdf  
   USB-C PD Monitor 系統方塊圖、PD Controller/Buck-Boost/High-Speed MUX/Re-driver 架構、Alt Mode/Role Swap 流程。

5. **Realtek — RTS5450M USB Type-C PD Controller Datasheet (v0.92)** — https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/138/RTS5450M_5F00_Type_2D00_C_5F00_Power_5F00_Delivery_5F00_Controller_5F00_v0.92.pdf  
   Docking/Monitor Application Block Diagram、PD Controller 內部架構、I²C/SMBus 介面、AUX/HPD Detect、High-Speed MUX。

6. **THine Electronics — "V-by-One® HS goes beyond LVDS"** — https://www.thine.co.jp/en/contents/detail/serdes-v-by-onehs_2.html  
   V-by-One HS 介面架構、訊號定義 (DE/Hsync/Vsync)、優於 LVDS 的速率/線徑優勢。

7. **USPTO 專利文件** (US20150077408, US20070229434, US12688834) — LVDS/V-by-One/eDP 介面在系統中的連接拓樸、Panel ID 讀取路徑 (eDP AUX / I²C)、Backlight 控制架構。

> ⚠️ 註：Scaler/TCON/Panel 具體 register map、timing 參數、PD Controller FW API 屬 NDA 範圍，僅依公開資料整理架構概念；實際開發需對照晶片廠 SDK 文件與 Panel Spec。
