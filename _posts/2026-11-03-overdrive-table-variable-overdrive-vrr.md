---
layout: post
title: "240Hz 調好的 Overdrive，開 VRR 到 70fps 卻一圈白光？可變 Overdrive 的 LUT 分層與插值"
date: 2026-11-03
tags: [overdrive, variable overdrive, VRR, Adaptive-Sync, LUT, GtG, VA, ClearMR]
level: intermediate
prerequisites: ["顯示器系統方塊圖入門（posts/2026-10-29-monitor-system-block-diagram.md）", "3D LUT 還是 3x3 矩陣？廣色域螢幕 sRGB 模式中間色爆掉的真正原因（posts/2026-10-30-3d-lut-vs-3x3-matrix.md）"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-03
description: "240Hz 調好的 Overdrive 開 VRR 後出現白邊或拖影？說明可變 Overdrive 的 LUT 分層、插值與量產驗收要注意的地方。"
seo_title: "可變 Overdrive：VRR 白邊與 LUT 分層插值"
difficulty: intermediate
---
> **重點摘要**：很多 Overdrive LUT 是在最高更新率調出來的，開了 Adaptive Sync、影格率下降後，就會出現白邊或暗色拖影。解法是把更新率當成 LUT 的另一個維度分層，並在層與層之間插值。插值要注意死區、斜率與 vblank，驗收時也不能只量兩個點。

很多 gaming monitor 的 Overdrive 是在最高更新率調出來的。240Hz 下看起來乾淨，一開 Adaptive Sync、影格率掉到 70–90fps，暗場物件旁邊就多一圈白光；再掉到 50fps，又變成暗色拖影。這不是面板突然壞掉，而是韌體把「一張 LUT 打天下」這件事用到了 VRR 上。這篇把 Overdrive 的時間維度拆開，說明為什麼要分層、怎麼插值、以及量產時哪裡會踩雷。

## 前置知識

先想像液晶轉態像推一台很重的推車到月台上的指定位置。推太小力，時間到了還沒到；推太大力，衝過頭再彈回來。Overdrive 就是「多推一把」：用比目標更極端的驅動值，讓液晶更快接近目標。公開技術文把它寫成一個查表運算：

`A(B) = C`

A 是起始灰階，B 是目標灰階，C 是刻意過衝或不足的灰階。多數 scaler 每個像素、每個子像素（R、G、B）各查一次。這張表就是 Overdrive LUT。

問題在於，這張表只有「灰階→灰階」，沒有告訴你「這次轉態有多少時間可用」。固定更新率時，時間是固定的：240Hz 一個更新週期約 4.17ms，60Hz 約 16.67ms（1000/Hz 換算，四捨五入到小數兩位；TFTCentral 公開文章寫作 4.16ms，是無條件捨去）。同樣的推力，在 4.17ms 內剛好，在 16.67ms 內就會推過頭，而且過頭之後還被壓在目標外十幾毫秒，肉眼看到的就是亮邊或反轉殘影。

VRR（Variable Refresh Rate，可變更新率）把這個時間變成變數。影格率 48、60、72、90、120、144、165、200、240fps 都可能出現，每一次的更新週期都不一樣。你當然可以只用一張表，但那就等於承認某些影格率下的畫質要犧牲。可變 Overdrive（variable overdrive）做的就是：依當下的更新週期，選一張適合的表，或在高頻與低頻的表之間插值。

## 技術核心

### 為什麼一張 LUT 打天下會壞

固定 Overdrive 在不同更新率下會出現不同 artifact。Blur Busters 的公開討論寫得很直接：某個影格率下看起來是輕微 ghosting，另一個影格率下可能變成明亮的 corona。原因是液晶的轉態曲線不是瞬間完成，更新週期越長，像素越有時間被 overdrive 推過目標，然後停在目標外。

反過來，如果 LUT 是照低更新率調的，高更新率下時間不夠，像素還沒到目標就被下一次掃描截斷，看起來就是暗拖影。這就是為什麼同一台螢幕「240Hz 很清楚、70fps 一圈白光」，不是使用者眼睛的問題，是 LUT 沒有時間維度。

### 把更新率變成 LUT 的另一個維度

最直接的修法，是在幾個代表性更新率各存一張 LUT，這些點就叫 anchor。例如 48、60、72、90、120、144、165、180、200、240Hz。當面板實際影格週期落在兩個 anchor 之間，就用權重插值：

```c
/* 示意：anchor 以 period_us 由小到大排序（240Hz 在前、48Hz 在後），OD_ANCHOR_N 至少 2 */
typedef struct {
    uint16_t period_us;      /* 此 anchor 的面板實際影格週期 */
    const uint8_t *lut;      /* [3][17][17]，R/G/B 各一張 */
} od_anchor_t;

/* 每個 vblank 選一次 anchor 與權重，整幀固定 */
static void od_latch(void)
{
    /* 先對週期做死區與斜率限制（見下一段），再選 anchor */
    uint16_t t = od_filter_period(panel_get_frame_period_us());   /* 示意 API，非公開介面 */

    uint8_t i = 0u;
    while ((i + 1u < OD_ANCHOR_N) && (t > g_od_anchor[i + 1u].period_us)) {
        i++;
    }
    /* Out-of-bounds protection: ensure i+1 is always a valid anchor index.
     * If t exceeds all anchor periods, clamp i to the last valid pair. */
    if (i >= OD_ANCHOR_N - 1u) {
        i = OD_ANCHOR_N - 2u;
    }

    uint16_t t0 = g_od_anchor[i].period_us;
    uint16_t t1 = g_od_anchor[i + 1u].period_us;
    int32_t num = (int32_t)(t - t0) * 256;      /* Q8 權重 */
    int32_t den = (int32_t)(t1 - t0);
    int32_t w   = (num + den / 2) / den;

    if (w < 0)   w = 0;
    if (w > 256) w = 256;
    g_od.w_q8 = (uint16_t)w;
    g_od.lo = i;
    g_od.hi = i + 1u;
}
```

這裡有一個很容易寫錯的地方：**要用 panel 實際影格週期，不是 host FPS。** VRR 下 host 影格率、link 上的 timing、panel 實際 scanout 週期不一定同一個數字。低於 panel 最低更新率時，LFC（frame repetition）會讓同一張影格重送 n 次，panel 實際掃描週期變成主機週期除以 n，也就是更新率變成主機影格率的 n 倍（例如 40fps 重送 2 次，panel 跑 80Hz；倍率怎麼選依平台實作，待查證）。用 host FPS 選 LUT，會在 LFC 邊界選錯表。

### 插值不是萬靈丹：死區、斜率與 vblank

如果權重逐幀硬切，影格率在 anchor 邊界抖動時，Overdrive 會忽強忽弱，肉眼看到的是 pumping。修正有兩層：

1. **死區**：週期變化很小時不動，避免在邊界來回跳。
2. **斜率限制**：每一幀最多改變固定量，讓選表結果平滑追上目標。

兩層都要做在「週期」上，不要做在權重上。權重只在同一對 anchor 內有意義；跨到下一對 anchor 時，權重會從 256 跳回 0，若對權重做斜率限制，等效的表反而會突然跳一大格。

```c
#define OD_DEADBAND_US  50u    /* 示意值，依 panel 實測調整 */
#define OD_SLEW_US      500    /* 每幀最多移動 500us，示意值 */

static uint16_t s_t_filt;      /* 0 代表尚未初始化 */

static uint16_t od_filter_period(uint16_t t)
{
    if (s_t_filt == 0u) {      /* 第一幀直接採用量到的週期 */
        s_t_filt = t;
        return t;
    }
    int32_t d = (int32_t)t - (int32_t)s_t_filt;
    if ((d > -(int32_t)OD_DEADBAND_US) && (d < (int32_t)OD_DEADBAND_US)) {
        return s_t_filt;       /* 死區內不動 */
    }
    if (d >  OD_SLEW_US) d =  OD_SLEW_US;
    if (d < -OD_SLEW_US) d = -OD_SLEW_US;
    s_t_filt = (uint16_t)((int32_t)s_t_filt + d);
    return s_t_filt;
}
```

還有一個時序問題：LUT 或 anchor 的切換必須在 vblank 期間進行，切勿在掃描週期中途切換。若在 scanout 進行中換表，畫面上半部用舊表、下半部用新表，量測儀器會抓到瞬態，肉眼看到的是橫向接縫或閃爍。有 shadow bank 的平台，先把新表寫進 shadow 區，再在 vblank 一次 commit，讓整張畫面用同一張表。VRR 下週期每幀都可能變，這一步不能省。

### 截斷表的代價：17×17 與 VA 暗階熱點

完整的 256×256 Overdrive LUT 有 65,536 個值，以 8-bit 儲存約 64KiB（Blur Busters 公開數字）。如果 10 個 anchor 都用全表，單通道就約 640KiB，R/G/B 三通道各一張則約 1,920KiB，對多數 scaler 的 on-chip SRAM 不現實。所以實務上會用截斷表，例如 17×17、9×9 或 65×65，再靠雙線性插值補中間值。

截斷表的問題是：VA 面板在暗階的 GtG 熱點很窄，低解析度表加上插值，會把最難修的那幾格平均掉。這就是「大部分場景正常、特定暗場灰階組合卻爆掉」的來源。折衷做法是基底用 17×17，暗階（例如起始與目標都在低 code 範圍）另加一張 33×33 細表。算一下記憶體：17×17×3 通道×10 anchor＝8,670 bytes，約 8.5KiB；33×33×3×10＝32,670 bytes，約 32KiB。和三通道全表約 1,920KiB 比起來，這個預算現實多了。

### 量測與驗收：不要只跑兩點

VESA 官方 AdaptiveSync 效能準則頁說明，CTS 1.1 的 GtG 測項是把 9×9 矩陣取子集，共 64 組轉態（排除起點與終點相同、以及終點 Code Value 31）；factory-default overdrive 的 64 組平均要求 ≤5ms；overshoot/undershoot 在 v1.1 已從固定 20%/15% 改成 Delta-PQ 表；flicker 門檻 -50dB；AdaptiveSync 等級的更新率範圍要求是最高 ≥144Hz、最低 ≤60Hz（以上已查證：adaptivesync.org 效能準則頁；CTS r1.1 PDF 頁碼待查證。該頁 Table 1 的 GtG 欄寫成「5 × 5 matrix」，與同頁 9×9 敘述不一致，以 CTS PDF 為準，待查證）。

這些測項約束的是 factory-default overdrive 的品質，但不會自動證明使用者在 72、90、165Hz 這些中間點不會看到 corona。中間點要靠廠內 VRR sweep 補齊。VESA ClearMR 是另一個互補指標（待查證：需查 VESA ClearMR 規格文件）：CMR 用「清晰像素與模糊像素的比例」描述動態清晰度，例如 ClearMR 7000 定義為 65–75 倍（6500–7500%）（待查證）；測試時會關閉 backlight strobing，並限制 overshoot/undershoot（待查證）。它不能取代 GtG 與 OD 調校，但可以當成動態清晰度的第三方驗收語言。

| 測項 | 公開要求或定義 | 來源 | 用途 |
|---|---|---|---|
| AdaptiveSync 更新率範圍 | 最高 ≥144Hz、最低 ≤60Hz | adaptivesync.org（CTS 頁碼待查證） | 產品分級 |
| GtG 測項 | 9×9 取 64 組，平均 ≤5ms | adaptivesync.org（CTS 頁碼待查證） | 反應時間 |
| Overshoot/Undershoot | v1.1 改 Delta-PQ 表 | adaptivesync.org（CTS 頁碼待查證） | 過衝控制 |
| Flicker | -50dB | adaptivesync.org（CTS 頁碼待查證） | 亮度穩定 |
| ClearMR 7000 | CMR 65–75 倍 | 待查證 | 動態清晰度 |

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某台 27 吋 QHD、VA 面板、最高 240Hz、VRR 48–240Hz 的機種，在 DVT 階段收到客退。使用者描述：「開 Adaptive Sync 玩 70–90fps 的遊戲，暗場物件邊緣會出現一圈亮白光暈；把更新率固定在 240Hz 反而正常。」另一批使用者則在 48–60fps 區間看到暗色拖影。

RD 一開始懷疑面板，換了兩批 panel 症狀一樣。量測後發現，韌體只有一張 OD LUT，是在 240Hz 調的，VRR 開啟後仍然套同一張表。240Hz 一個更新週期約 4.17ms，60Hz 約 16.67ms；同一份 overdrive 量在 60Hz 會把像素推過目標，而且壓在目標外十幾毫秒。低頻段的亮邊不是面板漏光，是 Overdrive 過衝。

第二個問題在 OSD：只要開 Adaptive Sync，「Overdrive」選項就變灰。產品團隊的理由是「VRR 下無法保證」，但這個決定等於把問題藏起來。使用者不能調，客退還是會發生。

修正分成四步：

1. 在 48、60、72、90、120、144、165、180、200、240Hz 各建一張 anchor LUT。
2. 用 panel 實際影格週期選 anchor，anchor 之間用 Q8 權重插值。
3. 選表用的週期加死區與斜率限制，anchor 與 LUT 切換在 vblank latch。
4. 暗階加 33×33 細表；OSD 的 OD level 改成 base LUT 之後的 gain，不再因為開 VRR 就鎖死。

模擬預測試的結果是：低頻段的 overshoot 回到廠內門檻內，高頻段的反應時間沒有明顯退步，VRR sweep 的中間點也不再出現肉眼可見的 corona。這些是模擬推演的調校方向，不是公開量測資料；實際數值仍要用 panel 與儀器量。

## 新人避坑指南

- **先分清楚三個時間**：host 影格率、link timing、panel 實際 scanout 週期。OD 選表要用第三個。
- **anchor 不要只放頭尾**：最低、最高、常用電影與遊戲影格率都要有；中間點用插值，但要用實機 sweep 驗證。
- **選表週期要有死區與斜率限制**：不然影格率在 anchor 邊界抖動時，OD 會 pumping。限制要做在週期上，不要做在權重上。
- **切表要跟 vblank 對齊**：有 shadow bank 就先把表寫進 shadow，最後單一 commit。
- **17×17 不是萬能**：VA 暗階熱點要用 33×33 或更細的區域表補，不要假設雙線性插值能救回窄熱點。
- **OSD 不要用「變灰」逃避問題**：至少提供 VRR 專用預設，並在說明書寫清楚限制。
- **量測不要只跑兩點**：每個 anchor 與至少兩個中間點都要跑 9×9 GtG、overshoot/undershoot、亮度穩定性。
- **量產表要有 CRC 與 panel ID 綁定**：CRC 失敗退回最近 anchor 的保守表，不要直接套錯表。
- **溫度會影響 VA 暗階**：低溫會讓 VA 暗階 GtG 變慢（待查證：需查 VA 面板 dark-state 溫度響應資料）；若平台有溫度感測，可條件式預留補償欄位，但係數要 panel 廠資料，不能自己編。

## 思考題

一台 VRR 範圍 48–240Hz 的螢幕，遊戲實際跑 40fps。請問 panel 實際看到的影格週期一定是 25ms 嗎？OD 應該用哪個 anchor？

<details>
<summary>看提示</summary>

不一定，而且通常不是。40fps 低於 panel 最低的 48Hz，LFC 會重複影格：若每張重送 2 次，panel 實際跑 80Hz，週期 12.5ms，落在 72Hz 與 90Hz 兩個 anchor 之間，要用這兩張表插值，而不是 48Hz 的表。實際重送倍率視平台實作而定（待查證）。所以不能只用 host FPS 選 LUT，要用 panel 回報的實際影格週期；若平台沒有回報，至少要用 vtotal/htotal 與實際 timing 推算，並在 LFC 邊界實測驗證。
</details>

## 參考資料

1. Blur Busters，「GtG versus MPRT: Frequently Asked Questions About Pixel Response On Displays」，GtG/MPRT 定義、256×256 LUT 約 64KiB、17×17/9×9 截斷表、溫度對 VA GtG 的影響：https://blurbusters.com/gtg-versus-mprt-frequently-asked-questions-about-display-pixel-response/ （非官方技術參考）
2. Blur Busters 論壇，「Complexity Of Overdrive for Variable Refresh Rate (G-SYNC, FreeSync)」，A(B)=C、固定 OD 在不同更新率的 artifact、多張 LUT 插值、多影格歷史、記憶體估算：https://forums.blurbusters.com/viewtopic.php?t=7138 （非官方技術參考）
3. VESA，「AdaptiveSync Display 1.1 Performance Criteria」，9×9 G2G 取 64 組、平均 ≤5ms、Delta-PQ overshoot/undershoot、flicker -50dB、最高 ≥144Hz／最低 ≤60Hz：https://www.adaptivesync.org/performance-criteria/ （官方）
4. VESA，「VESA Brings Clarity to Motion Blur in Digital Displays with New Compliance Test Specification and Logo Program」，ClearMR/CMR 定義、ClearMR 7000 為 65–75 倍、測試時關閉 backlight strobing、限制 overshoot/undershoot：https://vesa.org/featured-articles/vesa-brings-clarity-to-motion-blur-in-digital-displays-with-new-compliance-test-specification-and-logo-program/ （官方）
5. TFTCentral，「Why Moving Picture Response Time (MPRT) Specs Can Be Misleading and Where 1ms MPRT is Sometimes Abused」，60Hz 16.67ms、120Hz 8.33ms、144Hz 6.94ms、240Hz 4.16ms；VRR 下通常無法使用 strobe backlight：https://tftcentral.co.uk/articles/why-moving-picture-response-time-mprt-specs-can-be-misleading-and-where-1ms-mprt-is-sometimes-abused （非官方技術參考）
6. VESA AdaptiveSync Display CTS r1.1 PDF（公開下載入口，完整測試程序與 Delta-PQ 表）：https://vesa.org/wp-content/uploads/2023/05/Adaptive-Sync-Display-CTS-r1.1.pdf （官方；本文未逐頁引用，細節待下載核對）
