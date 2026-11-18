---
layout: post
title: "校正完隔天色彩又跑掉？ICC profile 與硬體校正的狀態一致性三個坑"
date: 2026-11-04
tags: [ICC profile, vcgt, hardware calibration, DDC/CI, MCCS, color management]
level: intermediate
prerequisites: ["posts/2026-10-28-ddc-ci-mccs-ddcutil-intro.md", "posts/2026-10-30-3d-lut-vs-3x3-matrix.md", "posts/2026-10-30-factory-color-calibration-takt-time.md"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-04
difficulty: intermediate
---
## 前置知識

先講一個類比：ICC profile 像是這台螢幕的「體檢報告」，hardware calibration 像是「矯治處方」。體檢報告描述的是矯治「當下」那個身體狀態；如果矯治處方後來改了（或被停掉），舊報告就不再代表現在的這個人。色彩管理系統（CMS，Color Management System）拿著過期報告做色彩轉換，結果就是系統性偏色，而且你看 log 都不會有錯。

幾個名詞先對齊：

- **ICC profile**：依 ICC.1:2022（profile version 4.4.0.0）定義的檔案格式，OS 端色彩管理用它描述裝置的色彩行為。
- **Calibration（校正）**：改變裝置的行為，例如調 OSD 設定、對 color channels 套 per-channel curves（ArgyllCMS 文件定義）。
- **Characterization / Profiling（特性化）**：記錄裝置的行為成 ICC profile，profile 本身不改變任何色彩（ArgyllCMS 文件定義）。
- **vcgt tag**：display profile 裡存放 calibration curves 的 tag。ArgyllCMS 文件說明這是慣例（by convention）存放位置，一般的 ICC 工具不會動它，由 OS 或系統色彩工具在套用 profile 時把 curves 載入顯示硬體（VideoLUT）。
- **VideoLUT**：顯示卡上的硬體查表，OS loader 開機時把 vcgt 曲線寫進去。

螢幕韌體工程師的視角是：校正資料有兩條路可以生效——寫進螢幕內部 LUT（硬體校正，走 DDC/CI），或寫進顯示卡 VideoLUT（軟體校正，走 vcgt）。兩條路同時開，就是校正兩次。這一篇講的就是這兩條路怎麼打架，以及韌體端該暴露什麼介面讓工具選對路。

## 技術核心

### ICC profile 檔案結構：128-byte header 加 tag table

一個 ICC profile 是單一檔案，全部 big-endian，依序三段（ICC.1:2022 §7）：

1. **128-byte profile header**（§7.2）：byte 0–3 是 profile size；byte 12–15 是 profile/device class（顯示器裝置是 'mntr'）；byte 16–19 是 data color space；byte 20–23 是 PCS（Profile Connection Space）；byte 36–39 固定放檔案簽名 'acsp'（61637370h）；byte 64–67 是 rendering intent；byte 68–79 是 PCS illuminant XYZ（對應 D50）。
2. **profile tag table**（§7.3）：從 byte 128 開始，先是 4-byte tag count，之後每個 tag 一筆 12-byte entry（tag signature、offset、size）。tag signature 不可重複，但多個 tag signature 可以指向同一份 tag data。
3. **tagged element data**（§7.4）：實際的 tag 資料。tag data 4-byte 對齊，pad 位元組必須是 NULL（§7.1.2）。

對韌體工程師的實用意義：工具端解析 profile 不需要完整的 CMM，只要會讀 header 的 'acsp' 簽名與 tag table，就能把自訂的校正狀態資訊塞進 profile、再讀回來比對。

### 根因一：profile 只對「同一個顯示狀態」有效

ArgyllCMS 的 Calibration vs. Characterization 文件講得最直白：characterization（profile）只有在裝置處於「與 profile 當下相同的 calibration 狀態」時才有效。螢幕有多個 picture mode，各自掛不同的內部 LUT 與 gamma 目標；使用者切了 mode，顯示行為變了，OS 端還拿著舊 profile 套色彩轉換，偏色就來了。

韌體端要做的，是讓「螢幕現在是哪個狀態」可以被外部查到。MCCS 有現成的 VCP code（定義經 ddcutil 官方文件交叉確認）：

- `0x14` Select color preset：0x01 sRGB、0x02 Display Native、0x03 4000 K、0x04 5000 K、0x05 6500 K、0x06 7500 K、0x07 8200 K、0x08 9300 K、0x09 10000 K、0x0a 11500 K、0x0b User 1、0x0c User 2、0x0d User 3。
- `0xDC` Display Mode。
- `0x16`/`0x18`/`0x1A` Video gain R/G/B、`0x6C`/`0x6E`/`0x70` Video black level R/G/B。
- `0x10` Brightness：亮度會影響量測基準，也要納入狀態比對。
- `0x02` New control value：0x01 無新值、0x02「一個以上的使用者控制值已被改變並儲存」——使用者繞過工具直接動 OSD 時，常駐工具靠這個知道要重新驗證。

### 根因二：vcgt 造成的雙重校正

ArgyllCMS 的 Usage Scenarios 文件寫明：如果 profiling 時用了 calibration 檔，它會被轉成 profile 裡的 vcgt tag，「讓 OS 或其他系統色彩工具在使用這個 profile 時把 lookup curves 載入顯示硬體」。

問題來了：這台螢幕的校正已經寫進 scaler 內部 LUT（硬體校正），OS loader 開機又把 vcgt 曲線載進顯示卡 VideoLUT，兩層曲線疊加，等於校正兩次。校正工具自己產生的 profile 帶 vcgt、OS 預設會載，這條路徑沒人擋，隔天開機「色彩又偏掉」就是這麼來的。

分工原則很簡單：

- **硬體校正機種**：校正寫進螢幕內部 LUT，profile 不帶 vcgt（或工具明確關閉 OS loader 的 vcgt 載入）。
- **軟體校正機種**：校正靠顯示卡 VideoLUT，profile 帶 vcgt，並確認 OS loader 開機會載。

### 根因三：per-unit 校正配通用 profile

工廠校正把 per-unit 補償寫進每台螢幕的內部 LUT，出貨卻只附一份「典型機」的通用 profile。通用 profile 描述的是量測機的行為，不是使用者手上那一台的行為；per-unit 校正的意義在 OS 端被一份錯的 profile 吃掉，兩台擺在一起就是不一致。

兩條出路：

1. 校正站 per-unit 產生 profile 並綁序號（產線成本增加，要評估 takt time）。
2. profile 只描述「校正後的目標狀態」，由韌體保證每台都收斂到同一個目標——這正是硬體校正存在的價值，也是多數量產機種該走的路。

### 韌體修正原始碼

說明：VCP code 0x02/0x10/0x14/0x16/0x18/0x1A/0x6C/0x6E/0x70/0xDC 的定義出自 MCCS 公開規格，經 ddcutil 官方文件交叉確認，屬已查證部分；DDC/CI 傳輸層（EDID 位址 0x50、DDC/CI 位址 0x37）同為公開定義。Scaler 內部 LUT 的暫存器地址、slot 管理與 commit 機制為示意，非任何實際晶片規格。

```c
/* ICC profile ↔ 螢幕狀態一致性：韌體端狀態暴露與校正 slot 管理（示意骨架）
 * 已查證：VCP code 定義（MCCS，經 ddcutil 文件確認）；
 *         DDC/CI 位址 0x37、EDID 位址 0x50（公開規格）。
 * 示意：scaler 暫存器地址、LUT slot 硬體介面、commit 暫存器。
 */

/* 示意地址，非實際晶片規格 */
#define REG_LUT3D_SLOT_CTRL     0x4A00  /* 3D LUT slot 選擇 */
#define REG_LUT3D_CRC_STATUS    0x4A04  /* 載入後 CRC 驗證結果 */
#define REG_LUT3D_COMMIT        0x4A08  /* double-buffer commit */

/* MCCS VCP code（已查證：ddcutil 官方文件 / MCCS 公開規格） */
#define VCP_NEW_CTRL_VALUE      0x02    /* 0x02 = 使用者控制值已儲存 */
#define VCP_BRIGHTNESS          0x10
#define VCP_COLOR_PRESET        0x14    /* 0x01 sRGB, 0x0b User 1, ... */
#define VCP_GAIN_R              0x16
#define VCP_GAIN_G              0x18
#define VCP_GAIN_B              0x1A
#define VCP_DISPLAY_MODE        0xDC    /* Display Mode */

typedef struct {
    uint8_t  preset;        /* VCP 0x14 目前值 */
    uint8_t  disp_mode;     /* VCP 0xDC 目前值 */
    uint16_t gain_rgb[3];   /* VCP 0x16/18/1A */
    uint16_t brightness;    /* VCP 0x10 */
    uint32_t lut_crc;       /* 作用中 slot 的 LUT CRC */
    uint8_t  lut_slot;      /* 作用中校正 slot */
} disp_cal_state_t;

static disp_cal_state_t g_cal_state;

/* 1) 校正 slot 載入：CRC 過了才 commit，失敗退回 slot 0（出廠狀態） */
int cal_slot_load(uint8_t slot, const uint8_t *lut_bin, size_t len, uint32_t crc_expect)
{
    /* 示意：實際 LUT 上傳介面依 scaler SDK */
    scaler_lut3d_write(/* 示意地址，非實際晶片規格 */ REG_LUT3D_SLOT_CTRL, slot, lut_bin, len);

    if (!scaler_lut3d_crc_check(/* 示意地址，非實際晶片規格 */ REG_LUT3D_CRC_STATUS, crc_expect))
        return -1;                       /* 呼叫端退回 slot 0 並回報工具重校 */

    scaler_reg_write(/* 示意地址，非實際晶片規格 */ REG_LUT3D_COMMIT, 1);  /* 同 vblank 生效 */
    g_cal_state.lut_slot = slot;
    g_cal_state.lut_crc  = crc_expect;
    return 0;
}

/* 2) 狀態雜湊：工具用這組值判斷「螢幕現在的狀態」是否還跟 profile 一致 */
uint32_t cal_state_hash(void)
{
    /* 把會影響色彩行為的狀態全部納入：preset、display mode、gain、亮度、LUT CRC */
    return crc32_mix(g_cal_state.preset, g_cal_state.disp_mode,
                     g_cal_state.gain_rgb, g_cal_state.brightness,
                     g_cal_state.lut_crc);
}

/* 3) DDC/CI VCP 讀取回應：0x14/0xDC/0x02 直接反映 g_cal_state
 *    （DDC/CI 傳輸層已查證：MCCS 公開定義；暫存器讀取為示意） */
uint16_t ddc_vcp_read(uint8_t vcp_code)
{
    switch (vcp_code) {
    case VCP_COLOR_PRESET:   return g_cal_state.preset;
    case VCP_DISPLAY_MODE:   return g_cal_state.disp_mode;
    case VCP_NEW_CTRL_VALUE: return g_cal_state.user_touched ? 0x02 : 0x01;
    default:                 return scaler_vcp_get(vcp_code);
    }
}
```

工具端（Python）用 ddcutil 讀回狀態、解析 profile 的 tag table 比對：

```python
#!/usr/bin/env python3
"""工具端：ICC profile 與螢幕狀態一致性檢查（示意骨架）
已查證：ddcutil 指令行為與 VCP code 名稱（ddcutil 官方文件）；
        ICC profile 結構（ICC.1:2022 §7：128-byte header + tag table + tag data）。
示意：'meta' tag 內自訂欄位的命名與解析（tag registry 細節待查證）。
"""
import subprocess, struct, sys

VCP_PRESET, VCP_DMODE = "0x14", "0xDC"

def ddc_getvcp(bus: str, code: str) -> str:
    """ddcutil getvcp：輸出格式依 ddcutil 版本，實務上要 parse 'sl=' 值"""
    out = subprocess.run(["ddcutil", "--bus", bus, "getvcp", code],
                         capture_output=True, text=True, timeout=10).stdout
    for line in out.splitlines():
        if "sl=" in line:
            return line.split("sl=")[1].strip(")")
    return ""

def profile_state_id(path: str) -> str:
    """從 ICC profile 讀校正狀態 ID。
    ICC.1:2022 §7：byte 128 起 4-byte tag count，每 tag 12-byte（sig/offset/size）。
    這裡以自訂 private tag 存狀態 ID（private tag 註冊細節待查證）。"""
    with open(path, "rb") as f:
        data = f.read()
    if data[36:40] != b"acsp":                       # 'acsp' @ byte 36（已查證）
        raise ValueError("not an ICC profile")
    n = struct.unpack(">I", data[128:132])[0]        # tag count @ byte 128（已查證）
    for i in range(n):
        off = 132 + i * 12
        sig, toff, tlen = struct.unpack(">4sII", data[off:off + 12])
        if sig == b"cal":                            # 示意 private tag
            return data[toff:toff + tlen].decode().strip()
    return ""

def main(bus: str, profile: str) -> int:
    preset = ddc_getvcp(bus, VCP_PRESET)
    dmode  = ddc_getvcp(bus, VCP_DMODE)
    want   = profile_state_id(profile)
    now    = f"{preset}/{dmode}"
    if want and want != now:
        print(f"[MISMATCH] profile 綁 {want}，螢幕現在 {now} → 拒絕套用，提示重校或切模式")
        return 1
    print(f"[OK] profile 與螢幕狀態一致（{now}）；硬體校正機種：不載 vcgt，避免雙重校正")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 ODM 的高階 4K 機種，scaler 內建 3D LUT，品牌客戶要求出貨附「硬體校正」：校正工具透過 DDC/CI 把 per-unit 校正資料寫進螢幕內部 LUT，並產生 ICC profile 給 OS。DVT 驗收時色彩工程師量 ΔE 全綠，量產三個月後客訴（Claim）進來，三個症狀：

1. 使用者從校正過的 picture mode 切到 sRGB 模式再切回來，色彩整個跑掉，OS 端 ICC profile 沒跟著換。
2. 校正完隔天開機，色彩又偏掉；重跑校正工具才恢復。
3. 同一機種、同一份出貨 profile，兩台螢幕擺在一起色彩明顯不一致，被客戶判定為「校正無效」，要求說明。

量測現象與協定層分析：

- 症狀 1：用 ddcutil 讀 VCP 0x14，發現使用者切模式後 preset 值變了，但 OS 端掛的還是校正當下產生的那份 profile。對照 ArgyllCMS 文件的定義——profile 只在「相同 calibration 狀態」下有效——這是狀態不一致，不是校正資料壞掉。
- 症狀 2：重開機後色彩偏移的方向恰好是「校正量被再套用一次」的方向。檢查校正工具產生的 profile，裡面帶著 vcgt tag；OS loader 開機把 vcgt 曲線載進顯示卡 VideoLUT，疊加在螢幕內部 LUT 之上，雙重校正。
- 症狀 3：兩台螢幕各自的內部 LUT 內容不同（per-unit 校正），但出貨 profile 是同一份通用檔。OS 端色彩管理用同一份「典型機行為」去轉換兩台「不同實際行為」的螢幕，殘差方向相反，擺在一起就看得出來。

三個症狀共用一個根：沒有人把「profile ↔ 螢幕狀態」綁在一起。韌體沒暴露狀態、工具沒寫入狀態、OS 端沒有比對機制。

## 新人避坑指南

看懂這幾個東西，就不會踩同樣的坑：

1. **profile header 的 'acsp' 簽名（byte 36–39）與 tag table（byte 128 起）**：工具端解析 profile 的最小必要知識。要塞自訂資訊，走 tag table 加 private tag，不要動 header 的標準欄位。
2. **vcgt tag 的雙面性**：它是軟體校正的載體，也是硬體校正機種的炸彈。出貨前先問一個問題：這台機器的校正資料在哪裡生效？答案只有一個，vcgt 的去留跟著答案走。
3. **VCP 0x14 / 0xDC / 0x02 是你的狀態窗口**：韌體把 picture mode、display mode、使用者動過設定的旗標老實暴露在 MCCS 上，工具才有辦法判斷「螢幕現在的狀態」跟 profile 一不一致。別把這些值寫死或回假值，夜間自動化測試會抓到你。
4. **寫 Code 時的防呆**：
   - 校正 slot 載入後必做 CRC 驗證，失敗退回出廠 slot，並讓 DDC/CI 讀得到異常狀態，工具才能偵測「校正掉了」。
   - 使用者在 OSD 動過色彩設定，把 VCP 0x02 設為 0x02（已儲存），讓常駐工具知道要重新驗證。
   - 量產出貨：per-unit 校正就配 per-unit profile（綁序號），或明確走「profile 描述目標狀態＋韌體保證收斂」路線；不要 per-unit 校正配通用 profile。
5. **驗證方法**：切換每個 picture mode 前後，用 ddcutil 讀 0x14/0xDC/0x16/0x18/0x1A/0x10，確認狀態值會跟著變；再確認 OS 端 profile 的狀態 ID 比對機制會擋住不一致的組合。

## 思考題

ICC.1:2022 規定 tag table 的 tag signature 不可重複，但多個 tag signature 可以指向同一份 tag data。請查 ICC.1:2022 §7.3（或你手上的版本），回答：如果校正工具想在同一份 profile 裡同時放標準的 'meta' tag 與自訂的校正狀態 tag，兩者共用一段資料，tag table 該怎麼寫？offset 與 size 各指向哪裡？

## 參考資料

- Specification ICC.1:2022（Profile version 4.4.0.0），International Color Consortium（官方）：https://archive.color.org/specification/ICC.1-2022-05.pdf
- ddcutil Documentation — vcpinfo 輸出範例（VCP code 定義，官方工具文件）：https://www.ddcutil.com/vcpinfo_output/
- ArgyllCMS — Calibration vs. Characterization（Graeme Gill，官方文件）：https://www.argyllcms.com/doc/calvschar.html
- ArgyllCMS — Argyll Usage Scenarios（vcgt tag 轉換說明，官方文件）：https://www.argyllcms.com/doc/Scenarios.html
- ICC — ICC Display Profiles with Control over the VCGT（ICC medical working group 白皮書，官方）：https://archive.color.org/groups/medical/displays/controllingVCGT.pdf

提醒：ICC 規格全文與各 OS 色彩管理（Windows WCS、macOS ColorSync）的內部行為，部分需會員或屬廠商文件；本文只依上述公開資訊撰寫，實作前請對照你手上的正式文件。'meta'/'vcgt' tag 在 ICC Tag Registry 的註冊細節、OS loader 對 vcgt 的載入時機，本次未能查到官方條目，標「待查證」。
