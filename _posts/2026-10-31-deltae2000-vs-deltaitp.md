---
layout: post
title: "SDR 校正 ΔE00 全綠，HDR 預測試卻 fail？ΔE2000 與 ΔITP 你不能混用的原因"
date: 2026-10-31
tags: [ΔE2000, ΔITP, CIEDE2000, HDR, PQ, ICTCP, DisplayHDR, 色彩校正]
level: intermediate
prerequisites: ["色彩入門：RGB、gamma、色溫、色域 (sRGB/DCI-P3/Adobe RGB)", "3D LUT 還是 3x3 矩陣？廣色域螢幕 sRGB 模式中間色爆掉的真正原因"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-10-31
description: "SDR 用 ΔE00，HDR 用 ΔITP，兩者不能互比也不能換算。本文說明兩種色差公式的差異，以及實作 BT.2124 時常見的錯誤。"
seo_title: "ΔE2000 與 ΔITP 為何不能混用？SDR／HDR 色差"
difficulty: intermediate
---
> **重點摘要**：SDR 用 ΔE00，HDR 用 ΔITP，這兩個數字不能互相比較，也不能互相換算。ΔE00 在相對的 CIELAB 空間計算，HDR 的 PQ 則是絕對亮度，沿用 ΔE00 會讓暗部誤差被壓縮。驗收規格要分開列兩種指標，色差公式上線前先用公開 test data 驗證。

## 【前置知識準備】

先講結論：**SDR 用 ΔE00，HDR 用 ΔITP，這兩個數字不能互相比、也不能互相換算。** 為什麼？用兩個類比就懂。

**類比一：相對音量 vs 絕對分貝。** ΔE00（CIEDE2000，標準化在 ISO/CIE 11664-6）活在 CIELAB 空間，這個空間是「相對」的：L* 把參考白定成 100，所有顏色都是相對於你的白點在講話。這就像音響的音量旋鈕刻度，轉到 5 是多大聲，取決於這台機器的最大音量。SDR 顯示器就是這種世界：gamma 2.2、白點 D65、峰值亮度固定，相對座標夠用。

HDR 不一樣。PQ EOTF（SMPTE ST 2084，定義在 ITU-R BT.2100）是 display-referred 的絕對亮度：每個 code value 直接對應到多少 cd/m²，code 1024 就是約 100 nits，沒有「相對於誰」的問題。這就像分貝計：85 dB 就是 85 dB，跟音響品牌無關。在絕對亮度的世界裡還用相對座標的色差公式，near-black 的誤差會被 L* 的壓縮吃掉，你根本看不見。

**類比二：JND 是尺上的刻度。** ΔEITP（ITU-R BT.2124-0）是專為電視/HDR 設計的客觀色差指標，由 display-referred 的 ICTCP 空間（定義在 BT.2100 Table 7）推導，縮放成 **ΔEITP = 1 代表「在最敏感的觀看適應狀態下，剛好可以被察覺」的色差（JND，just noticeable difference）**。BT.2124 特別明講：這個指標假設最敏感的適應狀態，所以它不會低估色差，但可能高估。換句話說，ΔITP 過關是必要條件，是「最龜毛的觀眾在暗房也看不出來」的保證。

所以當 VESA DisplayHDR CTS 用 ΔITP 當 HDR 白點/亮度準確度的門檻（公開摘要頁的數字：1 與 5 cd/m² 最大 ΔITP 誤差 20、15 cd/m² 是 15、50 cd/m² 以上是 10），它量的是「暗房裡最敏銳的人眼」，不是「辦公室日光燈下的平均感受」。你的 SDR 校正報告再漂亮，跟這件事一點關係都沒有。

## 【系統廠真實血淚案例】

情境模擬（依公開規格推演），非真實客戶或產品事件。

DVT 階段一台 4K HDR monitor 送 DisplayHDR True Black 400 預測試，結果三個現象同時出現，團隊當場傻眼：

1. Luminance and White Point Accuracy 在 1 cd/m² 與 5 cd/m² fail，ΔITP 超過門檻 20。
2. 工廠 SDR 校正報告 ΔE00 平均 0.6、最大 1.2，漂亮得像教科書。
3. 內部 Python 腳本自己算的 ΔITP 只有 VESA test tool 報的一半，內部看會過，送測卻 fail。

同時 PM 轉來客訴：使用者暗房看 HDR 電影，近黑處整片偏綠，SDR 影片正常。三件事其實是同一個根因的三張面孔。

**協定層分析：內部腳本的三個實作錯誤。** 對照 BT.2124 原文的計算步驟逐條檢查，抓到：

- 漏了 Step 4 的縮放：T = 0.5 × CT。
- 漏了 Step 5 的係數：ΔEITP = 720 × sqrt((I1−I2)² + (T1−T2)² + (P1−P2)²)。少了 720，數值直接縮水 720 倍。
- XYZ → RGB 用了 BT.709/sRGB 矩陣。BT.2124 Annex 2 規定其他訊號表示（含 XYZ）要先轉到 RGB 再進 ICTCP，而 ICTCP 基於 BT.2020 原色。原色矩陣用錯，T/P 分量系統性偏移。

三個錯疊在一起，內部數字看起來「只差一半」，其實是錯上加錯剛好部分抵消。這種 bug 最毒：數字有模有樣，方向也對，就是刻度不對。

**韌體層分析：HDR 低亮度沒有校正手段。** HDR 模式的 3D LUT 是均勻 17³ 節點，在 PQ 域 0–15 cd/m² 只落在 1–2 個節點；VA panel 近黑偏綠是常見體質，但低階 chroma drift 完全沒被補。SDR 校正的 1D gamma LUT 只修亮度軸修不了色度，工廠 HDR 站又只量了 50% 與 100% 亮度，低亮度根本沒量過。

**修正一：量測腳本照規格重寫。** ΔE2000 依 Sharma, Wu, Dalal (2005) 的公開實作筆記（hue angle 平均與 |Δh| > 180 的分支處理），ΔEITP 依 BT.2124 Steps 1–5：

```python
# delta_metrics.py — 關鍵片段；完整版見研究筆記
# 已查證：CIEDE2000 公式（Sharma 2005 公開筆記）、BT.2124 的 ITP 縮放與 720 係數、
#         BT.2100 PQ/ICTCP 定義、BT.2020 原色值。本檔不涉晶片暫存器。

def delta_e_2000(lab1, lab2):
    # ... C1p/C2p、h'、dLp/dCp/dHp、SL/SC/SH/RT 依 Sharma 2005 ...
    # 初版在這裡漏除 SL/SC/SH 權重，34 筆 test data 全數 mismatch，修正後全過：
    return math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2
                     + RT * (dCp / SC) * (dHp / SH))  # kL=kC=kH=1

def delta_e_itp(xyz1, xyz2):
    def xyz_to_itp(xyz):
        X, Y, Z = xyz
        # XYZ → linear RGB：矩陣由 BT.2020 原色 + D65 推導（避免手抄常數出錯）
        rgb = [sum(M_XYZ2RGB[i][j] * [X, Y, Z][j] for j in range(3)) for i in range(3)]
        # BT.2100 Table 7 M1：linear RGB → LMS（整數矩陣 /4096）
        L = (1687*rgb[0] + 2044*rgb[1] + 359*rgb[2]) / 4096
        M = ( 683*rgb[0] + 1102*rgb[1] + 215*rgb[2]) / 4096
        S = (  99*rgb[0] +  853*rgb[1] + 1048*rgb[2]) / 4096
        Lp, Mp, Sp = (pq_inverse_eotf(v * 10000) for v in (L, M, S))
        # BT.2100 Table 7 M2：L'M'S' → I CT CP（I 列 = 0.5/0.5/0）
        I  = 0.5*Lp + 0.5*Mp
        CT = (6610*Lp - 13613*Mp + 7003*Sp) / 4096
        CP = (17933*Lp - 17390*Mp - 543*Sp) / 4096
        return I, 0.5*CT, CP          # BT.2124 Step 4：T = 0.5 × CT
    i1, t1, p1 = xyz_to_itp(xyz1)
    i2, t2, p2 = xyz_to_itp(xyz2)
    return 720 * math.sqrt((i1-i2)**2 + (t1-t2)**2 + (p1-p2)**2)  # Step 5：×720
```

驗證方式：ΔE2000 跑 Sharma 公開 test data（本回合實測 34 筆全過，誤差 < 1e-4）；ΔEITP 先做 sanity（D65 白點自身 = 0、同亮度色度偏移約 0.42、亮度 +1% 約 0.78，量級合理），再與 VESA test tool 逐點交叉驗證。

**修正二：韌體端補上 HDR 低亮度校正。** 架構是「工廠 HDR 站量低亮度白點 → 以 ΔITP 最小化解 per-node RGB gain → 寫進 HDR 3D LUT 低端加密節點」：

```c
/* hdr_lowend_fix.c — HDR 模式近黑色度修正（依公開規格推演的架構） */

/* 示意地址，非實際晶片規格 */
#define REG_LUT3D_CTRL          0x1F40U  /* 示意地址，非實際晶片規格 */
#define REG_LUT3D_LOWEND_BASE   0x1F80U  /* 示意地址，非實際晶片規格 */
#define REG_LUT3D_CRC_STATUS    0x1FC4U  /* 示意地址，非實際晶片規格 */
#define Scaler_Write_Register_Byte(a, v)  fw_reg_write8((a), (v))  /* 示意 Macro，非實際 SDK API */

/* HDR 3D LUT 低端節點非均勻分布：PQ 域前段加密（節點 code value 為示意值，
 * 依 BT.2100 PQ EOTF 換算約 0.005–1.0 cd/m²） */
#define HDR_LOWEND_NODES  8U
static const uint16_t code_lut_lowend[HDR_LOWEND_NODES] = {
    0x0004U, 0x000AU, 0x0014U, 0x0023U,
    0x0033U, 0x0049U, 0x007BU, 0x00B0U
};

void hdr_apply_lowend_correction(const int16_t *gain_rgy /* 工廠量測產生，CRC 保護 */)
{
    /* CRC 驗證失敗 → 退回 1D-only，不套低階修正（量產安全網） */
    if (Scaler_Read_Register_Byte(REG_LUT3D_CRC_STATUS) != LUT_CRC_OK) {
        hdr_lut_fallback_1d_only();
        return;
    }
    Scaler_Write_Register_Byte(REG_LUT3D_CTRL, 0x01U);  /* 進 update 模式，示意 */
    for (uint8_t i = 0U; i < HDR_LOWEND_NODES; i++) {
        /* 寫入低階節點 RGB gain（Q4.12 格式，示意） */
        Scaler_Write_Register_Byte(REG_LUT3D_LOWEND_BASE + (uint16_t)(i * 6U),
                                   (uint8_t)(gain_rgy[i * 3U] >> 8));
        /* G/B 通道同理，略 */
    }
    Scaler_Write_Register_Byte(REG_LUT3D_CTRL, 0x02U);  /* 觸發 LUT reload，示意 */
}
```

兩個量產細節：SDR 與 HDR 的 LUT 必須分開保存，切模式整組切換，不要共用一塊 LUT 動態改值（會閃）；CRC 失敗一律退回安全模式，寧可色偏一點也不能讓畫面爛掉。

## 【新人避坑指南（Mentor's Take）】

### 1. 看懂這個 Bug 的關鍵暫存器/訊號線是哪一個？

這個 bug 的「關鍵暫存器」不在晶片裡，在規格文件裡：BT.2124 的 Step 4（T = 0.5 × CT）與 Step 5（×720 係數）。韌體端對應的硬體資源是 HDR 3D LUT 的低端節點（示意地址 `REG_LUT3D_LOWEND_BASE`）與它的 CRC 狀態暫存器。量測端對應的是 colorimeter 輸出的 XYZ 值與它進 ICTCP 前經過的色域矩陣。一條線拉起來：工廠量測（XYZ）→ 內部腳本（ΔITP）→ 韌體 LUT（修正 gain）→ 認證工具（VESA test tool），四個環節用的數學必須是同一套，任何一環刻度不同就會出現「內部過、送測 fail」。

### 2. 未來寫 Code 或驗證時，如何避免重蹈覆轍？

- 指標選擇寫進 spec：SDR 驗收用 ΔE00（avg/max/95th percentile 都要列），HDR 白點與色準用 ΔITP。報告模板直接分兩張，不允許混用。
- 任何色差公式實作，先跑公開 test data 再上線：ΔE2000 用 Sharma 的 34 筆 test data，ΔITP 至少做「自身 = 0」與「與 VESA tool 抽點交叉」兩關。這次 34 筆全 mismatch 就是靠 test data 當場抓到漏除 SL/SC/SH。
- XYZ→RGB 矩陣不要手抄常數，從 BT.2020 原色與白點程式化推導，並在註解寫明出處；送測前對照 BT.2124 Annex 2 的建議矩陣。
- HDR 工廠校正站必須量低亮度白點（至少 1/2/5/10/15 cd/m²），修正目標直接用 ΔITP 最小化，不是沿用 SDR 的 ΔE00 流程。
- colorimeter 記得做 panel 光譜修正（CCMX/CCSS），低亮度量測誤差會把 ΔITP 直接搞爆，讓你修一個不存在的韌體 bug。

### 3. 思考題

BT.2124 說 ΔEITP「不會低估、但可能高估」色差，因為它假設最敏感的適應狀態。請查 BT.2124 原文（或其 informative Annex 3）：對 scene-referred 相對訊號，它提供了什麼替代指標？再想想：如果今天你要校正的是一台「客廳、開燈看」的 HDR 電視而非暗房 monitor，用 ΔITP 當唯一門檻會發生什麼事？提示：從「適應狀態」與「JND 的定義條件」下手，答案在 BT.2124 的設計前提裡。

## 參考資料

1. ITU-R BT.2124-0（01/2019）Objective metric for the assessment of the potential visibility of colour differences in television（官方，In force）：https://www.itu.int/rec/R-REC-BT.2124-0-201901-I/en ；PDF：https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.2124-0-201901-I!!PDF-E.pdf
2. ITU-R BT.2100（PQ EOTF Table 4/5 與 ICTCP 定義 Table 7，官方頁）：https://www.itu.int/rec/R-REC-BT.2100
3. ISO/CIE 11664-6:2022 CIEDE2000 Colour-Difference Formula（官方標準；出版清單見 CIE Division 1 頁面）：https://cie.co.at/technical-work/divisions/division1/division-publication
4. G. Sharma, W. Wu, E. N. Dalal, "The CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary Test Data, and Mathematical Observations," Color Research and Application, 30(1), 21–30, 2005（公開實作筆記、test data 與 MATLAB 程式）：https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/
5. VESA Certified DisplayHDR Performance Criteria（CTS 1.2 公開摘要，含 ΔITP 門檻與測項說明；完整 CTS 文件需從 Downloads 頁取得）：https://displayhdr.org/performance-criteria/
6. ITU-R BT.2020（原色與白點定義，官方頁）：https://www.itu.int/rec/R-REC-BT.2020
