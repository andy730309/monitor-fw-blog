---
layout: post
title: "EDID 入門：用 edid-decode 解析顯示器身分證"
date: 2026-10-29
tags: [EDID, edid-decode, DDC, DisplayPort, HDMI, CTA-861, 色彩]
level: beginner
prerequisites: []
series: "系列 A：顯示器是怎麼運作的"
roadmap_stage: foundations
sources_checked: 2026-10-29
difficulty: beginner
---
## 為什麼重要

當你把一台新螢幕接上筆電，作業系統「自動」跳出正確解析度、重新率、HDR 選項，背後靠的就是 **EDID (Extended Display Identification Data)**。EDID 就是顯示器的「身分證」：它告訴源端（顯卡、主機板、遊戲主機）「我是誰、我支援什麼解析度、我的色域是多少、我要用什麼時序」。

身為顯示器韌體工程師，你會在這些場合用到 EDID：
- **Bring-up 階段**：確認 panel spec 對應的 EDID 是否正確燒錄在 EEPROM
- **認證送測**：VESA DP CTS、HDMI CTS 都會檢查 EDID 結構合規性
- **客訴分析**：使用者反應「解析度錯誤、HDR 不亮、VRR 不支援」，第一步都是 `edid-decode` 看 EDID 有沒有少宣告能力
- **產線校正站**：自動化讀取 EDID 驗證機種、序號、製造週期

這篇文章會帶你從零開始，用 `edid-decode` 實際拆解一份 EDID，逐欄位理解含義。

---

## 核心概念

### EDID 是什麼？

**EDID (Extended Display Identification Data)** 是 VESA 定義的標準資料結構，儲存在顯示器內部的 **I²C EEPROM** (通常地址 0x50，透過 DDC 總線讀取)。源端上電後會讀取 EDID，得知顯示器支援的時序與功能。

- **Base Block (Block 0)**：固定 128 bytes，含製造商資訊、色度座標、基本時序清單、4 個 18-byte 描述子
- **Extension Blocks**：每個 128 bytes，最常見是 **CTA-861 Extension Block** (Tag 0x02)，用於 HDMI 額外支援的 VIC、音訊、HDR、Vendor-Specific Data (HDMI Forum、AMD FreeSync 等)
- **DisplayID**：較新的標準 (VESA DisplayID 2.x)，可取代或與 EDID 共存，支援更高頻寬與複雜拓樸

> **術語小抄**
> - **DDC (Display Data Channel)**：I²C 介面，源端讀 EDID 的總線
> - **DTD (Detailed Timing Descriptor)**：18-byte 詳細時序描述子
> - **VIC (Video Identification Code)**：CEA-861 定義的標準影像格式代碼
> - **SVD (Short Video Descriptor)**：CTA-861 VDB 中 1-byte 的 VIC 封裝
> - **VSDB (Vendor-Specific Data Block)**：廠商自定義資料區塊，如 HDMI Forum、AMD FreeSync

---

## 一步一步：用 edid-decode 解析 EDID

### 步驟 1：安裝工具

```bash
# Arch / Manjaro
sudo pacman -S v4l-utils

# Debian / Ubuntu
sudo apt update && sudo apt install v4l-utils

# Fedora
sudo dnf install v4l-utils
```

安裝完成後驗證：
```bash
edid-decode --version
# 輸出範例：edid-decode 1.0.0 (git-abc1234)
```

### 步驟 2：取得一份 EDID

最簡單的方式是從目前連接的螢幕讀取：

```bash
# 方法 A：用 xrandr 抓取 (需 X11)
xrandr --prop | edid-decode

# 方法 B：直接讀取 sysfs (Linux kernel 暴露的 EDID)
# 找出 connector 路徑
ls /sys/class/drm/card*-*/edid
# 讀取並解碼
cat /sys/class/drm/card0-HDMI-A-1/edid | edid-decode

# 方法 C：如果你手邊有 .bin 或 .hex 檔
edid-decode edid.bin
# 或 hex 文字檔
xxd -r -p edid.hex | edid-decode
```

> **提示**：如果是多螢幕，`xrandr --prop` 會一次列出所有 connector 的 EDID，`edid-decode` 會依序解碼每個 block。

### 步驟 3：看懂輸出 — Base Block (Block 0)

執行後你會看到類似這樣的輸出（以一台 27" 4K 螢幕為例）：

```
Block 0, Base EDID:
  EDID Structure Version & Revision: 1.4
  Vendor & Product Identification:
    Manufacturer: ABC
    Model: 1234
    Serial Number: 0
    Made in: week 12 of 2024
  Basic Display Parameters & Features:
    Digital display
    Maximum image size: 60 cm x 34 cm
    Gamma: 2.20
    DPMS levels: Off
    RGB color display
    First detailed timing is the preferred timing
  Color Characteristics:
    Red  : 0.640, 0.330
    Green: 0.300, 0.600
    Blue : 0.150, 0.060
    White: 0.313, 0.329
  Established Timings I & II:
    DMT 0x04:   640x480    59.940 Hz   4:3    31.469 kHz   25.175 MHz
    DMT 0x10:  1024x768    60.004 Hz   4:3    48.363 kHz   65.000 MHz
  Standard Timings:
    DMT 0x52:  1920x1080   60.000 Hz  16:9    67.500 kHz  148.500 MHz
    DMT 0x55:  1280x720    60.000 Hz  16:9    45.000 kHz   74.250 MHz
  Detailed Timing Descriptors:
    DTD 1:  3840x2160   59.997 Hz  16:9   133.312 kHz  533.250 MHz (600 mm x 340 mm)
                 Hfront   48 Hsync  32 Hback  80 Hpol P
                 Vfront    3 Vsync   5 Vback  33 Vpol N
    DTD 2:  1920x1080   60.000 Hz  16:9    67.500 kHz  148.500 MHz (600 mm x 340 mm)
                 Hfront   88 Hsync  44 Hback 148 Hpol P
                 Vfront    4 Vsync   5 Vback  36 Vpol P
    Display Product Name: 'ABC 27" 4K Monitor'
    Monitor Range Limits:
      Monitor ranges (CVT): 30-144 Hz V, 30-160 kHz H, max dotclock 600 MHz
  Extension blocks: 1
Checksum: 0x33
```

我們逐段拆解：

#### 3.1 Header & 製造商資訊 (Bytes 0–19)

| 欄位 | 範例值 | 解讀 |
|------|--------|------|
| Header | `00 FF FF FF FF FF FF 00` | 固定模式，識別這是 EDID |
| Manufacturer ID | `ABC` | 3 大寫字母，**EISA 5-bit 編碼** (byte 8-9)，`0x04 0x21` → "AAA" |
| Product Code | `1234` | Little-endian，廠商自定 |
| Serial Number | `0` | 32-bit LE；若 CTA block 有序號，這裡常為 0 |
| Manufacture Week | `12` | 1–53 |
| Manufacture Year | `2024` | 1990 + byte 17 (34) |
| EDID Version | `1.4` | Major=1, Minor=4 |

#### 3.2 Basic Display Parameters (Bytes 20–24)

```
Digital display          ← Byte 20 bit 7 = 1 (數位介面)
Maximum image size: 60 cm x 34 cm  ← Byte 21, 22 (0 = 未指定，如投影機)
Gamma: 2.20              ← Byte 23: (120+100)/100 = 2.20
DPMS levels: Off         ← Byte 24 bit 7-5
RGB color display        ← Byte 24 bit 0 = 1 (非單色)
First detailed timing is the preferred timing  ← Byte 24 bit 0 (需查證實際 bit 位置)
```

#### 3.3 Chromaticity Coordinates 色度座標 (Bytes 25–34)

10 bytes 編碼 8 個 10-bit 值：Rx, Ry, Gx, Gy, Bx, By, Wx, Wy。

範例輸出的 `Red: 0.640, 0.330` 即為 sRGB 紅色原色座標。這決定了顯示器的**原生色域**。常見對照：
- **sRGB / Rec.709**：Red (0.640, 0.330), Green (0.300, 0.600), Blue (0.150, 0.060), White D65 (0.3127, 0.3290)
- **DCI-P3**：Red (0.680, 0.320), Green (0.265, 0.690), Blue (0.150, 0.060), White D65
- **BT.2020**：Red (0.708, 0.292), Green (0.170, 0.797), Blue (0.131, 0.046), White D65

> **實務提醒**：EDID 回報的座標是 **面板原生色域**，不代表輸出一定準確；還需經過 Factory Calibration (3D LUT / 3x3 matrix) 才能達成 ΔE < 1。

#### 3.4 Established Timings (Bytes 35–37)

3 bytes bitmap，對應 VESA 早期標準時序 (DMT)。例如：
- Bit 0 of byte 35 = 1 → 640×480 @ 60 Hz
- Bit 2 of byte 36 = 1 → 1024×768 @ 60 Hz

現代螢幕通常用 Standard Timings 或 DTD 取代，此區常為 0。

#### 3.5 Standard Timings (Bytes 38–53)

8 個 entries，每 2 bytes：
- Byte 0 (高 8 bits)：水平解析度 = (value + 31) × 8
- Byte 1 bit 7-6：長寬比 (00=16:10, 01=4:3, 10=5:4, 11=16:9)
- Byte 1 bit 5-0：垂直重新率 = value + 60 Hz

範例 `DMT 0x52: 1920x1080 60Hz 16:9` 對應 bytes `0x52 0x00` (需查證確切編碼)。

#### 3.6 Detailed Timing Descriptors (DTD, Bytes 54–125)

**這是最重要的區塊** — 每個 18 bytes，共 4 個 slots。第一個通常是 **Preferred Timing** (面板原生最佳時序)。

以 `DTD 1: 3840x2160 59.997 Hz` 為例，對應的 18 bytes 解碼：

| Byte | 值(HEX) | 含義 |
|------|---------|------|
| 0–1  | `D0 14` | Pixel Clock = 0x14D0 = 5328 → **532.8 MHz** (10 kHz units) |
| 2    | `00`    | H Active lsb |
| 3    | `C0`    | H Blanking lsb |
| 4    | `3F`    | H Active msb (4 bits) \| H Blanking msb (4 bits) |
| 5    | `84`    | V Active lsb |
| 6    | `1E`    | V Blanking lsb |
| 7    | `01`    | V Active msb \| V Blanking msb |
| 8    | `30`    | H Sync Offset lsb |
| 9    | `20`    | H Sync Pulse Width lsb |
| 10   | `30`    | V Sync Offset msb \| V Sync Pulse msb \| H Sync Offset msb \| H Sync Pulse msb |
| 11   | `58`    | H Image Size lsb (mm) |
| 12   | `01`    | V Image Size lsb (mm) |
| 13   | `02`    | H Size msb \| V Size msb |
| 14   | `00`    | H Border |
| 15   | `00`    | V Border |
| 16   | `18`    | Flags: bit 7=0 (progressive), bit 2=0 (V sync -), bit 1=1 (H sync +) |
| 17   | `00`    | Padding |

**手算驗證刷新率**：
- H Total = H Active + H Blanking = 3840 + 160 = 4000
- V Total = V Active + V Blanking = 2160 + 45 = 2205
- Pixel Clock = 533.25 MHz
- 刷新率 = 533,250,000 / (4000 × 2205) ≈ **60.00 Hz** ✓

> **關鍵欄位速查**：
> - `Hfront` = H Sync Offset (前廊)
> - `Hsync` = H Sync Pulse Width (同步脈寬)
> - `Hback` = H Blanking - H Sync Offset - H Sync Pulse Width (後廊)
> - `Hpol P/N` = H Sync Polarity Positive/Negative
> - 同理 Vfront/Vsync/Vback/Vpol

#### 3.7 Non-Timing Descriptors (非時序描述子)

當 DTD 前 2 bytes 為 `00 00`，第 3 byte 為 **Tag**：

| Tag | 名稱 | 內容 |
|-----|------|------|
| `0xFC` | Monitor Name | ASCII，最多 13 字元，`0x0A` 結尾 |
| `0xFD` | Monitor Range Limits | Min/Max V freq, Min/Max H freq, Max Pixel Clock, GTF/CVT 支援 |
| `0xFE` | ASCII String | 未指定用途 |
| `0xFF` | Product Serial Number | ASCII 序號 |
| `0x10` | Dummy Descriptor | 填充用 |

範例輸出中的：
```
Display Product Name: 'ABC 27" 4K Monitor'   ← Tag 0xFC
Monitor Range Limits: 30-144 Hz V...         ← Tag 0xFD
```

#### 3.8 Extension Block Count & Checksum (Bytes 126–127)

- Byte 126 = `01` → 有 1 個 Extension Block (通常是 CTA-861)
- Byte 127 = `33` → **Checksum**：前 127 bytes 加總 mod 256 = 0xCD，0xCD + 0x33 = 0x100 → 0 ✓

> **除錯技巧**：若 `edid-decode` 報 `Checksum error`，代表 EDID 讀取損壞或 EEPROM 未正確燒錄。

---

### 步驟 4：看懂輸出 — CTA-861 Extension Block (Block 1)

```
Block 1, CTA-861 Extension Block:
  Revision: 3
  Underscans IT Video Formats by default
  Basic audio support
  Supports YCbCr 4:4:4
  Supports YCbCr 4:2:2
  Native detailed modes: 1
  Video Data Block:
    VIC   1:   640x480    59.940 Hz   4:3    31.469 kHz   25.175 MHz
    VIC   4:  1280x720    60.000 Hz  16:9    45.000 kHz   74.250 MHz
    VIC  16:  1920x1080   60.000 Hz  16:9    67.500 kHz  148.500 MHz
    VIC  97:  3840x2160   60.000 Hz  16:9   135.000 kHz  594.000 MHz
  Audio Data Block:
    Linear PCM: Max channels 2, 48/44.1/32 kHz, 24/20/16 bits
  Vendor-Specific Data Block (HDMI), OUI 00-0C-03:
    Source physical address: 1.0.0.0
    DC_36bit
    DC_30bit
    Maximum TMDS clock: 300 MHz
  Vendor-Specific Data Block (HDMI Forum), OUI C4-5D-D8:
    Version: 1
    Maximum TMDS Character Rate: 600 MHz
    SCDC Present
    Supports 12-bits/component Deep Color 4:2:0
  Vendor-Specific Data Block (AMD), OUI 00-00-1A:
    Version: 1.1
    Minimum Refresh Rate: 40 Hz
    Maximum Refresh Rate: 144 Hz
    Flags: MCCS support
  Colorimetry Data Block:
    xvYCC601, xvYCC709, BT2020YCC, BT2020RGB
  HDR Static Metadata Data Block:
    Electro optical transfer functions: SMPTE ST2084
    Desired content max luminance: 400 cd/m²
    Desired content max frame-average luminance: 200 cd/m²
  Detailed Timing Descriptors:
    DTD 3:  1920x1080   60.000 Hz...
Checksum: 0x73
```

重點解讀：

| 區塊 | 關鍵資訊 | 實務意義 |
|------|----------|----------|
| **Revision** | 3 | CTA-861-H 為 Rev 3；Rev 1/2 已棄用 |
| **Video Data Block (VDB)** | VIC 清單 | 告訴源端「我支援這些標準格式」；VIC 97 = 4K@60 594 MHz (HDMI 2.0) |
| **Audio Data Block** | LPCM 2ch 24-bit | HDMI 音訊支援 |
| **HDMI VSDB (OUI 00-0C-03)** | Max TMDS 300 MHz | HDMI 1.4/2.0 相容；300 MHz = 4K@30 4:4:4 或 4K@60 4:2:0 |
| **HDMI Forum VSDB (OUI C4-5D-D8)** | Max TMDS Char Rate 600 MHz, SCDC Present | **HDMI 2.0+ 關鍵**：600 MHz = 4K@60 4:4:4；SCDC 允許源端讀取 sink 狀態 |
| **AMD FreeSync VSDB (OUI 00-00-1A)** | Min 40 Hz, Max 144 Hz | VRR 範圍；Flags 含 MCCS 表支援 DDC/CI 控制 |
| **Colorimetry Data Block** | BT2020YCC/RGB | 宣告支援 BT.2020 色域 (HDR 必備) |
| **HDR Static Metadata Data Block** | SMPTE ST2084 (PQ), MaxCLL 400 nits | **HDR10 必備**：宣告支援 PQ EOTF 與靜態中繼資料 |

---

## 圖解

### EDID 記憶體配置圖

```
+===============================+
|  I²C EEPROM @ 0x50 (DDC Bus)  |
+===============================+
| Block 0 (Base EDID)     128 B |  ← 必備
|   00h: Header (8B)            |
|   08h: Mfg ID + Product (4B)  |
|   0Ch: Serial + Date (6B)     |
|   12h: Version (2B)           |
|   14h: Basic Params (5B)      |
|   19h: Chromaticity (10B)     |
|   23h: Established Timings (3B)|
|   26h: Standard Timings (16B) |
|   36h: Descriptor #1 (18B) ← Preferred DTD
|   48h: Descriptor #2 (18B)    |
|   5Ah: Descriptor #3 (18B)    |
|   6Ch: Descriptor #4 (18B)    |
|   7Eh: Ext Block Count (1B)   |
|   7Fh: Checksum (1B)          |
+-------------------------------+
| Block 1 (CTA-861 Ext)    128 B |  ← HDMI 常見
|   00h: Tag=0x02, Rev, DTD Ofs |
|   04h: Data Block Collection  |
|   ...: DTDs (額外時序)         |
|   7Fh: Checksum               |
+-------------------------------+
| Block 2... (可選)         ...  |  ← DisplayID, DI-EXT, etc.
+===============================+
```

### DTD 18-byte 位元圖

```
Byte:  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17
      ┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐
      │ Pixel Clock (LE, 10kHz)     │ Hact │ Hblk │H/Hb│
      │                             │  lsb │  lsb │ msb│
      ├─────────────────────────────┼──────┼──────┼────┤
      │ Vact lsb │ Vblk lsb │V/Vb msb│Hsofs │Hspls │V/H │
      │          │          │ msb    │ lsb  │ lsb  │msb │
      ├──────────┼──────────┼────────┼──────┼──────┼────┤
      │H Size lsb│V Size lsb│H/V msb │H Bor │V Bor │Flags│Pad│
      └──────────┴──────────┴────────┴──────┴──────┴────┘

Flags (Byte 16) 位元定義:
  Bit 7: Interlaced (1=隔行)
  Bit 6-5: Stereo Mode (00=無, 01=Field Seq, 10=L/R, 11=Side-by-Side)
  Bit 4-3: Sync Type (00=Analog Composite, 01=Bipolar Analog, 10=Digital Composite, 11=Digital Separate)
  Bit 2: V Sync Polarity (0=Negative, 1=Positive)
  Bit 1: H Sync Polarity (0=Negative, 1=Positive)
  Bit 0: Reserved / Preferred Timing (視規格版本而定，需查證)
```

---

## 常見陷阱

| 現象 | 可能原因 | 排查方向 |
|------|----------|----------|
| `Checksum error` | EEPROM 燒錄失敗、I²C 讀取干擾 | 用 Logic Analyzer 抓 DDC 總線波形；確認 WP (Write Protect) 腳位 |
| 解析度卡在 1024×768 | EDID 沒宣告 Preferred DTD、或 DTD 參數錯 | 檢查 DTD 1 是否為面板原生時序、Pixel Clock 是否正確 |
| HDMI 無 4K@60 4:4:4 | 缺 HDMI Forum VSDB、或 Max TMDS Char Rate < 600M | 確認 CTA Block 有 HDMI Forum VSDB (OUI C4-5D-D8) 且 Max Char Rate ≥ 600 |
| HDR 不亮、灰階發白 | 缺 HDR Static Metadata Data Block、或 Colorimetry 無 BT.2020 | 檢查 Ext Tag 0x05、Colorimetry Data Block |
| VRR (FreeSync/G-SYNC) 不生效 | AMD VSDB 缺失、或 Min/Max Refresh 範圍不含目標 | 檢查 AMD VSDB (OUI 00-00-1A) 的 Min/Max Hz |
| 讀不到 Extension Block | Byte 126 = 0、或 I²C Segment Pointer 未切換 | Byte 126 應 > 0；讀 Block 1+ 時須先寫 Segment Pointer 0x30 (DDC) |
| 兩台同款螢幕 EDID 不一樣 | Panel vendor 不同批次、或 FW 版本不同 | 建立 EDID 黃金樣本 (Golden EDID) 做製程管制 |

---

## 動手練習

### 練習 1：抓取並解碼自己螢幕的 EDID

```bash
# 1. 列出所有 connector 的 EDID 路徑
ls /sys/class/drm/card*/edid

# 2. 解碼第一個 (通常是內建螢幕或主要外接螢幕)
cat /sys/class/drm/card0-eDP-1/edid | edid-decode

# 3. 只看 preferred timing
cat /sys/class/drm/card0-eDP-1/edid | edid-decode --preferred-timings
```

**觀察重點**：
- Manufacturer ID 是否為知名面板廠 (SAM=三星, LGD=LG, AUO=友達, BOE=京東方, CMN=華星光電)？
- Preferred DTD 的解析度、重新率是否符合面板規格書？
- 是否有 CTA-861 Extension Block (Extension blocks: ≥1)？

### 練習 2：手動驗證 DTD 刷新率

取得 DTD 1 的關鍵參數：
```bash
# 先存成 hex 方便查看
cat /sys/class/drm/card0-eDP-1/edid | xxd | head -80
```

找到 DTD 1 (offset 0x36 = 54 decimal 起始)，手算：
- Pixel Clock (bytes 0-1, LE, 10 kHz)
- H Active, H Blanking (bytes 2-4)
- V Active, V Blanking (bytes 5-7)
- 計算 H Total, V Total, Refresh Rate

對照 `edid-decode` 輸出是否一致。

### 練習 3：建立一份測試用 EDID (進階)

用 `edid-decode --format=carray` 輸出 C 陣列，修改後重新編譯燒錄：

```bash
# 1. 匯出 C 陣列
edid-decode --format=carray edid.bin > edid_carray.h

# 2. 編輯 edid_carray.h 修改 DTD 參數 (如改 Pixel Clock)

# 3. 編譯成 binary (需自行寫小程式或用 python)
python3 -c "
import sys
with open('edid_carray.h') as f:
    # 簡單解析陣列內容...
    pass
"
# 實務上建議用 edid-decode 讀回驗證而非手刻
```

> **注意**：修改 EDID 需確保 Checksum 正確 (byte 127)。`edid-decode` 讀取時會自動驗證。

---

## 自我檢測

<details>
<summary>點擊展開答案</summary>

**Q1: EDID Base Block 固定多少 bytes？Header 固定模式為何？**
> A: 128 bytes。Header (bytes 0–7) 固定為 `00 FF FF FF FF FF FF 00`。

**Q2: Manufacturer ID "ABC" 如何編碼在 EDID 中？**
> A: 3 個大寫字母，各佔 5 bits，共 15 bits 存在 bytes 8–9 (16 bits, 高 1 bit 保留)。編碼規則：A=1, B=2... Z=26。"ABC" → 0x01, 0x02, 0x03 → binary `00001 00010 00011` → byte 8=0x04, byte 9=0x21 (需查證確切 bit 排列)。

**Q3: DTD 中 Pixel Clock 單位為何？若 bytes 0-1 為 `8C 0A` (LE)，Pixel Clock 為多少 MHz？**
> A: 單位 10 kHz。`0x0A8C` = 2700 → **27.00 MHz**。

**Q4: CTA-861 Extension Block 中，哪個 Data Block 宣告支援 HDR10 (SMPTE ST 2084 PQ)？**
> A: **HDR Static Metadata Data Block** (Extended Tag 0x05)，其中 Electro-Optical Transfer Functions 含 SMPTE ST2084。

**Q5: 用 edid-decode 如何只輸出 CTA-861 的 Video Identification Codes (VICs)？**
> A: `edid-decode --timings=CTA edid.bin`

</details>

---

## 參考資料

1. **VESA Enhanced EDID Standard Release A, Revision 2 (EDID 1.4)** — 官方規格書，定義 Base Block 結構、DTD 格式、Extension Block 規則。公開鏡像：https://glenwing.github.io/docs/VESA-EEDID-A2.pdf
2. **CTA-861-H: A DTV Profile for Uncompressed High Speed Digital Interfaces** — 定義 CTA-861 Extension Block、VIC、SVD、VSDB、HDR Static/Dynamic Metadata Data Blocks。https://ia800407.us.archive.org/26/items/ansi-cta-861-h-final/ANSI-CTA-861-H-Final.pdf
3. **edid-decode man page (v4l-utils)** — 工具指令完整參考。https://man.archlinux.org/man/extra/v4l-utils/edid-decode.1.en
4. **edid-info Rust crate 文件** — Base Block 結構表與範例程式碼。https://docs.rs/edid-info/latest/edid_info/base/
5. **Wikipedia: Extended Display Identification Data** — 概念性介紹與表格。https://en.wikipedia.org/wiki/Extended_Display_Identification_Data
6. **Extron: Understanding EDID** — 產業界易懂說明。https://www.extron.com/article/uedid
7. **Adams Desk: Learn to Read EDID on Linux** — 實際操作範例與輸出解讀。https://www.adamsdesk.com/posts/read-edid-e-edid-displayid-metadata-linux/
8. **bsdhw/EDID GitHub repo** — 大量實機 EDID 範例 (各品牌面板)。https://github.com/bsdhw/EDID
9. **Linux Kernel Documentation/EDID/edid.S** — Kernel 內建 EDID 範例與巨集定義。https://cos.googlesource.com/third_party/kernel/+/9e8312f5e160ade069e131d54ab8652cf0e86e1a/Documentation/EDID/edid.S

> **規格查證提醒**：VESA E-EDID 完整規格需會員權限下載；本文引用的數值以公開鏡像與開源實作 (edid-decode, edid-info, Linux kernel) 為準，關鍵編碼細節 (如 Video Input Definition byte 20 的介面類型對照、Preferred Timing bit 位置) 標註「需查證」，實務上請以手邊 NDA 版規格書為準。
