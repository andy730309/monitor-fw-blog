---
layout: post
title: "HDR10 預測試全綠，Dolby Vision 一開卻洗白？PC 螢幕韌體端的動態 metadata 與模式管理"
date: 2026-11-04
tags: [Dolby Vision, HDR, tone mapping, metadata, HDMI, 認證]
level: intermediate
prerequisites: ["HDR10 PQ tone mapping 與 MaxCLL/MaxFALL（posts/2026-11-01-hdr10-pq-tone-mapping-maxcll-maxfall.md）"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-04
description: "HDR10 預測試全綠，開 Dolby Vision 卻洗白？說明動態 metadata 與 static metadata 的差別，以及韌體的模式管理。"
seo_title: "Dolby Vision 一開就洗白？動態 metadata 與模式"
difficulty: intermediate
---
> **重點摘要**：HDR10 用整部片共用的 static metadata，Dolby Vision 則是逐場景的動態 metadata 加上 display management。Dolby Vision 送來的仍是 PQ 影像，多出來的是每個場景該怎麼映射的資訊。韌體的工作是把這份 metadata 接進 pipeline，並管好模式的進出。

## 前置知識

先講一個類比。HDR10 的 static metadata 像是攝影師把「這部片最亮到 1,000 nits、平均亮度多少」寫在一張紙上，貼在影片卷盒外面；你的螢幕拿到卷盒，看一眼紙，就用同一套曲線從頭播到尾。Dolby Vision 則是攝影師跟著片子走進你家客廳，每換一個場景就現場看一眼你的電視能多亮、對比多少，然後當場重新調光。這就是「動態（scene-based）metadata」與「display management」的差別。

Dolby 官方把三種規格並排比較（Dolby Professional gaming 頁）：Dolby Vision 是 12 bit（每色 4096 階）、色域 P3 up to Rec. 2020、mastering 亮度 1,000 min. up to 10,000 nits，並具備 scene-based metadata 與 per-target artistic trims；generic HDR 是 10 bit（1023 階）、typically 1,000 nits；SDR 是 8 bit（256 階）、100 nits。訊號表示用的還是 PQ（SMPTE ST 2084），mastering 顯示器資訊用 SMPTE ST 2086，動態內容資訊用 SMPTE ST 2094（Dolby 白皮書《An Introduction to Dolby Vision》）。

幾個名詞先講清楚：

- **PQ（SMPTE ST 2084）**：HDR 的絕對亮度 EOTF，HDR10 與 Dolby Vision 共用。沒讀過的先看本系列 HDR10 tone mapping 那篇。
- **Display management**：Dolby 白皮書的說法，指顯示端把全範圍訊號依自身實際能力（峰值亮度、對比、色域）映射的流程。HDR10 靠你自己在韌體裡寫 tone map；Dolby Vision 則把「這個場景該怎麼映射」的線索（metadata）一起送過來。
- **L1 metadata**：Dolby Vision Color Grading Best Practices Guide v4 裡的分析 metadata，每個 shot 三個浮點值 L1 Min/Mid/Max，描述該 shot 的動態範圍（在 LMS 色彩空間分析）。這是 monitor 韌體端做動態 tone mapping 最直接的輸入。
- **Profile**：Dolby 定義的位流功能子集。串流生態以 profile 5（單層、無向下相容）、8.1（HDR10 相容）、8.4（HLG 相容）為主；UHD Blu-ray 走 profile 7 雙層。profile 字串格式是 dv[BL_codec_type].[bitstream_profile_ID]，例如 dvhe.05（HEVC、profile 5）。level 則限定該 profile 下的最大 frame rate、bit rate 與解析度。

一句話總結 monitor 韌體工程師的視角：Dolby Vision 送過來的還是 PQ 影像，多出來的是「每個場景該怎麼映射」的動態 metadata；你的工作是把這份 metadata 接進 pipeline，並把模式進出管理好。

## 技術核心

### metadata 分層：monitor 端真正有用的是 L1

Dolby Vision Color Grading Best Practices Guide v4 的 metadata level 表（依來源整理）：

| Level | 名稱 | 內容 |
| --- | --- | --- |
| L0 | 全域靜態 | Mastering Display、Global Aspect Ratio、Frame Rate、Target Display、Color Encoding、Algorithm/Trim Version |
| L1 | 分析 metadata（動態） | L1 Min、Mid、Max 三個浮點值，描述 shot 的動態範圍 |
| L2 | Per-target trim（動態） | Lift、Gain、Gamma、Saturation、Chroma、Tone Detail |
| L5 | Per-shot aspect ratio（動態） | Canvas、Image |
| L6 | 選配 HDR10 靜態 | MaxFALL、MaxCLL |

CMv4 另外加了 L3（L1 的 offset）、L8（二次色彩 trim）、L9（per-shot 來源 primaries）。對 monitor 韌體來說，L0 告訴你母版顯示器是誰，L1 告訴你現在這個場景的動態範圍，L6 就是你在 HDR10 路徑已經處理過的 MaxCLL/MaxFALL。

### monitor 韌體端要做什麼

Dolby Vision 的能力來自 scaler 晶片：profiles/levels 文件明說「Every Dolby Vision playback device must pass Dolby Vision system development kit certification」，晶片端的 DV 解碼與 display management 由 Dolby 認證。所以 ODM 韌體端的工作不是自己寫 tone mapping 演算法，而是四件事：

1. **VSIF 攔截與解析**：DV over HDMI 走 vendor-specific InfoFrame（VSIF）。位元組配置在 HDMI 規格與 Dolby licensee 文件裡（NDA），公開資訊不足，實作時對照手上的 NDA 文件。韌體第一件事是把 InfoFrame 攔下來看，不要當雜訊丟掉。
2. **模式狀態機**：SDR → HDR10 → DV 的進出。進入要連續多幀確認（防誤觸），退場要有 watchdog。
3. **動態映射整合**：把 L1 Min/Mid/Max 餵給晶片端 display management，knee 依 panel 實測峰值收斂，並做平滑。
4. **OSD 與 picture mode**：DV 模式鎖定會破壞 display management 的使用者參數，退出時解鎖。

修正骨架（示意，VSIF 欄位與暫存器地址皆非公開規格）：

```c
/* 示意地址，非實際晶片規格 */
#define REG_TMG_KNEE_LUT_ADDR  0x2C00  /* tone map knee LUT 基底 */
#define REG_BL_DUTY_GLOBAL     0x3E10  /* 背光全域 duty */

typedef enum { PIC_SDR, PIC_HDR10, PIC_DV } pic_mode_t;

typedef struct {
    float l1_min, l1_mid, l1_max;  /* L1 三值（單位依 licensee 文件，示意） */
    uint8_t valid;
} dv_l1_t;

/* 1) VSIF 解析：欄位為示意，實際 PB 佈局依 Dolby/HDMI licensee 文件（NDA） */
static bool dv_vsif_parse(const uint8_t *if_payload, size_t len, dv_l1_t *out)
{
    if (len < 8 || if_payload[0] != DV_VSIF_TYPE /* 示意常數 */)
        return false;
    out->l1_min = vsif_decode_min(&if_payload[2]);  /* 示意 */
    out->l1_mid = vsif_decode_mid(&if_payload[4]);  /* 示意 */
    out->l1_max = vsif_decode_max(&if_payload[6]);  /* 示意 */
    out->valid  = 1;
    return true;
}

/* 2) 狀態機：進入連續確認、退場 watchdog、單一 commit 出口 */
void dv_mode_task_1ms(void)
{
    if (g_dv.mode == PIC_HDR10 &&
        g_dv.vsif_seen_ms >= DV_ENTER_CONFIRM_MS /* 示意 */) {
        g_dv.mode = PIC_DV;
        osd_lock_user_pq_controls();
    } else if (g_dv.mode == PIC_DV &&
               g_dv.vsif_miss_ms >= DV_EXIT_TIMEOUT_MS /* 示意 */) {
        g_dv.mode = fallback_mode();   /* VSIF 消失 → 明示退回 */
        osd_unlock_user_pq_controls();
    }
    if (g_dv.mode != g_dv.committed)
        dv_pipeline_commit(g_dv.mode); /* 同 vblank 單一 commit */
}

/* 3) 動態映射：L1 → knee，快攻慢收平滑 */
void dv_frame_apply(const dv_l1_t *l1_in)
{
    if (!l1_in->valid)
        return;
    smooth_attack_release(&g_dv.l1_smooth, l1_in,
                          DV_ATTACK_FRAMES /* 示意 */, DV_RELEASE_FRAMES /* 示意 */);
    uint32_t knee = tm_knee_from_l1(&g_dv.l1_smooth, panel_measured_peak_nits());
    scaler_set_tm_knee(REG_TMG_KNEE_LUT_ADDR, knee);   /* 示意地址，非實際晶片規格 */
    bl_duty_submit_with_tm(knee, REG_BL_DUTY_GLOBAL);  /* tone map 與 duty 同 vblank */
}
```

這段程式碼裡，已查證的部分是「DV 為 PQ 訊號＋動態 metadata」與「L1 是 Min/Mid/Max 三值」（Dolby 公開文件）；示意的是 VSIF 欄位、DV SDK API 與所有 scaler 暫存器地址。

### 生態與驗證資源

Dolby 官方測試資源頁提供 profile 5、8.1、8.4 的測試串流（MPEG-DASH/HLS）與 MP4 測試檔，frame rate 涵蓋 24、25、30、50、120 fps，並分 DRM 與非 DRM 版本。UHD Blu-ray 的 profile 7 是雙層結構：base layer 給 HDR10 裝置播，enhancement layer 帶殘差與 DV metadata；殘差為零稱 MEL（minimum enhancement layer），非零稱 FEL（full enhancement layer）。PC 端的啟用條件（廠商文件）：monitor 需 Dolby 認證、Windows 需 HEVC 影片擴充模組、安裝 Dolby Access、串流源支援 Dolby Vision。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 ODM 的 4K 高階機種走到 DVT：HDR10 預測試全綠、DisplayHDR 也過了，品牌客戶驗收時開 Windows 的 Dolby Vision 串流，回報三個症狀，直接開客訴（Claim）。

**症狀一：DV 內容偏暗、高光死板，跟同片源 HDR10 模式觀感不一致。**量測發現韌體根本沒進 DV pipeline——InfoFrame 攔截層把不認得的 VSIF 當雜訊丟掉，畫面停留在 HDR10 靜態 tone map。DV 訊號本身是 PQ，硬套靜態曲線不會黑畫面，但 display management 的逐場景映射整個被丟掉，觀感自然不對。這種 bug 最陰險：畫面「看起來正常」，客戶卻說得出「哪裡不一樣」。

**症狀二：場景切換時亮度跳一下。**第一版修正把 L1 直接餵給 knee，結果換場景就跳。根因與先前 local dimming、DisplayHDR Subtitle Flicker 回合同構：映射參數沒有 attack/release 平滑，而且 tone map 與背光 duty 分兩次提交，兩表不同步。修正為快攻慢收平滑＋同 vblank 單一 commit。

**症狀三：串流結束回到桌面，SDR 畫面整個洗白。**DV 模式進入後沒有退場機制，VSIF 消失了韌體還停在 DV pipeline，SDR 內容被當 PQ 處理。修正為 watchdog：VSIF 消失超過門檻就明示退回 HDR10/SDR，並解鎖 OSD 參數。重插線才恢復這種客訴，十之八九是狀態機沒有退場路徑。

## 新人避坑指南

1. **先搞清楚能力界線**：DV 的解碼與 display management 在晶片端（Dolby SDK 認證），你寫的是整合層。拿到 SDK 先問清楚：L1 怎麼進來、knee 怎麼設、模式切換 API 是誰的。
2. **InfoFrame 不要靜默丟棄**：不認得的 VSIF 至少 log type 與長度。interop 除錯時，這幾行 log 決定你能不能在一天內定位「客戶說畫面怪怪的」。
3. **狀態機三件套**：進入連續確認、退場 watchdog、單一 commit 出口。跟 VRR/ALLM 回合的教訓一樣，metadata 是一等公民，不是附屬品。
4. **動態參數必須平滑**：任何逐場景變動的參數（knee、duty、OD）都要 attack/release，而且相關表格同 vblank 提交。否則你會在場景邊界收到 flicker 客訴。
5. **OSD 鎖定要對稱**：進 DV 鎖了哪些參數，退出就要解鎖哪些。鎖定清單寫成一張表，進出共用。
6. **驗證矩陣要涵蓋回退**：profile 5/8.1/8.4 串流、SDR/HDR10 回退、斷電重進、VSIF 中斷。Dolby 官方測試資源頁的測試串流直接拿來用。
7. **驗收前先查播放端環境**：Windows 需要 HEVC 擴充與 Dolby Access、串流源要支援 DV。很多「螢幕不支援 DV」的客訴，最後發現是 PC 端沒裝擴充模組。

## 思考題

Dolby Vision profile 8.1 號稱「HDR10 相容」：同一份位流丟給不支援 Dolby Vision 的 HDR10 裝置也能播。請去查 Dolby Vision profiles and levels 文件：profile 8.1 的 base layer 用什麼訊號格式與 VUI 設定達成這件事？它的 BL signal cross compatibility ID 是多少？

<details>
<summary>提示（想自己查再展開）</summary>
profiles/levels 文件的 Table 1 列出各 profile 的 BL/EL codec 與 BL VUI；profile 8（dvhe.08）的 base layer 為 10-bit HEVC，BL signal cross compatibility ID 為 16, 9, 9, 0（對應 HDR10 的 PQ/BT.2020 訊號）。串流生態常見的 8.1 即此 profile 的 HDR10 相容變體。
</details>

## 參考資料

- Dolby Professional — Gaming in HDR / Dolby Vision for developers（官方）：https://professional.dolby.com/gaming/gaming-getting-started/dolby-vision-for-developers/
- Dolby Professional — Dolby Vision for Content Creators（官方，Tier 1 參考顯示器規格）：https://professional.dolby.com/content-creation/dolby-vision-for-content-creators/
- An Introduction to Dolby Vision 白皮書 PDF（官方）：https://professional.dolby.com/siteassets/pdfs/dolby-vision-whitepaper_an-introduction-to-dolby-vision_0916.pdf
- Dolby Vision Color Grading Best Practices Guide v4 PDF（官方，metadata level 表）：https://professional.dolby.com/siteassets/pdfs/dolby_vision_best-practices_colorgrading_v4.pdf
- Dolby Vision UHD Blu-ray authoring workflow PDF（官方，profile 7 雙層/MEL/FEL）：https://professional.dolby.com/siteassets/pdfs/dolby_vision_uhd_bluray_authoring_workflow.pdf
- Dolby OTT Browser Test Kit — Additional resources（官方，profiles 與測試串流）：https://ott.dolby.com/browser_test_kit/help_files/topics/r_resources.html
- Dolby Vision profiles and levels specification（Dolby 文件，以下為非官方鏡像 PDF）：https://discourse.coreelec.org/uploads/short-url/bkogr9wOiH3jjKOmHt9C9IPzXqf.pdf
- ASUS 支援 FAQ — [LCD Monitor] Dolby Vision Introduction（廠商文件，非標準來源）：https://www.asus.com/us/support/faq/1053978/

提醒：Dolby Vision 的 HDMI 傳輸細節（VSIF 位元組配置）與 SDK 內部演算法屬 licensee/NDA 文件，本文僅依公開資訊撰寫，實作時請對照手上的 NDA 文件。
