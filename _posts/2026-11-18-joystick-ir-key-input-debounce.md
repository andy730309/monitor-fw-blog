---
layout: post
title: "按一下跳兩格、長按沒反應：新手必懂的按鍵 debounce 與 IR repeat"
date: 2026-11-18
tags: [OSD, debounce, IR, NEC, DDC-CI, MCCS, joystick]
level: intermediate
prerequisites: ["從零成為顯示器架構師：Table-driven OSD 架構", "DDC/CI 與 MCCS 入門"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-18
description: "按一下跳兩格、長按沒反應？說明按鍵 debounce、NEC 紅外線 repeat 碼處理、joystick 方向對應，以及 OSD 值同步。"
difficulty: intermediate
---
> **重點摘要**：機械按鍵按下時金屬彈片會彈跳，沒有 debounce，一次按壓就會變成好幾次。遙控器長按時送的是 repeat 碼，把它當新按鍵，音量會衝到底，整包丟掉長按又沒反應。本文說明不在 ISR 裡數數的 debounce、NEC 三態分流，以及按鍵與 host 改值的同步。

## 前置知識

把 OSD 想成一家便利商店的收銀機。按鍵是客人按的鈴，joystick 是方向搖桿，遙控器是隔壁棟打來的內線電話。收銀機（韌體）的工作是：客人按一次鈴，就該只結一次帳；搖桿往左，畫面上的游標就該往左；內線說「音量調大」，就該調一次，不是調一百次。

問題是，現實的硬體不像童話。機械按鍵的金屬彈片在按下那一瞬間會「抖」——它不是乾乾脆脆從開變成關，而是快速來回接觸十幾次，就像客人緊張時把鈴連按了好幾下。你若傻傻地「鈴響一次就結一帳」，一次按壓就變成好幾次。這個抖動叫 bounce，而把抖動吃掉的手續叫 debounce（去抖動）。

遙控器又是另一回事。它用紅外線（IR，infrared）打訊號，長按時不是一直重複整句話，而是送一個「我還按著」的短訊號，叫 repeat（重複碼）。若把 repeat 當成新的「按一下」，音量就衝到底；若整包丟掉，長按就完全沒反應。

還有一層：螢幕可以直立（pivot）擺。搖桿的「上」在直立時其實是畫面的「左」。方向若寫死，客人就會覺得螢幕壞了。最後，OSD 改了亮度，還得告訴電腦「我改了」，不然用軟體（例如 ddcutil）去讀，會讀到舊值。這四件事，就是這篇要拆的東西。

## 技術核心

### 按鍵 debounce：別在 ISR 裡數數

機械 bounce 在 ms 等級反覆接點。新手最常犯的錯，是在中斷服務常式（ISR，interrupt service routine）裡看到一個下降緣就 `osd_cursor++`。抖動的十幾個邊緣，就變成十幾次游標移動。

Linux kernel 的 gpio-keys「supports debounce」[^1]；更精準的語意是：debounce 是「偵測到邊緣後，線路要維持穩定一段時間才產生事件，事件時間戳記對應 debounce 結束」[^2]。關鍵不是「延遲一下再讀」，而是「連續取樣都一致才算數」。

```c
/* 示意 Macro 與暫存器，非實際晶片規格 */
#define KEY_POLL_MS        2u   /* 示意：輪詢週期，待實測標定 */
#define KEY_DEBOUNCE_TICKS 15u  /* 示意：約 30 ms，實際照按鍵 datasheet 標定 */

enum { KEY_RELEASED = 0, KEY_PRESSED = 1 };

static struct {
    uint8_t stable;   /* 已確認的狀態 */
    uint8_t count;    /* 新準位連續出現的次數 */
} key_ctx;

/* ISR 只收件，不碰 OSD 狀態 */
static void key_isr_edge(void) { key_event_post(KEY_EVT_EDGE); }  /* 示意 API */

/* task loop 每 2 ms 呼叫一次；raw_pressed：1 = 目前讀到按下 */
void key_poll_task(uint8_t raw_pressed)
{
    if (raw_pressed == key_ctx.stable) {
        key_ctx.count = 0;            /* 又回到原狀態：剛才是抖動，重新計數 */
        return;
    }
    if (++key_ctx.count < KEY_DEBOUNCE_TICKS)
        return;                       /* 新準位還沒連續穩定夠久 */
    key_ctx.stable = raw_pressed;     /* 確認換狀態 */
    key_ctx.count = 0;
    if (key_ctx.stable == KEY_PRESSED)
        osd_dispatch_key(KEY_CONFIRM);   /* 示意 API：只在「確認按下」時派送一次 */
}
```

這個計數器的精髓：只數「新準位」連續出現幾次。讀到的值只要跳回原本已確認的狀態，就代表剛才是抖動，計數歸零重來；新準位連續撐滿 15 次（約 30 ms），才承認狀態真的換了。按下確認時派送一次，放開確認時只更新狀態、不派送，所以下一次按壓又能正常觸發。ISR 完全不碰 OSD，只丟一個事件給 task loop，避免抖動的多次中斷直接改游標。

那 15 ticks、2 ms 是怎麼來的？老實說，是示意值。kernel 文件沒給固定 ms，業界常聽到 20–50 ms，但那是慣例說法，不是規格。真正要照按鍵廠商 datasheet 的 bounce time，再用示波器量。沒量就抄，量產時就是客訴。

### NEC 紅外線：leader、bit、repeat 三態分流

NEC 是遙控器最常見的協定之一。依 kernel rc-core 文件：載波 38 kHz，一筆訊息以 9 ms PULSE（載波開）+ 4.5 ms SPACE（載波關）起頭，接著 16 bit——8 bit address（位址）+ 8 bit command（命令）。bit 1 是 560 µs PULSE + 1690 µs SPACE，bit 0 是 560 µs PULSE + 560 µs SPACE。rc-protos 文件補充：NEC 是 LSB first（低位元先送），而且 address 和 command 各送兩次，第二次是反相值，專門拿來驗證。同一份文件也列了 extended NEC（nec-x）：address 是 16 bit、command 8 bit。訊框長度不變，所以原本放 address 反相值的那個 byte 變成 address 的一部分（推論）。遙控器若用 extended NEC，韌體一律檢查 address 反相，就會把每一筆都丟掉。

```c
/* NEC 時序數字取自 Linux kernel rc-core 文件，逐位對照 */
#define NEC_LEADER_PULSE_US   9000u
#define NEC_LEADER_SPACE_US   4500u
#define NEC_BIT_PULSE_US       560u
#define NEC_BIT_1_SPACE_US    1690u
#define NEC_BIT_0_SPACE_US     560u
#define NEC_TOLERANCE_PCT      20u   /* 示意容差，待查證 */

static void nec_on_frame(uint8_t addr, uint8_t cmd, uint8_t addr_inv, uint8_t cmd_inv)
{
    /* rc-protos：標準 NEC 的 address/command 各送兩次，第二次反相做驗證。
       若要支援 extended NEC（16 bit address），只驗 command，address 改為比對整個 16 bit */
    if ((uint8_t)~addr != addr_inv || (uint8_t)~cmd != cmd_inv)
        return;                       /* 驗證失敗，整筆丟掉 */
    osd_dispatch_ir(cmd);             /* 示意 API */
}
```

長按的學問在 repeat。Sanyo 和 NEC 長按時，送的是「較短、沒有 scancode 的訊息」，只表示按著，收到時設 `LIRC_SCANCODE_FLAG_REPEAT`[^3]。還有一個大坑：NEC 沒有 toggle bit（切換位元），所以分不出「一直按著」和「放開再按同一鍵」；RC-5、RC-6 才有 toggle bit，放開再按會反相[^3]。

所以 repeat 要獨立處理：只對連續量（音量、亮度）啟用，而且套用 repeat rate（第一次延遲長一點，之後固定間隔）。電源、輸入源這種 toggle 類的，直接忽略 repeat，不然按一下電源就開關十幾次。repeat rate 的具體數字 kernel 沒給，要查遙控器廠商規格或實測，標待查證。

### joystick 方向跟著螢幕轉

VCP 0xAA Screen Orientation（VESA MCCS 2.2a PDF p.55；ddcutil vcpinfo 亦同）：0x01 = 0 度、0x02 = 90 度、0x03 = 180 度、0x04 = 270 度、0xff = 螢幕無法提供方向。直立時，搖桿的實體「上」對應的是畫面的「左」或「右」。方向表寫死，pivot 機種就上下左右全反。

```c
/* VCP 0xAA 定義：VESA MCCS 2.2a PDF p.55 */
typedef enum {
    ORIENT_0 = 0x01, ORIENT_90 = 0x02,
    ORIENT_180 = 0x03, ORIENT_270 = 0x04
} orient_t;

/* 實體方向 → OSD 方向；示意對照表，實際依機構標示驗證 */
static const osd_dir_t joy_map[4][4] = {
    { OSD_UP, OSD_RIGHT, OSD_DOWN, OSD_LEFT },      /* 0 度 */
    { OSD_RIGHT, OSD_DOWN, OSD_LEFT, OSD_UP },      /* 90 度 */
    { OSD_DOWN, OSD_LEFT, OSD_UP, OSD_RIGHT },      /* 180 度 */
    { OSD_LEFT, OSD_UP, OSD_RIGHT, OSD_DOWN }       /* 270 度 */
};

osd_dir_t joy_translate(orient_t o, joy_dir_t physical)
{
    if (o < ORIENT_0 || o > ORIENT_270)
        return joy_map[0][physical];   /* 0xff 或未定義，退回 0 度 */
    return joy_map[o - ORIENT_0][physical];
}
```

這張表是示意，90/180/270 度的對應要照機構實際標示驗證，別直接抄。

### 按鍵改值要回報，host 改值要同步

最後一層是雙向同步。VCP 0x02 New Control Value（VESA MCCS 2.2a PDF p.77，Mandatory）：0x01 = 沒有新控制值、0x02 = 一個或多個控制值已改變、0xff = 沒有使用者控制。規格要求：凡不是 host 改的 VCP 值，改完就要即時把 0x02 設成 0x02，不管韌體認為這次改動是不是永久保存。光設 0x02 還不夠，host 不知道「哪一個」值變了；MCCS 2.2a 另外要求把有新值的 VCP code 依序放進 VCP 0x52 Active Control FIFO（同為 Mandatory，PDF p.78–79），host 每讀一次 0x52 取出一個 code，FIFO 空了讀到 0x00，0x02 也自動回到 0x01；host 也可以寫 0x01 到 0x02 強制清空 FIFO。VCP 0x03 Soft Controls：0x00 = 沒有按鍵 active，MCCS 2.2a 定義 0x01–0x0F 為可自訂的 soft button（PDF p.77；ddcutil 列的 button 1–7 是舊版定義）。

按鍵改了亮度卻沒回報 0x02，host 端就不知道值變了；host 用 DDC/CI 改值，OSD 也要監聽並更新條圖。兩邊不講好，就是典型的 race condition。

```c
/* VCP code 定義：VESA MCCS 2.2a（02h/52h p.77–79，B0h p.32）；API 為示意 */
#define VCP_NEW_CONTROL_VALUE 0x02u  /* 0x01 無新值；0x02 有值改變；0xff 無使用者控制 */
#define VCP_ACTIVE_CONTROL    0x52u  /* FIFO：依序放入有新值的 VCP code，空時讀到 0x00 */
#define VCP_SETTINGS          0xB0u  /* 0x01 store；0x02 restore factory defaults */

static void osd_on_value_changed(uint8_t vcp_code, uint16_t value)
{
    mccs_set_vcp(vcp_code, value);          /* 示意 API：更新 VCP shadow */
    mccs_active_fifo_push(vcp_code);        /* 示意 API：放進 VCP 0x52 FIFO，host 才知道是哪個值 */
    mccs_set_vcp(VCP_NEW_CONTROL_VALUE, 0x02);  /* 告訴 host 有值改變；FIFO 讀空時韌體改回 0x01 */
    settings_mark_dirty();                  /* 示意 API：dirty flag，延遲寫 flash */
}
```

設定保存用 dirty flag + 延遲寫入降低 flash 磨耗，再加 CRC 與版本號。factory reset 要把所有隱藏設定清乾淨，這點常被漏掉。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某機種 EVT，測試報告四個症狀：確認鍵一次跳兩格、長按音量鍵狂跳、直立展示機方向全反、host 改亮度 OSD 不同步。看起來四個不相干的 bug，追下去共用一根——輸入事件沒有統一的「收件 → 判定 → 派送 → 回報」管線，ISR 直接改 OSD 狀態。

量測現象：邏輯分析儀抓按鍵 GPIO，一次按壓在 20 ms 內出現十幾個邊緣；IR 端用 ir-ctl 看 raw timing，長按時收到的是短 repeat frame 不是完整 frame；DDC/CI 端 getvcp 0x10 讀到的值和 OSD 條圖差一截。

協定層分析：bounce 是機械特性，得靠 debounce 吃掉；repeat 是 NEC 的設計，不是 bug，要分流；方向是 orientation 沒跟；不同步是 VCP 0x02 沒回報。四個各自修，不如把輸入管線重構一次——從此 ISR 只收件，判定、派送、回報各有單一出口。量產站也加一項：連續按 20 次確認鍵，游標要剛好走 20 格，擋住回歸。

## 新人避坑指南

- 別在 ISR 裡數 bounce。ISR 只記邊緣、丟事件，判定放 task loop。
- debounce 時間別抄 20–50 ms。那是慣例不是規格，照按鍵 datasheet 和示波器量測標定。
- NEC 的 address/command 反相驗證要做，驗證失敗整筆丟，別讓雜訊進 OSD。
- repeat 和完整 frame 分開走。repeat 只給連續量用，toggle 類忽略。
- 記住 NEC 沒有 toggle bit，分不出「按住」和「連按」。要區分就換協定或上層加語意。
- joystick 方向表要跟 VCP 0xAA orientation 轉，直立機種實機驗證四個方向。
- 按鍵改值要把 VCP code 放進 0x52 FIFO，並把 VCP 0x02 設成 0x02；host 改值 OSD 要同步，兩邊別各說各話。
- 設定保存用 dirty flag + 延遲寫入，CRC + 版本號，factory reset 清到隱藏設定。
- 看到韌體裡寫死的暫存器地址或 Macro，先問：這是公開規格定義的，還是示意？本文章的 osd_dispatch_key、mccs_set_vcp 都是示意 API，不是真實 scaler 規格。

## 思考題

假設客戶抱怨「長按電源鍵，螢幕開關狂跳」。你懷疑是 IR repeat 被當成新 key-down。動手前，先查一個問題：NEC 協定本身要怎麼樣才能區分「按住」和「放開再按」？如果分不出來，韌體該用什麼語意規則決定哪些功能要忽略 repeat？（提示：查 kernel 的 lirc-dev-intro 文件裡 toggle bit 那一段，再想想電源和音量這兩種控制的差異。）

## 參考資料

- VESA Monitor Control Command Set (MCCS) Standard Version 2.2a（官方規格；B0h p.32、AAh p.55、02h/03h p.77、52h p.78–79）
- ddcutil vcpinfo output（非官方，開源工具 ddcutil 文件站；VCP 0x02/0x03/0xAA/0xB0 定義交叉參考）：https://www.ddcutil.com/vcpinfo_output/
- Linux kernel — Remote Controller core（官方；NEC 載波 38 kHz、9 ms + 4.5 ms leader、560/1690/560 µs bit）：https://docs.kernel.org/driver-api/media/rc-core.html
- Linux kernel — Remote Controller Protocols and Scancodes（官方；NEC LSB first、address/command 反相驗證）：https://docs.kernel.org/userspace-api/media/rc/rc-protos.html
- Linux kernel — LIRC device interface（官方；NEC/Sanyo repeat 短訊息、LIRC_SCANCODE_FLAG_REPEAT、NEC 無 toggle bit）：https://docs.kernel.org/userspace-api/media/rc/lirc-dev-intro.html
- Linux kernel — Subsystem drivers using GPIO（官方；gpio-keys 支援 debounce、gpio-keys-polled）：https://docs.kernel.org/driver-api/gpio/drivers-on-gpio.html
- Linux kernel — GPIO_V2_GET_LINE_IOCTL（官方；debounce_period_us、debounce 軟體模擬、事件 timestamp 對應 debounce 結束）：https://docs.kernel.org/userspace-api/gpio/gpio-v2-get-line-ioctl.html

本文 VCP 定義已對照 VESA MCCS 2.2a 規格頁碼，ddcutil 文件只作交叉參考。scaler 的按鍵/IR 周邊暫存器屬 NDA 範圍，本文一律標示意，不宣稱是真實 RTD/Novatek/MStar 暫存器。

[^1]: Linux kernel — Subsystem drivers using GPIO（gpio-keys，官方，見參考資料）。網頁文件，章節待查證。
[^2]: Linux kernel — GPIO_V2_GET_LINE_IOCTL（官方，見參考資料）。網頁文件，章節待查證。
[^3]: Linux kernel — LIRC device interface（lirc-dev-intro，官方，見參考資料）。網頁文件，章節待查證。
