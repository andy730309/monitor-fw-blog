---
layout: post
title: "色溫算出 4664 K、兩站 ΔE 對不上？CA-410 遠端控制與量測換算的四個坑"
date: 2026-11-12
tags: [CA-410, SCPI, CCT, DeltaE, 色度, 自動化測試, 產線校正, DDC/CI]
level: intermediate
prerequisites: ["posts/2026-10-28-ddc-ci-mccs-ddcutil-intro.md", "posts/2026-11-01-ca410-argyllcms-measurement-automation.md", "posts/2026-10-31-deltae2000-vs-deltaitp.md"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: practitioner
sources_checked: 2026-11-12
description: "CA-410 色溫算出 4664 K、兩站 ΔE 對不上？拆解遠端控制、CCT 公式、ΔE 常數與輪詢節奏四個腳本問題。"
seo_title: "CA-410 色溫與 ΔE 對不上？量測換算四個坑"
difficulty: intermediate
---
> **重點摘要**：量測站的 timeout、色溫算錯、兩站 ΔE 不一致與低灰階亂跳，全是腳本自己的問題。四個根因是：把 CA-410 當 SCPI 儀器、CCT 公式符號寫錯、兩站各抄一份常數，以及輪詢節奏沒有依量測速度分檔。

量測自動化站上線一週，腳本開機就 timeout、色溫算出 4664 K、兩個站別對同一台機器給出不同的 ΔE00、低灰階量測值亂跳。四個症狀看起來像儀器壞了，實際上全是腳本自己的問題：把 CA-410 當 SCPI 儀器、CCT 公式符號寫錯、兩個站各抄一份常數、輪詢節奏沒跟著儀器速度分檔。這篇把這四個坑一次講完。

## 前置知識

先把三個名詞講清楚。

**xyY**：CIE 色度座標。x、y 描述顏色「長什麼樣」（色度），Y 描述有多亮（亮度，單位 cd/m²）。彩度計（colorimeter）量白平衡，回傳的就是 xyY 三個數。CA-410 的色度顯示是 4 位數（Konica Minolta 官方新聞稿，2017-11-09），但顯示位數不等於準確度：同一份新聞稿列的白色色度精度是 ±0.002／±0.003，小數第三位就已經落在誤差範圍內。紀錄時保留 4 位數方便追蹤與比對，判定時要把精度一起算進去。

**CCT（correlated color temperature，相關色溫）**：把一個顏色對應到 Planckian locus（黑體輻射軌跡）上最接近的那個溫度，單位 K。關鍵在「correlated」這個字：只有靠近 Planckian locus 的顏色（也就是白點）算 CCT 才有意義。拿 R、G、B 飽和 primary 的 xy 去算 CCT，得到的數字沒有物理意義，就像問「紅色的溫度是幾 K」。

**ΔE00（CIEDE2000）**：兩個顏色的色差指標。業界常用門檻是 ΔE00 ≤ 1 約等於「肉眼難以分辨」（此為慣例說法，出處待查證），但產線 gate 的下限不是你想要多嚴，而是儀器量得出多準，這是本篇第三個坑的核心。

再來是通訊層。**SCPI**（Standard Commands for Programmable Instruments）是建立在 IEEE 488.2 之上的儀器命令標準，很多電源、電表、示波器講 SCPI；但不是每台儀器都講，連 Chroma 2238 訊號產生器的公開手冊也是自家 ASCII 命令（例如 `RUN PTN 0105 ;`，回 `OK;`／`NG;`，2238 User's Manual §3.2，PDF p.65–66）。**CA-410 也不是 SCPI 儀器**，它講 Konica Minolta 自家的指令集，而且基本命令刻意與前代 CA-210/310 相同（KM CA-410 catalog PDF p.2），讓舊產線程式可以直接沿用。DUT 端的控制則走 DDC/CI（顯示器上的 I²C，位址 0x37，可用 ddcutil 操作），負責切 pattern 來源、鎖動態模式、寫入校正值。

一個好懂的類比：量測站像廚房，CA-410 是那把「只講方言的電子秤」。你拿米制食譜（SCPI）去問它，它不是答錯，是根本不回話。

## 技術核心

### 根因一：把 CA-410 當 SCPI 儀器

最常見的死法：工程師之前寫過 SCPI 儀器的遠端控制，把「送 `*IDN?`、等 query 回應」的框架直接套到 CA-410。CA-410 不認得這套語言，serial timeout 一路炸，然後大家開始懷疑儀器壞了、線材接觸不良、USB 轉接板有鬼。

正確的分層觀念：訊號產生器走 SCPI/IEEE 488.2 框架，CA-410 走 KM 自有協定，兩者的驅動層不能共用同一個「query-response」抽象。CA-410 的完整命令字串定義在 KM 的「Display Color Analyzer CA-410 Communication Specifications Ver 1.13」，這份文件要在 KM 官網同意使用條款後才能下載，條款限制只能用於開發搭配 CA-410 的應用軟體，商用需 KM 另外授權。從 PC 以 RS-232C 控制 probe 時，使用隨附的 SDK（CA-SDK2）[^1]。自己寫驅動前，先評估 SDK 能不能滿足需求。本篇程式碼的命令字串一律以佔位常數表示並標「待查證」，你實作時請以手上那份通訊規格為準（並對照你的 NDA 授權範圍）。

驅動層的骨架長這樣（Python）：

```python
# ca410_driver.py — CA-410 驅動層（架構示意；命令字串待查證）
# 已查證：量測速度/精度/介面（KM news release 2017-11-09）。
# 待查證：CMD_* 與回應格式出自 CA-410 Communication Specifications Ver 1.13（需同意條款下載）。

import time
import serial

BAUD = 38_400  # 已查證：KM instruction manual PDF p.19（probe 的 RS-232C 鮑率為 38,400 bps；CA-DP40 可另行設定，見 PDF p.111）

# 量測速度三檔（已查證：KM news release 2017-11-09，Lvxy AUTO）
#   >0.001 cd/m² → 1 次/秒；>0.15 cd/m² → 5 次/秒；>2 cd/m² → 20 次/秒
SPEED_S = {"low": 1.0, "mid": 0.2, "high": 0.05}

# 以下命令常數為佔位：實際語法見 KM CA-410 Communication Specifications（待查證）
CMD_MEASURE = b"__MEASURE__"      # 待查證：觸發量測
CMD_READ    = b"__READ__"         # 待查證：讀取 Lvxy
RSP_DONE    = b"__DONE__"         # 待查證：完成碼
RSP_ERROR   = b"__ERROR__"        # 待查證：錯誤碼

def band_of(lv_target: float) -> str:
    """依目標亮度分檔（門檻即官方速度表的 0.001/0.15/2 cd/m²）。"""
    if lv_target >= 2.0:
        return "high"
    if lv_target >= 0.15:
        return "mid"
    return "low"

class CA410:
    def __init__(self, port: str):
        # USB 走 virtual COM port（KM catalog）；RS-232C 預設 38,400 bps
        self.ser = serial.Serial(port, BAUD, timeout=0.2)

    def _read_until(self, tokens, timeout_s: float):
        """讀到任一 token 或逾時；逾時交由上層有上限的重試，不在驅動內無限重試。"""
        deadline = time.monotonic() + timeout_s
        buf = b""
        while time.monotonic() < deadline:
            chunk = self.ser.read(256)
            if chunk:
                buf += chunk
                for t in tokens:
                    if t in buf:
                        return buf, t
        return buf, None

    def measure_lvxy(self, lv_target: float, retries: int = 2):
        """觸發量測 → 等完成碼 → 讀 Lvxy。節奏依亮度分檔，不用固定 sleep。"""
        band = band_of(lv_target)
        wait = SPEED_S[band] * 3.0   # 安全係數 ×3 為個人經驗推論起點，依實測調校
        for attempt in range(retries + 1):
            self.ser.reset_input_buffer()   # 重試前清掉上一輪殘留的位元組，避免把舊的完成碼或舊讀值當成這一輪
            self.ser.write(CMD_MEASURE)
            buf, token = self._read_until((RSP_DONE, RSP_ERROR), wait)
            if token == RSP_DONE:
                self.ser.write(CMD_READ)
                buf2, tok2 = self._read_until((b"\n",), wait)
                if tok2:
                    return parse_lvxy(buf2)   # 解析格式依通訊規格文件（待查證）
            if token == RSP_ERROR:
                raise RuntimeError(f"CA-410 error: {buf!r}")
        raise TimeoutError(f"CA-410 no completion in {wait}s after {retries + 1} tries")
```

兩個設計重點：一是「觸發量測」和「讀值」是兩個動作，中間用完成碼握手，不是送一條查詢等回應；二是等待時間依目標亮度分檔，低灰階至少等 1 秒以上（官方速度表：>0.001 cd/m² 是 1 次/秒），安全係數起點抓 ×3，之後依實測調校。

### 根因二：CCT 公式分母符號寫反，還把 CCT 用在飽和色上

產線腳本最常用的 CCT 近似是 McCamy 公式（C. S. McCamy, Color Research & Application 17(2):142–144, 1992）：

```
n   = (x − 0.3320) / (0.1858 − y)
CCT = 449n³ + 3525n² + 6823.3n + 5520.33
```

分母是 `(0.1858 − y)`。寫成 `(y − 0.1858)` 不會報錯、不會除以零、不會 NaN，就是安安靜靜給你一個錯的數字。代入 sRGB 標準白點 D65（x = 0.3127, y = 0.3290，出自 IEC 61966-2-1）：公式正確算出約 6505 K（D65 標稱約 6504 K，出處待查證：CIE 15），分母符號反了算出約 4664 K。差了快 2000 K，然後全實驗室開始懷疑彩度計的濾片老化。

還有一個更隱蔽的版本：n 的寫法和三次項符號是成對的。n 用 `(0.1858 − y)` 時三次項是 `+449n³`；有些文獻把 n 寫成 `(x − 0.3320) / (y − 0.1858)`，這時三次項是 `−449n³`、一次項是 `−6823.3n`。兩種寫法各抄一半，D65 只差幾 K，色溫越高差越多，只檢查「6400～6600 K 之間」的 sanity check 擋不住，所以測試要再加一條「兩種寫法逐位一致」。

這種錯最好的防禦不是 code review，是把 sanity check 寫進 pytest，讓 CI 替你擋：

```python
# test_metrics.py — metrics 模組的上線前關卡（CI 必跑，fail 就擋 release）
# 已查證：Sharma 頁面公開 test data 檔與驗證程式。
# 待查證：test data 筆數（前作記載 34 組，未逐行核對）。

import csv
from metrics import cct_mccamy, delta_E00   # 全公司唯一 metrics 模組

def test_cct_mccamy_forms_agree():
    """n 的兩種寫法（分母 0.1858 − y 或 y − 0.1858）配上各自的係數符號，結果必須一致。"""
    x, y = 0.3127, 0.3290
    n1 = (x - 0.3320) / (0.1858 - y)
    n2 = (x - 0.3320) / (y - 0.1858)
    a = 449 * n1**3 + 3525 * n1**2 + 6823.3 * n1 + 5520.33
    b = -449 * n2**3 + 3525 * n2**2 - 6823.3 * n2 + 5520.33
    assert abs(a - b) < 1e-6 and abs(cct_mccamy(x, y) - a) < 1e-6

def test_cct_mccamy_d65_sanity():
    """D65 白點代入應得約 6500 K 量級；分母符號寫反會得約 4664 K。"""
    # D65 xy 已查證（sRGB，IEC 61966-2-1）：0.3127, 0.3290
    cct = cct_mccamy(0.3127, 0.3290)
    assert 6400 < cct < 6600, f"CCT sanity fail: {cct}（符號或公式寫錯）"

def test_delta_e00_against_sharma_test_data():
    """逐對比對 Sharma 公開 test data；任何一對不符就擋。"""
    with open("testdata/sharma_ciede2000.txt") as f:
        for row in csv.reader(f, delimiter="\t"):
            Lab1 = tuple(float(v) for v in row[0:3])
            Lab2 = tuple(float(v) for v in row[3:6])
            expected = float(row[6])
            assert abs(delta_E00(Lab1, Lab2) - expected) < 1e-4, (Lab1, Lab2)
```

第二層錯誤：CCT 只對 Planckian locus 附近的白點有意義。量 R/G/B primary 時，色度直接用 xy 或 CIE 1976 u'v' 呈現與設 gate，不要碰 CCT 公式。API 層可以直接擋（輸入離白點太遠就 raise），避免下游產出無意義數字還拿去開會。

### 根因三：ΔE 兩站不同源，gate 低於儀器自身精度

情境模擬：lab 站算出 ΔE00 = 0.6，產線驗證站算出 1.1，同一台機器、同一個灰階。追下去發現兩個站各自手寫 xyY→XYZ→Lab→ΔE00：lab 站的 Lab 轉換用 D65 參考白，產線站沿襲 ICC 相對色度的習慣用了 D50。參考白不同，同一組 xyY 的 Lab 就不同，ΔE00 當然系統性對不上。

修法很無聊但有效：全公司只有一份 metrics 模組、一份常數檔。Lab 參考白的 XYZ 常數依採用的標準版本（CIE 15 或 sRGB IEC 61966-2-1）定案一次，兩站共用，禁止各站手抄。

```python
# metrics.py — 全公司唯一的量測換算模組（兩個站別都 import 這一份）
# Lab 參考白的 Xn、Zn 由定案的白點 xy 直接推導（Yn 正規化為 1.0），不手抄常數；
# 採用哪個標準版本的白點 xy 全公司定案一次，站別間不得各自手抄。

from dataclasses import dataclass

@dataclass(frozen=True)
class WhitePoint:
    name: str
    x: float
    y: float
    Xn: float   # 由 xy 推導：Xn = x / y × Yn
    Yn: float
    Zn: float

def make_whitepoint(name: str, x: float, y: float, Yn: float = 1.0) -> WhitePoint:
    """由白點 xy 推導 Xn、Zn（CIE 標準轉換），避免手抄常數或留下 0.0 佔位值。"""
    return WhitePoint(name, x, y, x / y * Yn, Yn, (1.0 - x - y) / y * Yn)

# D65 的 xy 已查證（sRGB，IEC 61966-2-1）：x=0.3127, y=0.3290
WHITEPOINTS = {
    "D65": make_whitepoint("D65", 0.3127, 0.3290),
}

def uv_prime(x: float, y: float) -> tuple[float, float]:
    """CIE 1976 u'v'（CIE 標準轉換）。primary 與色域 gate 用這個。"""
    d = -2.0 * x + 12.0 * y + 3.0
    return (4.0 * x / d, 9.0 * y / d)

def xyY_to_XYZ(x: float, y: float, Y: float) -> tuple[float, float, float]:
    """CIE 標準轉換：X = x·Y/y，Z = (1−x−y)·Y/y。y=0 為無效輸入，先擋。"""
    if y <= 0.0:
        raise ValueError("invalid chromaticity: y must be > 0")
    return (x * Y / y, Y, (1.0 - x - y) * Y / y)
```

ΔE00 的實作本身也有坑（rotor/hue 角度處理），不要自己發明，用 Sharma 等人公開的 implementation notes 與 test data 逐對驗證（G. Sharma, W. Wu, E. N. Dalal, Color Research and Application, vol. 30, No. 1, pp. 21–30, February 2005；test data 與驗證程式在 Rochester 大學頁面公開下載）。

然後是 gate。產線訂 ΔE00 ≤ 0.5，聽起來很嚴，但 CA-410 白色色度精度在亮度 >0.1 cd/m² 是 ±0.002、>0.01 cd/m² 是 ±0.003（KM news release 2017-11-09，CA-P427 標準探頭，於 KM 標準光源 6500K 量測）。這是對 KM 標準光源的絕對準確度；用 metrics 模組把白點 xy 偏移 0.002 換算成 ΔE00，結果可能就已經超過 0.5（推論，請以你的白點與亮度實算）。

這裡要分清楚兩件事：拿量測值對絕對規格（例如白點目標）判定時，絕對準確度要算進去；同一台儀器重複量、兩站互比時，看的是重複性與再現性，要用 GR&R 實測（MSA 觀念）。gate 必須訂在這兩者換算出的量測誤差 × 安全係數之上；低亮度檔精度較寬，gate 跟著分檔；0.01 cd/m² 以下已超出色度精度保證範圍，不做色度判定：

```python
# gate.py — 判定門檻必須吃進量測誤差（MSA 觀念：量測系統誤差先於產品誤差）
# 已查證：±0.002 / ±0.003（KM news release 2017-11-09，白色，CA-P427，KM 標準光源 6500K）。
# 推論：SAFETY_FACTOR 為個人經驗推論；grr_de00 為本站 GR&R 實測值（待查證：本站實測數據）。
from metrics import WHITEPOINTS, xyY_to_XYZ, XYZ_to_Lab, delta_E00   # XYZ_to_Lab 依 CIE 公式實作（略）

CHROMA_ACC = {"high": 0.002, "mid": 0.003}   # >0.1 / >0.01 cd/m²（白色）
SAFETY_FACTOR = 2.0

def accuracy_as_de00(x: float, y: float, Y_rel: float, acc: float, wp) -> float:
    """把 xy 精度換算成 ΔE00：x、y 各往正負方向偏移 acc，取最大值。Y_rel 為相對參考白的亮度。"""
    ref = XYZ_to_Lab(xyY_to_XYZ(x, y, Y_rel), wp)
    return max(delta_E00(ref, XYZ_to_Lab(xyY_to_XYZ(x + dx, y + dy, Y_rel), wp))
               for dx, dy in ((acc, 0.0), (-acc, 0.0), (0.0, acc), (0.0, -acc)))

def gate_delta_e(x: float, y: float, lv: float, lv_white: float, grr_de00: float,
                 wp=WHITEPOINTS["D65"]) -> float:
    """ΔE00 gate 下限：max(絕對精度換算, GR&R 實測) × 安全係數。lv 單位 cd/m²。"""
    if lv <= 0.01:
        raise ValueError("below chromaticity accuracy-guaranteed range")
    band = "high" if lv > 0.1 else "mid"
    floor = max(accuracy_as_de00(x, y, lv / lv_white, CHROMA_ACC[band], wp), grr_de00)
    return floor * SAFETY_FACTOR
```

### 根因四：輪詢節奏沒跟著量測速度分檔

CA-410 的保證量測速度（Lvxy AUTO）依亮度分三檔：>0.001 cd/m² 為 1 次/秒、>0.15 cd/m² 為 5 次/秒、>2 cd/m² 為 20 次/秒（KM news release 2017-11-09）。腳本用固定 50 ms（=20 次/秒）節奏輪詢，量高灰階剛好，量到 10% 以下灰階時儀器還在積分，腳本就把上一次的殘值或過渡值讀走，重測率直接飆上去。

修法在驅動層已經寫了：依亮度分檔的等待時間＋完成碼握手。但還有 DUT 端這一半：ABL、local dimming、ALS 自動亮度這些動態行為，會讓 xy 在儀器積分期間自己漂移。scaler 韌體要提供「量測穩定模式」，進入後鎖住所有動態調整，並讓腳本確認「已生效」才開始量（DDC/CI 的 ack 只代表匯流排層收到，不代表執行完成，這點前作已反覆驗證）：

```c
/* meas_stable.c — 量測穩定模式（示意架構） */
/* 以下暫存器地址與 Macro 均為示意地址，非實際晶片規格 */

#define ABL_ENABLE          0x0100 /* 示意地址，非實際晶片規格：bit0=ABL enable */
#define LD_ENGINE_ENABLE    0x0110 /* 示意地址，非實際晶片規格：bit0=local dimming enable */
#define ALS_ENABLE          0x0120 /* 示意地址，非實際晶片規格：bit0=ALS auto brightness enable */
#define MEAS_STABLE_STATUS  0x0130 /* 示意地址，非實際晶片規格：bit0=stable mode committed */

#define Scaler_Write_Register_Byte(addr, val) write_reg8(addr, val) /* 示意 Macro，非實際晶片規格 */
#define Scaler_Read_Register_Byte(addr)       read_reg8(addr)       /* 示意 Macro，非實際晶片規格 */

/* 進入量測穩定模式：鎖 ABL/local dimming/ALS，commit 完成才置 status。 */
void Meas_StableEnter(void)
{
    /* 先清掉上一輪留下的 status，避免讀到殘留的 1 就直接返回 */
    Scaler_Write_Register_Byte(MEAS_STABLE_STATUS, 0x00);
    Scaler_Write_Register_Byte(ABL_ENABLE,       0x00);
    Scaler_Write_Register_Byte(LD_ENGINE_ENABLE, 0x00);
    Scaler_Write_Register_Byte(ALS_ENABLE,       0x00);
    /* commit 於幀邊界生效（時序依 panel spec，示意）；完成後由 FW 置 bit0 */
    while ((Scaler_Read_Register_Byte(MEAS_STABLE_STATUS) & 0x01) == 0) {
        /* 含 timeout 保護（略）：逾時回錯誤碼，不可無限等 */
    }
}
```

腳本端用 ddcutil 讀回確認（ddcutil 的 detect/getvcp/setvcp/scs 與 --bus/--display 為官方文件記載的用法；下面的 VCP code 是示意，取自 MCCS 保留給廠商自訂的 E0h–FFh 範圍；不要拿 0xDC，那是 MCCS 標準定義的 Display Application，寫下去會切換畫面模式。VESA MCCS 本地規格庫未收，頁碼待查證）：

```python
# ddcutil 指令已查證（ddcutil 官方文件）：detect/getvcp/setvcp/scs、--bus/--display、getvcp --terse 輸出格式。
# MEAS_STABLE_VCP 為示意 code（MCCS 廠商自訂範圍 E0h–FFh；實際值待查證：scaler SDK）。
import subprocess
import time

MEAS_STABLE_VCP = "E0"   # 示意，非實際機種定義；不可用 DC（MCCS Display Application）

def read_vcp_snc(bus: int, code: str) -> int:
    """以 --terse 讀簡單非連續型 VCP，輸出格式為 VCP <code> SNC x<值>（ddcutil getvcp 文件）。"""
    out = subprocess.run(["ddcutil", "--bus", str(bus), "--terse", "getvcp", code],
                         capture_output=True, text=True, check=True).stdout.split()
    if len(out) < 4 or out[0] != "VCP" or out[2] != "SNC":
        raise RuntimeError(f"unexpected ddcutil output: {out}")
    return int(out[3].lstrip("x"), 16)

def wait_measurement_ready(bus: int, timeout_s: float, poll_s: float):
    """寫入後輪詢讀回，等到 FW 回報已生效；ack 不等於執行完成，逾時就報錯。"""
    subprocess.run(["ddcutil", "--bus", str(bus), "setvcp", MEAS_STABLE_VCP, "1"], check=True)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if read_vcp_snc(bus, MEAS_STABLE_VCP) == 1:
            return
        time.sleep(poll_s)
    raise TimeoutError("stable mode not committed")
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某系統廠的廣色域 4K 機種進入 DVT，實驗室建立白點／gamma 量測自動化站：Python 控制 CA-410 量 xyY，算 CCT 與 ΔE00，對 spec gate 判 PASS/FAIL，結果上傳 MES。上線一週，四個症狀輪番上陣。

第一個是腳本開機就 timeout。負責的工程師把另一台 SCPI 儀器的控制框架直接套上 CA-410，儀器完全不理，serial timeout 一路炸，現場第一反應是「儀器壞了」，差點開 RMA 單。實際上 CA-410 根本不講 SCPI，它講 KM 自家指令集，基本命令與 CA-210/310 相容是為了讓舊產線程式沿用。

第二個是色溫算出 4664 K。同一台螢幕白點，CA-410 面板與 KM 軟體都顯示約 6500 K 附近，腳本算出來差快 2000 K。量測現象很乾淨：同一組 xy 餵進腳本，輸出永遠是 4664 K 附近，重現率百分之百。協定層分析根本不用上示波器，這是純數學錯誤：McCamy 公式的 n 分母 `(0.1858 − y)` 被寫成 `(y − 0.1858)`，代入 D65（0.3127, 0.3290）馬上重現。

第三個是兩個站別對同一台 DUT 給出不同 ΔE00：lab 站 0.6、產線站 1.1，SPC chart 上出現兩條平行漂移的線。根因是兩站各自手寫色彩轉換，Lab 參考白一個用 D65、一個用 D50；加上產線 gate（ΔE00 ≤ 0.5）低於儀器色度精度（白點 ±0.002／±0.003）換算的量測系統誤差，gate 本身就站在沙子上。

第四個是低灰階量測值跳動、偶爾量到上一階的殘值。腳本固定 50 ms 節奏連續觸發，但 CA-410 在低亮度是 1 次/秒的速度，儀器還沒積分完就被讀值。加上 DUT 的 ABL 與 local dimming 在暗場自己調整，xy 在積分期間漂移，重測率回到兩位數。

四個症狀，四個根因，共通點只有一個：量測站上線前，沒有人把「儀器講什麼語言、多快、多準」當成規格讀過一遍。

## 新人避坑指南

看懂三張表，這四個坑都不會發生。

**第一張：命令集歸屬表。** 動手寫驅動前，先問這台儀器講什麼語言。SCPI 儀器走 SCPI/IEEE 488.2；Chroma 2238 走自家 ASCII 命令（手冊 §3.2）；CA-410 走 KM 自有協定，命令字串以官方「CA-410 Communication Specifications」為唯一來源，下載前讀清楚授權條款（限開發搭配 CA-410 的軟體，商用需 KM 授權）。兩種驅動分開寫，不共用 query-response 抽象。

**第二張：速度表。** CA-410 保證量測速度（Lvxy AUTO）：>0.001 cd/m² 為 1 次/秒、>0.15 cd/m² 為 5 次/秒、>2 cd/m² 為 20 次/秒。你的輪詢節奏、timeout、takt time 全部從這張表推導，低亮度檔至少等 1 秒以上，以完成碼握手，不用固定 sleep。

**第三張：精度表。** 白點色度精度 >0.1 cd/m² 為 ±0.002、>0.01 cd/m² 為 ±0.003（CA-P427 標準探頭，KM 標準光源 6500K 量測；0.01 cd/m² 以下不保證色度精度）。你的 gate 下限是「儀器精度 × 安全係數」，不是你想要多嚴。低亮度檔精度較寬，gate 跟著分檔。

寫 code 與驗證時的具體規則：

- CCT 只用在白點；primary 與色域 gate 用 xy／u'v'。McCamy 公式 n 分母是 `(0.1858 − y)`，三次項是 `+449n³`（符號跟 n 的寫法成對），上線前用 D65（0.3127, 0.3290）代入驗證應得約 6500 K 量級，並把這條 sanity check 寫進 pytest。
- ΔE00 實作上線前用 Sharma 公開 test data 逐對驗證，驗證本身寫成 CI 必跑的 test case。
- xyY→XYZ→Lab→ΔE00 全公司一份 metrics 模組；Lab 參考白常數定案一次、兩站共用，禁止各站手抄。
- DUT 端提供量測穩定模式（鎖 ABL/local dimming/ALS），腳本確認 commit 生效才開始量；DDC/CI 的 ack 不等於執行完成。
- 量測結果綁 FW build hash、DUT 序號、儀器序號與 probe 韌體版本，出事才追得到。
- 儀器零校正（zero calibration）開機必做，環境溫度變化時也要重做（CA-410 instruction manual PDF p.54）；耗時以你手上的韌體版本實測為準（待查證：本次在 instruction manual 中查無耗時數字），排進 takt，不要在迴圈內反覆觸發。

## 思考題

CA-410 的白點色度精度表為什麼要用「亮度」分檔（>0.01 cd/m² ±0.003、>0.1 cd/m² ±0.002），而不是給一個單一數字？提示：想想彩度計在低亮度時的積分時間與訊噪比，以及這對你設計「低灰階 gate」與「量測 timeout」的影響。答案在 KM 官方新聞稿與 CA-410 instruction manual 裡，動手查過一次，你對量測系統的理解會上一個台階。

<details><summary>方向提示（先自己查再點開）</summary>

低亮度時訊號弱，儀器需要更長的積分時間才能達到同樣的訊噪比，所以速度變慢（1 次/秒）、精度也變寬（±0.003）。這代表低灰階的 gate 要放寬、timeout 要拉長，兩者都從同一份官方規格推導，不要拍腦袋。

</details>

## 參考資料

- Konica Minolta news release「Konica Minolta to Launch CA-410」（2017-11-09）：0.001–5,000 cd/m² 保證精度範圍、白點亮度精度 ±9%/±2%/±1.5%、白點色度精度 ±0.003/±0.002、量測速度 1/5/20 次/秒、USB 2.0/RS-232C、色度顯示 4 位數、KM 標準光源 6500K（以上數值為 CA-P427 標準探頭）。官方：https://www.konicaminolta.com/newsroom/2017/1109-01-01.html
- Konica Minolta 軟體下載頁：「Display Color Analyzer CA-410 Communication Specifications Ver 1.13」（含 Conditions for Use 條款入口）、CA-S40/CA-SDK2 Ver 2.21；下載需同意 EULA 後以 email 取得連結。官方：https://www.konicaminolta.com/instruments/download/software/display/index.html
- Konica Minolta CA-410 instruction manual（Probe + CA-DP40）：probe RS-232C 38,400 bps 與 PC 經 RS-232C 控制 probe 使用 CA-SDK2（PDF p.19）、CA-DP40 鮑率設定（PDF p.111）、零校正（PDF p.54）、VRR-Flicker 需 FW Ver. 1.40 以上（PDF p.125）。官方：https://www.konicaminolta.com/instruments/download/instruction_manual/display/pdf/ca-410_instruction_probe-dp_eng.pdf
- Konica Minolta CA-410 catalog：basic communication commands 與 CA-210/310 相同、CA-SDK2、USB virtual COM port（PDF p.2）。官方：https://www.konicaminolta.com/instruments/download/catalog/display/pdf/ca410_catalog_eng.pdf
- ddcutil Command Overview：detect/capabilities/getvcp/setvcp/scs、--display/--bus。官方：https://www.ddcutil.com/commands/
- ddcutil getvcp 指令說明：--terse 輸出格式（VCP <code> SNC x<值> 等）。官方：https://www.ddcutil.com/command_getvcp/
- VESA Monitor Control Command Set（MCCS）：VCP DCh 為 Display Application、E0h–FFh 保留給廠商自訂。本地規格庫未收，版本與頁碼待查證。
- G. Sharma, W. Wu, E. N. Dalal, "The CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary Test Data, and Mathematical Observations," Color Research and Application, vol. 30, No. 1, pp. 21–30, February 2005；公開 test data 與 Matlab/Excel 驗證程式。非官方學術頁：https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/
- C. S. McCamy, "Correlated color temperature as an explicit function of chromaticity coordinates for conversion formulas," Color Research & Application, 17(2):142–144, 1992（公開文獻；McCamy 公式係數出處）
- sRGB 標準（IEC 61966-2-1）：D65 白點 x=0.3127, y=0.3290（官方標準；數字為該標準公開內容）

提醒：HDMI/DP 規格全文與儀器通訊規格多需會員、授權或 NDA，本文只依公開資訊撰寫；實作時請對照你手上的授權文件與 NDA 範圍。

[^1]: Konica Minolta CA-410 instruction manual（Probe + CA-DP40），PDF p.19（見參考資料）。
