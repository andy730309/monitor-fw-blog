---
layout: post
title: "DSC 開下去畫面綠條亂竄？4K144 螢幕 sink 端 DSC 參數宣告與 PPS 驗證的坑"
date: 2026-10-29
tags: [DSC, DisplayPort, DPCD, PPS, slice, bpp, buffer model, 認證]
level: intermediate
prerequisites: ["DPCD 入門：DisplayPort 設定資料結構與 Sink Capability 宣告", "DisplayPort link training 基礎"]
series: "Part 4：DisplayPort（含 DSC、eDP）"
roadmap_stage: practitioner
sources_checked: 2026-10-29
spec_checked: "VESA DSC 1.2b、VESA DP 2.0、DSC Source Device Guidelines r1.0；2026-10-29 逐項核對"
difficulty: intermediate
---
## 【前置知識準備】

先講清楚 DSC 是什麼。DSC（Display Stream Compression，VESA 的顯示串流壓縮標準）是一種「視覺無損（visually lossless）」的壓縮：一般人在一般觀看條件下，看不出壓縮前後的差別。規格把「視覺無損」定義為人眼看不出壓縮重建前後差異（VESA DSC 1.2b PDF p.26）。典型壓縮比在 1：1 到約 3：1 之間（DisplayPort FAQ，規格本身沒有寫這個範圍）。為什麼需要它？因為 4K 144Hz、8K 60Hz 這種模式，未壓縮的資料量超過 DP 1.4 link 的承載能力，不壓縮就只能降刷新率或降色深。

用一個工程類比：DSC 就像貨運打包。Source（顯卡）是打包員，sink（螢幕）是收貨員。兩邊要對三件事有共識：

1. **收貨員的能力清單**（DPCD DSC capability，DPCD 0x060–0x06F，VESA DP 2.0 PDF p.446–453）：我一次能收幾個包裹（slice 數）、每個包裹最大多重（max slice width）、我每秒能拆幾件（peak throughput）。這份清單是收貨員自己寫的，寫太樂觀，打包員就會照單塞貨。
2. **打包規格書**（PPS，Picture Parameter Set，128 bytes）：每個包裹怎麼切、用多少位元率（bpp）、buffer 怎麼管理，全寫在這 128 bytes 裡（VESA DSC 1.2b PDF p.54），source 透過 DP 的 PPS SDP（Secondary Data Packet）送給 sink（VESA DP 2.0 第 2.2.5.8 節 PDF p.208）。
3. 緩衝區模型（HRD buffer model，見 VESA HRD Buffer Model Intro）：encoder 和 decoder 各有一個 rate buffer（像倉庫暫存區），RC（Rate Control）演算法保證倉庫不會爆倉也不會斷貨。兩邊跑設定相同的 RC 演算法，QP（量化參數）決策完全同步，所以 bitstream 裡除了平坦度指示之外不傳 QP（VESA DSC 1.2b PDF p.42–43；HRD 細節見 Annex F）。

關鍵名詞第一次出現都解釋過了，補兩個：slice 是把畫面切成大小相同的矩形區塊、各自獨立編碼的單位，一條水平線上可以有一個或多個 slice（VESA DSC 1.2b PDF p.31）；bpp（bits per pixel）是壓縮後每個像素分配到的位元數，注意它可以是分數：PPS 的 bits_per_pixel 欄位是 10 bits，其中 4 bits 是小數，最小單位 1/16 bpp，規格只允許 6.0 以上，最大值 63.9375（VESA DSC 1.2b PDF p.56）。

## 【系統廠真實血淚案例】

> **情境模擬（依公開規格推演）**：以下為虛構的教學情境，非真實客戶、產品或任何特定廠商的事件；顯卡以 GPU A／B／C 代稱，不代表任何品牌的實際驅動行為。

DVT 階段的 4K 144Hz DP 1.4 monitor，panel TCON 內建 DSC decoder。實驗室交叉測試三張不同 GPU：GPU A、GPU B 開 DSC 一切正常；GPU C 開 DSC 後畫面出現綠色直條雜訊，偶爾整片黑。關 DSC 降 4K 120 又都正常。這種「只有特定顯卡會中」的 bug 最難交代，因為客戶會說「我家螢幕沒問題，是你們螢幕有問題」。

抓 AUX log（用 DP protocol analyzer）比對三張 GPU 的行為，找到兩個疊加的根因：

根因一：DPCD capability 寫得太樂觀。
韌體在 `DP_DSC_SLICE_CAP_1`（DPCD 0x064）把 8、10、12 slice 的 bit 都填了。這些 bit 定義在 VESA DP 2.0 Table 2-183（PDF p.448：bit 5／6／7 分別是 8／10／12 slice；其中 10 slice 不屬於標準 slice 數集合，是額外選項），公開的 Linux kernel `include/drm/display/drm_dp.h` 也有同樣定義。Source 讀到清單就有權照辦：在這個模擬情境裡，GPU C 選了 8 slice（3840 ÷ 8 = 每個 slice 480 pixel 寬），而假設的 decoder IP 在 4K144 的高 pixel clock 下，slice muxing 路徑只撐得住 4 slice。依 DP 2.0 Table 2-155，像素率 680 到 1360 MP/s 的模式，sink 至少要支援 4 slice/line（VESA DP 2.0 PDF p.348），所以只宣告到 4 slice 本來就合規。Source 在 sink 宣告範圍內、不超過最大 slice 寬度與峰值 throughput 時可以自由選 slice 數（同頁），Source 完全合法，是 sink 說謊在先。

根因二：PPS 驗證用整數 bpp 檢查分數 bpp 的世界。
Sink FW 收到 PPS 後會 sanity check chunk_size（每個 slice 切成 chunk 傳輸的大小）。舊程式碼用「slice_width × 整數 bpp ÷ 8 無條件進位」來驗。但 bpp 是帶 4 位小數的定點數（以 1/16 為單位），source 用 8.75 bpp 時，正確的 chunk_size 是（bpp 以實際值計；VESA DSC 1.2b PDF p.57、p.64）：

```
chunk_size = ceil(slice_width × bpp ÷ 8)          // 4:4:4、simple 4:2:2
chunk_size = ceil((slice_width / 2) × bpp ÷ 8)    // native 4:2:2 或 native 4:2:0
```

若 bpp 用 PPS 裡的原始整數（實際值 × 16），第一式等同 `ceil(slice_width × bpp_raw ÷ 128)`。另外注意 native 4:2:2／4:2:0 時，PPS 的 bits_per_pixel 要填目標值的兩倍（VESA DSC 1.2b PDF p.56）。

這條公式出自 DSC 規格的 PPS 定義與 slice multiplexing 章節；Linux kernel `drivers/gpu/drm/display/drm_dsc_helper.c` 的 `drm_dsc_compute_rc_parameters()` 原封不動寫著 `slice_chunk_size = DIV_ROUND_UP(slice_width * bits_per_pixel, 8 * 16)`，其中 `bits_per_pixel` 帶 4 位小數（kernel `drm_dsc.h` 註解：「Target bits per pixel with 4 fractional bits, bits_per_pixel << 4」）。用整數 bpp 驗分數 bpp 的 chunk_size，8.75 bpp 時每個 chunk 會差到幾十個 byte（例如 960 pixel 寬的 slice，正確值 1050，用整數 8 bpp 算出 960），sink 的 slice multiplexer 逐 chunk 收就錯位，畫面就是綠條。

順帶一提一個新手常見的錯誤：`DP_DSC_MAX_SLICE_WIDTH`（0x06C）這個欄位的值要乘上 320 才是真正的最大 slice 寬度，而且規格規定最小值是 8（即 2560 pixel）（VESA DP 2.0 PDF p.451；kernel `drm_dp.h` 的 `DP_DSC_SLICE_WIDTH_MULTIPLIER` 也是 320）。有人看到「2560」想直接把 pixel 數塞進這個 1 byte 欄位，或填了小於 8 的值，source 據此算出的 slice 數就會離譜。

修正後的 sink 端程式碼（DPCD offset 出自公開 kernel 標頭；Scaler 平台 API 為示意）：

```c
/* DPCD offset 定義：VESA DP 2.0 Table 2-183（PDF p.446-453），
 * 公開的 Linux kernel include/drm/display/drm_dp.h 亦同。
 * decoder IP 實際能力以 SoC vendor datasheet 為準。 */
#define DPCD_DSC_SLICE_CAP_1    0x064
#define DPCD_DSC_PEAK_THROUGHPT 0x06B
#define DPCD_DSC_MAX_SLICE_W    0x06C

/* 以下 Macro 為示意，非實際晶片規格 */
#define Scaler_Write_DPCD_Byte(addr, val) Dpcd_Sink_Write_Byte(addr, val) /* 示意地址，非實際晶片規格 */

void Dpcd_Fill_DSC_Capability(void)
{
    /* 只宣告 decoder 真的撐得住的 slice 數：1/2/4。
     * bit 定義（bit0=1、bit1=2、bit3=4）：VESA DP 2.0 PDF p.448。 */
    Scaler_Write_DPCD_Byte(DPCD_DSC_SLICE_CAP_1,
        (1 << 0) | (1 << 1) | (1 << 3));

    /* max slice width：值 × 320 = 實際 pixel 數，最小值 8（VESA DP 2.0 PDF p.451） */
    Scaler_Write_DPCD_Byte(DPCD_DSC_MAX_SLICE_W, 0x08); /* 2560 pixel */

    /* peak throughput mode 0（bits 3:0，4:4:4／simple 4:2:2）：6 = 600 MP/s
     * （VESA DP 2.0 PDF p.451）。這是每個 slice 的解碼能力，不是整台的上限：
     * slice 數 × throughput 要 ≥ 模式的 pixel rate（依 PDF p.348 Table 2-155
     * 的推導，屬本文推論）。bits 7:4 為 mode 1，這裡填 0 表示不支援。 */
    Scaler_Write_DPCD_Byte(DPCD_DSC_PEAK_THROUGHPT, 6);
}

/* PPS 驗證：PPS 為 128 bytes，多 byte 欄位高位在前（VESA DSC 1.2b PDF p.54） */
int Dsc_Validate_PPS(const unsigned char *pps)
{
    unsigned int slice_width = (pps[12] << 8) | pps[13]; /* PPS12/13 */
    unsigned int chunk_size  = (pps[14] << 8) | pps[15]; /* PPS14/15 */
    /* bpp = PPS4[1:0] << 8 | PPS5，10 bits、4 位小數（VESA DSC 1.2b PDF p.56） */
    unsigned int bpp_q4 = ((pps[4] & 0x03) << 8) | pps[5];

    if (slice_width > (0x08u * 320u))
        return -1; /* 超過 sink 宣告上限 */

    /* DSC 1.2b PDF p.57：chunk = ceil(w*bpp/8)；kernel drm_dsc_helper.c 同式。
     * 此處只處理 4:4:4／simple 4:2:2，native 4:2:2/4:2:0 要用 w/2。
     * 舊版用整數 bpp 檢查，8.75bpp 時誤判 → 錯位。 */
    if (chunk_size != (slice_width * bpp_q4 + (8 * 16 - 1)) / (8 * 16))
        return -2;

    /* bpp 低於 visually lossless 建議下限（4:4:4 ≥ 8bpp，VESA Source Device
     * Guidelines r1.0）不擋但記 log，供畫質追蹤 */
    if ((bpp_q4 >> 4) < 8)
        Debug_Log("DSC bpp below VL guideline\n"); /* 示意 API */

    return 0;
}
```

修正後三張 GPU × 三種線長全跑過，綠條消失。（模擬情境中）PPS 檢查也抓到一次 dock 送出的非預期 chunk_size，sink 拒絕後 source 自動降 4K120 無壓縮，畫面正常。這就是好的失敗路徑：拒絕得乾淨，fallback 接得住。

## 【新人避坑指南（Mentor's Take）】

### 1. 看懂這個 Bug 的關鍵暫存器/訊號線是哪一個？

三個地方，全部在 DPCD 與 PPS 上，不用碰任何示波器：

- DPCD `0x064`（SLICE_CAP_1）與 `0x06D`（SLICE_CAP_2）：sink 宣告支援的 slice 數 bitmask（VESA DP 2.0 PDF p.448、p.452）。你填的每一個 bit 都是對 source 的承諾。
- DPCD `0x06B`（PEAK_THROUGHPUT）與 `0x06C`（MAX_SLICE_WIDTH，值 × 320）（VESA DP 2.0 PDF p.451）：source 據此判斷「這台螢幕解得動什麼」。宣告值必須對齊 decoder IP datasheet，不是抄參考設計。
- PPS byte 12–15（slice_width、chunk_size）：sink 收到 PPS 後第一個要驗的欄位，chunk_size 驗證必須用帶 4 位小數的 bpp（VESA DSC 1.2b PDF p.56–57）。

### 2. 未來寫 Code 或驗證時，如何避免重蹈覆轍？

- Capability 宣告是合約，不是願望清單。填之前打開 decoder IP 的 datasheet 逐欄對表，寧可少宣告（source 會 fallback），不要多宣告（source 合法但畫面炸掉）。
- 所有涉及 bpp 的計算先問自己：這是整數還是帶 4 位小數的定點數？PPS 的 bpp 以 1/16 為單位，sink 實際支援的精度則看 DPCD 0x06F 的 bpp increment（VESA DP 2.0 PDF p.452–453），kernel 的 helper 是最好的對照組，寫完拿它交叉檢查。
- 驗證矩陣必須涵蓋多家 GPU 廠商 × 有無 dock × 不同線長。不同 source 對 slice 數的選擇可能不同（規格允許 source 在 sink 宣告範圍內自行選擇，VESA DP 2.0 PDF p.348），只測一家風險很高。
- 失敗路徑要設計：sink 驗證不過就乾淨拒絕，讓 source fallback 到無壓縮模式，不要硬解出綠條再讓客戶幫你測。
- 提醒：DP 2.0 規定有 128b/132b 上游埠的 Sink 必須支援 DSC（VESA DP 2.0 PDF p.446）；DPCD 0x06B 填 15（170 MP/s）的裝置不能取得 DP 認證（同規格 PDF p.451）。至於「DP 2.1b 認證最低門檻含 HBR2 + DSC」出自 displayport.org FAQ，手邊規格無法驗證，以 FAQ 為準。capability 宣告錯誤會直接卡在認證，不是小事。

### 3. 思考題

Sink 的 DPCD `0x062`（RC_BUF_BLK_SIZE）與 `0x063`（RC_BUF_SIZE）宣告了 decoder rate buffer 的大小（欄位定義見 VESA DP 2.0 PDF p.447）。請查 DSC 規格（VESA DSC 1.2b，可從 VESA 官方頁申請免費下載；rate buffer 與 HRD 見 PDF p.42–48 與 Annex F）與 kernel `drm_dsc_helper.c` 的 `drm_dsc_dp_rc_buffer_size()`：

1. 這兩個欄位怎麼換算成實際 buffer bytes？
2. 如果 sink 實際 buffer 比宣告的小，source 端的 HRD 模型會發生什麼事？畫面會出現什麼症狀？
3. 為什麼 bpp 越高，需要的 rate buffer 越大？（提示：看 HRD delay 與 initial_xmit_delay 的關係。）

答案在 DSC 規格的 rate buffer／HRD 章節與 kernel code 裡，自己查過一次，下次遇到 buffer 相關的 DSC bug 就不會慌。

## 參考資料

1. VESA DSC 官方頁（標準特性、版本沿革、規格免費下載申請入口）— 官方：https://vesa.org/vesa-display-compression-codecs/dsc/
2. VESA Display Stream Compression Standard 1.2b（2021-08-12）：PPS 語法 Table 4-1（PDF p.54–60）、slice multiplexing（PDF p.64）、rate control（PDF p.42–48）、名詞定義（PDF p.26）。VESA DisplayPort Standard 2.0（2019-06-26）：DSC DPCD 0x060–0x06F（PDF p.446–453）、最少 slice 數 Table 2-155（PDF p.348）、PPS SDP（PDF p.208）。本文只引用頁碼並改寫，不轉載原文。
3. DisplayPort FAQ — DSC 段（visually lossless 定義、壓縮比 1：1～3：1、DP 2.1b 認證最低 HBR2+DSC）— 官方：https://www.displayport.org/faq/
4. VESA DSC Source Device Guidelines r1.0（bpp 建議下限：4:4:4 為 8、native 4:2:2 為 7、native 4:2:0 為 6，見 PDF p.2；CBR 模式、transport 限制）— 官方：https://vesa.org/wp-content/uploads/2020/08/VESA-DSC-Source-Device-Guidelines-r1.0.pdf
5. VESA HRD Buffer Model Intro — 官方：https://vesa.org/wp-content/uploads/2024/03/HRD-Buffer-Model-Intro121026.pdf
6. Linux kernel `include/drm/display/drm_dp.h`（DPCD DSC offset 0x060–0x06F、0x160 定義，MIT 授權）— 公開原始碼：https://raw.githubusercontent.com/torvalds/linux/master/include/drm/display/drm_dp.h
7. Linux kernel `include/drm/display/drm_dsc.h`（PPS 128 bytes 結構、bpp 4 位小數、RC 常數）— 公開原始碼：https://raw.githubusercontent.com/torvalds/linux/master/include/drm/display/drm_dsc.h
8. Linux kernel `drivers/gpu/drm/display/drm_dsc_helper.c`（chunk_size 公式、RC 參數計算、PPS pack）— 公開原始碼：https://raw.githubusercontent.com/torvalds/linux/master/drivers/gpu/drm/display/drm_dsc_helper.c
