---
layout: post
title: "切 HDR 閃怪色、場景一變就偏色？3D LUT 動態插值與模式切換的三個坑"
date: 2026-11-11
tags: [3D LUT, HDR, tone mapping, DisplayHDR, vblank, 色彩校正]
level: intermediate
prerequisites: ["3D LUT 還是 3x3 矩陣？廣色域螢幕 sRGB 模式中間色爆掉的真正原因", "HDR 電影高光整片死白？PQ tone mapping 的 hard clip 陷阱與 MaxCLL/MaxFALL 正確用法"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-12
description: "切 HDR 閃怪色、場景一變就偏色？拆解 3D LUT 載入非原子、插值方法、插值域與 vblank commit 四個根因。"
difficulty: intermediate
---
> **重點摘要**：切換畫質模式時閃怪色、HDR 場景變換時偏色，追下去有四個根因：LUT 載入不是原子切換、插值方法選錯、動態插值的插值域選錯，以及 commit 沒有對齊 vblank。所有影響畫面外觀的設定，都應該在 vblank 期間一次生效。

畫質模式切換是顯示器韌體裡最容易出事的路徑之一：sRGB 切 HDR 閃半秒怪色、HDR 影片場景一變就色偏、送 DisplayHDR 認證時 Subtitle Flicker 邊緣 fail。這三個坑看起來不相干，追下去會落在四個根因：LUT 載入不是原子切換、插值方法選錯、動態插值的插值域選錯、commit 沒有對齊 vblank。這篇照這四個根因拆開講清楚。

## 前置知識

先建立兩個類比。

**3D LUT 是一本「輸入色 → 輸出色」的對照表**。33×33×33 的 LUT 就是把 RGB 立方體每個軸切成 33 格，共 35,937 個節點，每個節點記錄 3 個輸出值，合計 107,811 個數字。畫面每個像素的顏色，先在立方體裡找到包圍它的那一格，再用格子頂點插值算出輸出。以 ICC lut16Type 的 CLUT 尺寸公式換算（ICC.1:2010 10.8，PDF p.66：2 乘 OutputChannels 乘 GridPoints 的 InputChannels 次方），一張 33³ 的 CLUT 部分是 2 × 3 × 33³ = 215,622 bytes。這是「每個值存 16-bit」的檔案格式大小；scaler 硬體 LUT RAM 每個值存幾 bit，要看晶片 datasheet（多屬 NDA 文件，待查證）。

**vblank 是換布景的空檔**。CRT 時代電子束從右下角跳回左上角的垂直空白期，現在的 LCD 面板同樣有這段時間：面板掃描完一幀、還沒開始掃下一幀的空檔。所有「會影響畫面外觀」的設定（LUT、gamma、背光 duty、模式），都應該在 vblank 裡一次生效，下一幀整幀都是新設定。如果在掃描到一半時改設定，同一幀就會上半部舊、下半部新。

插值方法有兩種主流：**trilinear（三線性）**用包圍點的 8 個頂點沿三軸各插一次；**tetrahedral（四面體）**把包圍的立方體切成 6 個四面體，判斷點落在哪一個，只用該四面體的 4 個頂點插值。OpenColorIO 的 Interpolation enum 把這件事講得很明白：INTERP_LINEAR（值 2）對 3D LUT 就是 trilinear；INTERP_TETRAHEDRAL（值 3）標明「Lut3D only」；INTERP_BEST（值 255）對 3D LUT 選 tetrahedral、INTERP_DEFAULT（值 254）對 3D LUT 選 trilinear（見參考資料 4）。也就是說，OCIO 的預設是 trilinear，標成「最佳」的才是 tetrahedral。

## 技術核心

### 根因一：LUT 載入非原子，pipeline 已切新模式但 LUT 只寫了一半

最常見的錯誤順序：先把 pipeline 模式暫存器切到 HDR（EOTF 換成 PQ、gamut matrix 換掉），才開始把 HDR 的 3D LUT 逐筆寫進 scaler 的 LUT RAM。215,622 bytes 走 SPI 或內部匯流排，加上 MCU 逐筆寫暫存器的負擔，是數百 ms 級的工程（實際時間依平台匯流排速率，待實測標定）。這段時間 pipeline 跑的是「舊 LUT 內容＋新模式設定」的混合體，於是畫面閃出洋紅或綠色偏，使用者以為螢幕壞了，客訴就來了。

修正：LUT RAM 做兩個 bank，而且「寫入目標 bank」與「pipeline 讀取 bank」要由兩個不同的選擇位元控制。新 LUT 寫進非作用中 bank，全部寫完並通過 CRC 後，在 vblank 中斷裡一次切讀取 bank，同一個 vblank 內把 pipeline 模式一起切。載入期間畫面完全不受影響。平台若沒有雙 bank，退而求其次是載入期間先讓畫面靜音（黑畫面或關背光），載完再一起恢復，不要讓半套 LUT 上畫面。

### 根因二：插值方法——trilinear 在灰階軸混進非灰階頂點

tetrahedral 有一個可以直接推導的性質：當輸入 R＝G＝B（灰階）時，點落在立方體對角線上，6 個四面體都共用這條對角線，插值只用到對角線兩端的頂點（黑端與白端），權重是 (1 − t) 與 t。也就是灰階輸入只會用到灰階軸上的節點。trilinear 則固定混合 8 個頂點，灰階輸入也會混進 6 個非灰階頂點的值；LUT 在這些頂點有色偏修正時，灰階就會帶出一點色調。這也是 tetrahedral「只在 luma 落在對角線的色彩空間（RGB、CMY）上好用」的原因[^1]。

至於飽和色區，兩種方法誰誤差小取決於 LUT 本身的曲率，沒有一定的方向，要以 ΔE00 實測比較（待查證：本篇沒有可引用的公開量測資料）。ICC.1:2010 也沒有規定 CLUT 必須用哪一種插值：全文查無 tetrahedral 或 trilinear 字樣，10.8 只要求某一維只有 2 個資料點時，資料要讓線性插值得到正確結果（PDF p.67）。lcms2 對 3 個輸入通道預設用 tetrahedral，只有呼叫端指定 trilinear 旗標時才改用 trilinear，這是該專案的實作選擇（見參考資料 5）。

實務上：硬體插值引擎若有 tetrahedral 選項，廣色域與 HDR 模式預設啟用；只有 trilinear 引擎時，靠提高節點密度降低插值誤差（33³ → 65³；以每個值 16-bit 計，從 215,622 bytes 變成 65³ = 274,625 節點、×3 通道×2 bytes = 1,647,750 bytes，LUT RAM 容量夠不夠要跟晶片原廠確認，多屬 NDA 文件），並在驗證時對灰階與飽和色的「節點之間」量 ΔE00。

### 根因三：動態插值的插值域——直接混合兩張 LUT 的輸出值

「動態插值」指兩張 anchor LUT（例如 knee 位置不同的兩張 tone map LUT）之間，依即時參數產生中間 LUT。常見的偷懶做法是直接對兩張 LUT 的輸出值做線性混合。這樣得到的中間 LUT，通常不等於「用中間參數算出來的那條曲線」：混合結果不屬於原本那一族曲線，差異集中在兩張 anchor 不一樣的區段。以 knee 型 tone map 為例，兩條曲線在較低的 knee 起點以下都是同一條線，混合不會改變這一段；差異出現在 knee 到高光之間。差多少取決於兩張 anchor 差多遠，要實測（待查證）。

比較穩的做法是在**產生 LUT 的參數域**插值：knee 位置、gain、目標白點 xy 先插值，再重算 LUT。這樣中間結果一定是同一族裡的合法曲線，端點與單調性都有保證。背景是：PQ 訊號代表絕對亮度，最高 10,000 cd/m²（BT.2390-12 PDF p.20）；面板做不到參考監看條件時，顯示端要改變顯示特性，BT.2390-12 稱為 display mapping（5.4 節，PDF p.24）。BT.2390-12 這一節只說明為什麼需要 display mapping，具體做法它指向 BT.2408 與 BT.2446（頁碼待查證）。動態 tone map 移動 knee，就是把 display mapping 參數化，插值應該發生在這些參數上。

### 根因四：commit 不同步 vblank

LUT 寫入與模式切換不與 vblank 對齊，一幀之內就會出現上半部新 LUT、下半部舊 LUT。DisplayHDR CTS 1.2 的 Subtitle Flicker 測項，考的是「local dimming 由背光功率控制與 LCD transparency 控制組合而成，必須正確調變，使場景中應保持穩定的元素輸出亮度維持穩定」（displayhdr.org performance criteria 頁意譯，見參考資料 1），字幕開關時 patch 亮度差門檻依 tier 為 10–13%。這個測項主要考 local dimming 演算法本身；commit 時序是其中一個會出事的環節：duty 與 LCD gain 要同 vblank 提交，否則會有一幀亮度跳動。LUT 切換也要守同一個規矩。

修正後的 commit 狀態機（示意程式碼；所有暫存器地址與 Macro 名稱皆為示意，非任何實際晶片規格）：

```c
/* 3D LUT 雙 buffer 與 vblank commit 狀態機（示意）
 * 暫存器地址與 Macro 名稱皆為示意，非實際晶片規格。
 * 前提：硬體的「寫入目標 bank」與「pipeline 讀取 bank」由不同暫存器控制。 */
#include <stdint.h>

#define REG_LUT3D_BANK_SEL      0x2A10u  /* 示意地址，非實際晶片規格：pipeline 讀取 bank，0=bank A, 1=bank B */
#define REG_LUT3D_DATA_PORT     0x2A14u  /* 示意地址，非實際晶片規格：LUT 寫入資料埠 */
#define REG_LUT3D_WR_BANK       0x2A18u  /* 示意地址，非實際晶片規格：寫入目標 bank，不影響 pipeline */
#define REG_PIPE_MODE           0x2A20u  /* 示意地址，非實際晶片規格：pipeline 模式（SDR/HDR） */

#define LUT_GRID        33u                       /* 33x33x33 節點 */
#define LUT_ENTRIES     (LUT_GRID * LUT_GRID * LUT_GRID * 3u)  /* 107,811 個值 */

/* 以下為平台提供的函式（示意名稱，非實際 SDK） */
extern void     Scaler_Write_Register_Byte(uint32_t reg, uint8_t val);
extern void     Scaler_Write_Register_Word(uint32_t reg, uint16_t val);
extern uint32_t lut_crc32(const uint16_t *data, uint32_t count);
extern uint32_t lut_bank_crc_hw(uint8_t bank);  /* 讀回 bank 內容算 CRC；平台沒有就只驗來源。
                                                   注意：要和 lut_crc32 用同一種 CRC 多項式與位元組順序 */

typedef enum {
    LUT_COMMIT_IDLE = 0,
    LUT_COMMIT_LOADING,       /* 正在寫入非作用中 bank */
    LUT_COMMIT_PENDING,       /* CRC 通過，等 vblank */
    LUT_COMMIT_DONE
} lut_commit_state_t;

/* 主迴圈與 vblank ISR 共用，必須是 volatile */
static volatile lut_commit_state_t s_state;
static volatile uint8_t s_active_bank;   /* 目前 pipeline 讀取的 bank */
static volatile uint8_t s_target_mode;

/* 逐筆寫入非作用中 bank；只動寫入目標，不動 pipeline 讀取 bank，畫面不受影響 */
static int lut_load_bank(uint8_t bank, const uint16_t *entries)
{
    if (bank == s_active_bank) {
        return -1;  /* 不允許覆寫作用中 bank */
    }
    Scaler_Write_Register_Byte(REG_LUT3D_WR_BANK, bank);  /* 示意 Macro */
    for (uint32_t i = 0; i < LUT_ENTRIES; i++) {
        Scaler_Write_Register_Word(REG_LUT3D_DATA_PORT, entries[i]); /* 示意 Macro */
    }
    return 0;
}

/* 主迴圈：先驗來源、再寫入、再驗寫入結果，全部通過才推進到 PENDING，不直接切 bank */
/* 回傳 0＝已排入 vblank commit，-1＝失敗（維持舊模式舊 LUT），呼叫端決定是否 retry */
int lut_request_switch(uint8_t target_mode, const uint16_t *new_entries, uint32_t crc_expect)
{
    uint8_t bank = (uint8_t)(s_active_bank ^ 1u);

    s_state = LUT_COMMIT_LOADING;
    if (lut_crc32(new_entries, LUT_ENTRIES) != crc_expect ||   /* 來源（flash／重算結果）正確 */
        lut_load_bank(bank, new_entries) != 0 ||
        lut_bank_crc_hw(bank) != crc_expect) {                 /* 寫進 LUT RAM 的內容正確 */
        s_state = LUT_COMMIT_IDLE;   /* 失敗：維持舊模式舊 LUT，上拋錯誤供 retry */
        return -1;
    }
    s_target_mode = target_mode;
    s_state = LUT_COMMIT_PENDING;   /* 最後才設 PENDING，ISR 看到時其他欄位都已就緒 */
    return 0;
}

/* vblank ISR：唯一允許切讀取 bank 與 pipeline 模式的地方（原子 commit）
 * 若暫存器有硬體 double-buffer（在 vsync 才 latch），優先用硬體 latch，不要只靠 ISR 時序。 */
void lut_vblank_isr(void)
{
    if (s_state != LUT_COMMIT_PENDING) {
        return;
    }
    uint8_t bank = (uint8_t)(s_active_bank ^ 1u);
    /* 同一個 vblank 內：先切 LUT 讀取 bank，再切 pipeline 模式，兩者下一幀同時生效 */
    Scaler_Write_Register_Byte(REG_LUT3D_BANK_SEL, bank);          /* 示意 */
    Scaler_Write_Register_Byte(REG_PIPE_MODE, s_target_mode);      /* 示意 */
    s_active_bank = bank;
    s_state = LUT_COMMIT_DONE;
}
```

動態插值的部分，原則是：**參數先插值，再重算**，不直接混合 LUT 輸出值。但要注意根因一的時間成本：重寫一整張 33³ 的 3D LUT 是數百 ms 級（待實測標定），不可能每幾幀就換一次。比較實際的分工是：3D LUT 負責色域與色彩校正，只在切模式時換；隨場景變動的 tone map 放在條目少的 1D tone curve 階段，重算後同樣走雙 buffer、綁 vblank 提交。你的 scaler 有沒有這一級、條目數多少、能不能雙 buffer，要查晶片 datasheet（多屬 NDA 文件，待查證）。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某廣色域機種（不具名），sRGB 與 HDR 模式各有一張 33×33×33 的 3D LUT 存在 SPI flash，開機載入 SRAM。DVT 試產後三個症狀同時冒出來：

1. **切模式閃怪色（客訴）**：使用者從 sRGB 切到 HDR 遊戲模式，畫面先閃約半秒的洋紅／綠色偏再恢復。客訴原話是「切 HDR 螢幕會閃一下怪色，以為是壞點」。量測：capture card 連拍切換過程，抓到數幀「新模式設定＋舊 LUT 內容」的混合畫面，色偏幀出現的時間窗與 LUT 載入時間吻合。
2. **HDR 場景切換色偏 flash**：HDR 影片場景亮度劇變時，動態 tone mapping 重算整張 3D LUT，畫面出現一瞬間色偏。韌體分析：重算後的 LUT 直接寫進作用中 bank，沒有走雙 bank commit；另外 FW 對兩張 anchor LUT 的輸出值（PQ 域）直接線性混合，knee 到高光這段和參數插值的結果不同。把 tone map 移到 1D tone curve 階段、改成參數域插值並綁 vblank 提交後，色偏幀消失。
3. **DisplayHDR 預測試 Subtitle Flicker 邊緣 fail**：字幕開關時 patch 亮度差偶爾超過門檻（依 tier 10–13%，見參考資料 1）。這次的根因是 LUT、背光 duty、LCD gain 三者的 commit 沒有收斂到同一個 vblank，掃描中途生效造成半新半舊幀。三者綁同一 vblank 單一出口後，量測值穩定落在門檻內。

三個症狀追到底，就是開頭說的四個根因：LUT 不是原子切換、插值方法選錯、插值域選錯、commit 沒對齊 vblank。

## 新人避坑指南

看懂這幾個東西，就不會重蹈覆轍：

- **LUT bank select 暫存器**：控制 pipeline 讀取路徑用哪個 bank。切換它的時機就是「畫面換內容」的時機，必須在 vblank 裡。寫入目標的選擇與讀取路徑分離的硬體設計，是雙 buffer 的前提；你的平台支不支援，要查晶片 datasheet（多為 NDA 文件，向原廠確認）。不支援時，載入期間先讓畫面靜音。
- **vblank 中斷**：所有影響畫面外觀的 commit 的唯一出口。LUT bank、pipeline 模式、背光 duty、LCD gain，能綁同一個 vblank 就綁同一個。
- **插值引擎的 Interpolation 選項**：查你的 scaler 有沒有 tetrahedral 模式。OCIO 官方文件把 INTERP_BEST 對 3D LUT 定成 tetrahedral，這是選型的風向球。
- **CRC**：LUT 從 flash 載入或動態重算後，先驗來源 CRC，寫進 LUT RAM 後能讀回就再驗一次，才 commit。CRC 失敗的行為要定義清楚：維持舊模式舊 LUT、上拋錯誤、限制重試次數，不要 fallback 到半套設定。

未來寫 code 或驗證時的檢查清單：

1. 模式切換一律走「載入非作用中 bank → CRC → vblank 單一 commit」，禁止邊載入邊生效。
2. LUT bank 切換與 pipeline 模式（EOTF、gamut matrix、InfoFrame 處理）綁同一個 vblank，不可分幀生效。
3. 動態 tone map 放在可快速更新的階段，重算限速並綁 vblank；Subtitle Flicker 預測試納入 nightly。
4. 驗證矩陣加入「切模式瞬間」的 capture card 連拍，確認無半新半舊的色偏幀。
5. 插值抽測點要選在兩個節點正中間。33 格 LUT 的節點在 k/32，75% 正好是第 24 個節點（0.75 × 32 ＝ 24），17 格 LUT 也一樣（0.75 × 16 ＝ 12），在節點上量不到插值誤差。抽測點取 (k + 0.5)/32 一帶的灰階與飽和色，trilinear 與 tetrahedral 各量一輪 ΔE00。
6. 產線校正寫 LUT 同樣走雙 buffer commit，避免校正中途畫面跳動干擾量測。

## 思考題

INTERP_DEFAULT 對 3D LUT 選 trilinear、INTERP_BEST 選 tetrahedral，而且這兩個「subject to change in minor releases」[^2]。問題：ICC.1:2010 (v4.3) 的 lut16Type／lutAToBType 條文，有沒有強制 CLUT 必須使用哪一種插值方法？如果沒有，為什麼多數 CMM 實作在 RGB 輸入時選 tetrahedral？提示：去查 ICC spec 的 10.8、10.10 與 Annex A，再對照 lcms 的公開原始碼註解。

<details>
<summary>方向提示（自己查完再看）</summary>

ICC.1:2010 沒有強制。10.8 規定 CLUT 尺寸（PDF p.66）、uInt16 除以 65,535 的編碼（PDF p.66），以及某一維只有 2 個資料點時要能用線性插值得到正確結果（PDF p.67）；全文查無 tetrahedral 或 trilinear 字樣。選 tetrahedral 的理由，lcms 1.x 的註解寫得很直接：為了速度，而且只在 luma 落在對角線的 RGB、CMY 上好用。這和根因二推導的灰階軸性質是同一件事。
</details>

## 參考資料

1. VESA Certified DisplayHDR — Performance Criteria（CTS 1.2 摘要表：Subtitle Flicker 門檻依 tier 10–13%、ΔITP 門檻、Active Dimming stops 等）：https://displayhdr.org/performance-criteria/ （官方）
2. Report ITU-R BT.2390-12（03/2025）— High dynamic range television for production and international programme exchange（PQ 10,000 cd/m² 見 PDF p.20；5.4 Display mapping 見 PDF p.24）：https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2390-12-2025-PDF-E.pdf （官方）
3. Specification ICC.1:2010 (Profile version 4.3.0.0) — 10.8 lut16Type（PDF p.65–67：CLUT 尺寸公式與 uInt16 ÷65,535 在 PDF p.66，2 點線性插值規定在 PDF p.67）：https://www.color.org/specification/ICC1v43_2010-12.pdf （官方）
4. OpenColorIO 官方文件 — Interpolation enum（INTERP_LINEAR=2 trilinear for Lut3D、INTERP_TETRAHEDRAL=3 Lut3D only、INTERP_BEST=255 對 3D LUT 選 TETRAHEDRAL、INTERP_DEFAULT=254 對 3D LUT 選 LINEAR）：https://opencolorio.readthedocs.io/en/latest/api/enums.html （官方開源文件）
5. Little CMS 原始碼：lcms2 官方 repo 的 src/cmsintrp.c（3 個輸入通道預設 tetrahedral，指定 trilinear 旗標才改用 trilinear）：https://github.com/mm2/Little-CMS/blob/master/src/cmsintrp.c （官方開源）；lcms 1.x 的 cmsxform.c（RGB／CMY 選 tetrahedral 的註解）：https://www.askapache.com/pub/mozilla/modules/lcms/src/cmsxform.c （非官方鏡像，僅佐證實作選擇）

> 提醒：scaler 晶片的 LUT RAM 容量、插值引擎能力與暫存器定義多屬 NDA 文件，本文相關地址皆為示意，實作時請對照手上的 NDA 文件與晶片 datasheet。

[^1]: lcms 1.x 原始碼註解（原文寫法）；參考資料 5 為 lcms2 官方 repo 的 src/cmsintrp.c。lcms 1.x 的檔案與行號待查證。
[^2]: OpenColorIO 官方文件 — Interpolation enum，見參考資料 4。網頁文件，章節待查證。
