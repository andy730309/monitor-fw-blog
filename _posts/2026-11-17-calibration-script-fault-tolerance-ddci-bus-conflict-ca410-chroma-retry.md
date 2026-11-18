---
layout: post
title: "重試三次反而更糟？校正腳本遇上 DDC/CI 匯流排衝突、認錯 DUT、儀器斷線與 pattern 沒換的四種錯誤分類"
date: 2026-11-17
tags: [DDC/CI, ddcutil, CA-410, Chroma 2238, 自動化校正]
level: intermediate
prerequisites: ["DDC/CI 與 MCCS VCP 基礎", "ddcutil 命令列操作", "序列埠與 USB virtual COM 基本觀念"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: practitioner
sources_checked: 2026-11-17
difficulty: intermediate
---
## 前置知識

先想像一間只有一支對講機的工地。你想叫三個人做事，但對講機只有一個頻道：你按下發話鍵，說完就放開，對方有沒有聽到、有沒有做完，對講機不會告訴你。於是現場出現三種人：一種會回「收到」，一種只會沉默，一種會回「我現在沒空」。如果你把這三種沉默都當成「沒收到，再講一次」，就會出現很荒謬的畫面：明明對方在忙，你連講三次，他三次都沒空，你以為對講機壞了。

產線校正腳本面對的就是這支對講機。它要同時指揮三個東西：

- **DUT 的 DDC/CI 介面**：走 I2C，host 送 VCP 命令，顯示器回一個應答。匯流排是共用資源，同一台機器上可能有不只一支程式在講話。
- **量測儀器（CA-410）**：走 USB virtual COM 或 RS-232C，用 Konica Minolta 自家的指令集，不是 SCPI。命令與回應靠序列埠一問一答。
- **訊號產生器（Chroma 2238）**：送 `RUN TIM`／`RUN PTN` 換 timing 與 pattern。儀器會回 `OK;` 或 `NG;`（User's Manual §3.2，PDF p.65），但 `OK;` 只代表命令被接受並開始執行，不代表 DUT 畫面已經穩定。

新手最常犯的錯，是把這三件事都包進同一個 `try: ... except: retry(3)`。這在「單一程式、單一設備、負載很輕」的實驗室裡看起來能用，一上產線就開始出現「重跑就過」「換班就錯」「整批同一個偏色」這種查不出原因的症狀。這篇要拆的，就是「重試」這兩個字底下其實有四種完全不同的錯誤。

## 技術核心

### 錯誤不是一種：先分類，再決定要不要重試

把校正站會遇到的異常攤開，至少四類，處置方式互相衝突：

| 錯誤類型 | 典型症狀 | 正確處置 | 如果一律重試 |
|---|---|---|---|
| 暫態匯流排錯誤 | I2C NAK、Null Message 表示 not ready | 退避重試，全程持鎖 | 與別人交錯，資料污染 |
| 身分錯誤 | bus 漂移、序號對不上 | 重新解析身分，不重試舊位址 | 校正值寫到別台 DUT |
| 儀器離線 | CA-410 timeout、USB 重列舉 | drain、關閉、重建、身分查詢 | 殘留回應被下個命令讀走 |
| 動作未生效 | pattern 沒換、timing 沒套上 | 用可觀測證據驗證，冪等重送 | 量到上一張圖，整批同錯 |

看出來了嗎？只有第一類該重試。第二類重試只會把錯的地方再錯三次；第三類重試會讓序列埠緩衝區越來越髒；第四類重試則是把「命令有沒有送到」跟「世界有沒有改變」混為一談。

所以第一件事不是寫 retry 迴圈，是寫四個例外類別，讓呼叫端只能接住它真的能處理的那一種。

```python
# station_guard.py — 錯誤分類骨架（架構示意，非任何廠商 SDK）
class TransientBusError(Exception): ...   # I2C NAK / Null Message(not ready)
class IdentityError(Exception): ...       # 序號或 EDID 對不上
class InstrumentDown(Exception): ...      # 儀器無回應，需重建連線
class ActionNotApplied(Exception): ...    # 命令送出，但可觀測狀態沒變
```

四個類別各自對應一段處置，不是一個 `except Exception`。

### 坑一：ddcutil 的 lock 不是萬靈丹

ddcutil 官方文件對 I2C 的描述很直白：I2C 本身就是不可靠的協定，需要重試管理。它預設的 tries 是 write-only 4 次、write-read 10 次、multi-part 8 次，上限 15 次。這是**單一持有者**在單一指令上的重試。

多個持有者就是另一回事。ddcutil 2.0 加入 cross-instance locking：開啟 display handle 時對 `/dev/i2c` 做 `flock()`，關閉才釋放，用意就是避免兩個 ddcutil／libddcutil 實例互相蓋掉 DDC 交易。但這段保護有三個破口：

- 舊版 ddcutil 沒有這個 lock。產線站若還釘在 1.x，等於裸奔。
- 它可以用 `--disable-cross-instance-locks` 關掉。ddcutil FAQ 提到的 KDE Plasma 6 案例就是反過來：PowerDevil 開著 handle 不放，把其他程式鎖死。
- 不走 ddcutil 的程式完全不受約束。自寫的 I2C 工具、面板廠調機程式，直接開 `/dev/i2c-N`，flock 對它沒有意義。

實務結論：**站內所有 DDC 寫入路徑都要經過同一把站級鎖**，而且鎖的範圍是「寫入＋讀回驗證＋store」整段，不是只包住一行 `setvcp`。你包一行，別支程式還是可以在你「寫完、還沒驗證」的空檔插進來。

```python
# station_guard.py — 站級互斥（重點：鎖的粒度是交易，不是指令）
class StationBusLock:
    def __init__(self, lock_dir: str, bus_no: int):
        self.path = os.path.join(lock_dir, f"ddc-bus-{bus_no}.lock")

    def __enter__(self):
        self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o664)
        fcntl.flock(self.fd, fcntl.LOCK_EX)   # 跨行程；同站所有工具都要遵守
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)
```

同一支程式內多執行緒還不夠，因為產線上常常是「校正主程式＋功耗記錄排程」兩支不同程式。

### 坑二：bus number 是這次開機的列舉結果，不是設備身分

Linux kernel 的 i2c-dev 文件寫得很清楚：「Adapter numbers are assigned somewhat dynamically, so you can not assume much about them. They can even change from one boot to the next.」白話就是：`/dev/i2c-7` 這個 7，只是這次開機時裝置被列舉到的順序。

把 `--bus 7` 存進工單，等於把「這次開機的裝置順序」當成設備序號。換班重開機、插拔 USB、多掛一台螢幕，都可能讓它變成 8。更陰險的是同型機：`--display 1` 指的是「第一個被偵測到的」，不是「貼著工單序號的那一台」。

ddcutil 的 display selection 文件列得很清楚：`--bus`、`--display`、`--sn`、`--edid`、`--mfg`、`--model`。其中只有 EDID 內容（含序號）是跟著 DUT 走的。正確做法是工單只存序號，每次掛載重新解析：

```python
# dut_locator.py — 用 EDID 序號反查本次開機的 bus（parser 為示意，需以固定版本驗證）
def resolve_bus_by_serial(serial: str) -> int:
    out = subprocess.run(["ddcutil", "detect", "--verbose"],
                         capture_output=True, text=True, timeout=60).stdout
    hits = []
    # 先按「Display N」／「Invalid display」切塊，避免跨塊配對
    for blk in re.split(r"\n(?=\S)", out):
        if not blk.startswith("Display "):
            continue                          # 跳過 Invalid display（沒有 DDC/CI）
        m_bus = re.search(r"/dev/i2c-(\d+)", blk)
        m_sn = re.search(r"Serial number:[ \t]*(\S*)", blk)   # 只抓同一行，空序號不跨行
        if m_bus and m_sn and m_sn.group(1) == serial:
            hits.append(int(m_bus.group(1)))
    if len(hits) != 1:
        raise IdentityError(f"serial {serial}: expected 1 bus, got {hits}")
    return hits[0]
```

還有三個細節。第一，先按「Display N」切塊再找序號：如果整段輸出用一條跨行的 regex 去配，某台螢幕沒有序號時，會把下一行或下一台的字串配給它（calc/t16.txt 有實例）；「Invalid display」（沒有 DDC/CI）也要排除。第二，`ddcutil detect --verbose` 的輸出格式會隨版本變，這段 parser 只是示意，站上要用固定版本跑 golden sample 驗證，升版要重跑。第三，`--bus` 不要跟 `--display` 一起給，ddcutil FAQ 明講指定 `--bus` 時不應再給其他 monitor selection option；混用只會讓你以為指定了某一台，實際上不是。

### 坑三：Null Message 有兩種意思，而且處置相反

VESA DDC/CI 1.1 第 6.4 節定義的 DDC Null Message，用途之一是顯示器告訴 host「我現在沒有答案」。ddcutil 的文件把它拆成兩種情境：

- 讀 VCP 或 capabilities 時收到 Null Message，多半是顯示器還沒準備好，**應該延長等待後重試**。
- 有些顯示器用 Null Message 表示「這個功能我不支援」，**正確反應是不重試**。

ddcutil 自己在偵測階段會去讀一個永遠不存在的 VCP 0x00，就是為了判斷這台機器屬於哪一種。你的腳本如果自己再包一層「收到 Null 就重試 3 次」，遇到第二種機器就是白等三次，順便把後面的量測節奏全部往後推。

因此重試次數不能寫死，要看錯誤語意。這也是為什麼上一節要先把例外分類。

### 坑四：序列埠 timeout 不代表儀器沒送

CA-410 走 USB virtual COM（KM catalog）或 RS-232C，RS-232C 預設 38,400 bps（KM instruction manual），協定是 KM 自有指令集，不是 SCPI，回應長度與完成碼都由 KM 文件定義（實際字串待查證）。

序列埠 timeout 的麻煩在於：它只代表「期限內沒讀到完整回應」，不代表儀器沒送。緩衝區裡可能躺著半個回應，你下一個命令的 read 會先讀到這段殘留，形成 off-by-one：量到的 xyY 其實是上一個動作的。PyVISA 文件對此描述得很直接，timeout 常見原因是 termination 設定錯、儀器太慢、query 後沒給 delay，而且「有些儀器對通訊錯誤的反應很差，你可能得重開它才能恢復」。

所以正確順序不是原地重送，而是：

1. drain（清空收發緩衝）
2. close（關閉埠，讓 USB 重列舉有機會恢復）
3. open（重建）
4. 身分查詢（確認回話的是同一台、同一型）
5. 才恢復量測

```python
# ca410_link.py — 連線層（架構示意；命令常數為佔位，需查 KM 通訊規格）
CMD_ID = b"__ID__"     # 待查證：KM 文件中的機型／版本查詢命令
BAUD   = 38_400        # 已查證：KM instruction manual（RS-232C 預設）

class Ca410Link:
    def open(self):
        # exclusive：避免同一支 probe 被兩個行程同時開（pyserial）
        self.ser = serial.Serial(self.port, BAUD, timeout=0.2, exclusive=True)
        self._drain()
        self._send(CMD_ID)
        self._expect_identity(timeout_s=2.0)

    def recover(self):
        try:
            if self.ser:
                self.ser.close()
        finally:
            self.ser = None
            time.sleep(0.5)   # USB 重列舉 settle，需實機標定
            self.open()
```

還有一個常被忽略的維度：CA-410 的量測速度依亮度分三檔（1／5／20 次/秒，KM 2017-11-09 新聞稿）。低亮度時量一次本來就要一秒以上，timeout 若設得比量測時間短，就會把「正常但慢」誤判成「斷線」，接著 reopen，變成無限迴圈。timeout 要跟著量測條件走，不是全域一個常數。

### 坑五：2238 回了 OK，畫面也不一定換好了，你只能看證據

2238 的公開手冊寫的是 `RUN TIM xxxx ;` 與 `RUN PTN xxxx ;`（User's Manual §3.2.2，RS-232 115200 8-N-1 見 §3.1），語意是「載入 timing 並啟用」「載入 pattern 並啟用」。手冊 §3.2 說，系統收到命令會先檢查參數，執行正常就回 `OK`，否則回 `NG`，例如 `NG; BOUNDARY ERROR:`（PDF p.65）。所以參數打錯是看得到的，一定要讀回覆。但手冊沒有「畫面已輸出穩定」的查詢命令；`OK` 是在什麼時間點回，手冊沒寫清楚（待查證，需實機量測）。

Chroma 官網標示 8K@60Hz 的 pattern 切換時間小於 0.2 秒，但那是 VPG 圖形核心換圖的時間，不含 DUT 的 mode change／link retrain、面板背光與 overdrive 進入穩態、量測儀器的積分時間。固定睡 300 ms 只涵蓋其中一段，而且是最理想的情況。

所以 pattern 切換的「成功」只能用證據定義：

- 數值落在該 pattern 的合理範圍（全白亮度要比全黑高一個數量級以上）；
- 連續兩次量測的差值落在儀器重複性範圍內。注意 CA-410 的 ±0.003／±0.002 是白點色度「準確度」（KM 2017-11-09 新聞稿），比較連續兩次讀值要看的是「重複性」，數值請查 CA-410 規格表（待查證）。

```python
# chroma2238_pattern.py — 命令語法與 OK;／NG; 回覆已查證（手冊 §3.2）；重試策略為設計
def _cmd(self, line: str):
    self.link.write(line)
    reply = self.link.read_until(b";", timeout_s=2.0)   # 回覆逾時值需實機標定
    if not reply.strip().startswith(b"OK"):
        self.link.drain()                    # NG 後面可能還有錯誤說明，先清掉
        raise ActionNotApplied(f"2238 replied {reply!r} to {line!r}")

def load(self, timing_id: int, pattern_id: int):
    self._cmd(f"RUN TIM {timing_id:04d} ;")
    self._cmd(f"RUN PTN {pattern_id:04d} ;")

def apply_and_verify(self, timing_id, pattern_id, measure, expect):
    for _ in range(2):                       # 冪等命令，重送一次安全
        self.load(timing_id, pattern_id)     # NG 直接丟 ActionNotApplied，不重送
        if self._settled(measure, expect, timeout_s=5.0):
            return
    raise ActionNotApplied("pattern not observed; check input/timing/module port")
```

重送最多一次就停。第二次還是沒變化，問題通常不在儀器，而在 signal path：input 選錯、timing 根本不存在、多 signal module 時命令落到別的 port。這時候再重送一百次也不會變。

### 韌體端也要配合：busy 要講清楚，完成要留下證據

前面都是站端的事，但韌體如果扯後腿，站端再聰明也只能猜。兩個常見的韌體壞習慣：

1. DDC/CI 還在處理上一次寫入時，把新命令默默吞掉。host 讀回得到舊值，以為沒生效，再寫一次，無限迴圈。
2. 用 Null Message 表示「我很忙」。host 依照規格可能解讀成「不支援」，直接放棄。

比較好的做法是提供可讀的 busy 狀態與單調遞增的 commit counter，讓 host 能分辨「還沒好」與「不會好」：

```c
/* ddc_ci_cmd.c — 架構示意；0xE0／0xE1 為示意 vendor VCP（MCCS 把 E0h–FFh 留給廠商） */
#include <stdint.h>

#define VCP_RED_GAIN     0x16   /* MCCS 2.2a：Video Gain (Drive): Red（PDF p.34） */
#define VCP_COMMIT_CNT   0xE0   /* 示意：vendor VCP，完成計數 */
#define VCP_BUSY         0xE1   /* 示意：vendor VCP，1 = 上一筆還在處理 */

extern void apply_gain_async(uint16_t value);   /* 示意：實際為 scaler 內部 API */
extern int  cal_pipeline_idle(void);            /* 示意 API */

static volatile uint8_t  s_cal_busy;
static volatile uint16_t s_commit_counter;
static volatile uint16_t s_rejected_while_busy; /* 除錯用：busy 時被拒的次數 */

/* DDC/CI 的 Set VCP 沒有回覆，所以 busy 時拒收「本身」host 看不到；
 * 規則是 host 寫之前先讀 VCP_BUSY，寫完以 VCP_COMMIT_CNT 變化判定生效。 */
void ddc_ci_on_set_vcp(uint8_t code, uint16_t value)
{
    if (code == VCP_RED_GAIN) {
        if (s_cal_busy) {
            s_rejected_while_busy++;  /* 拒收並留下紀錄，host 讀 busy 可知 */
            return;
        }
        s_cal_busy = 1;
        apply_gain_async(value);
    }
}

/* Get VCP 對應的值（其他 VCP 由原本的處理函式負責，示意） */
uint16_t ddc_ci_on_get_vcp(uint8_t code)
{
    switch (code) {
    case VCP_BUSY:       return s_cal_busy;
    case VCP_COMMIT_CNT: return s_commit_counter;
    default:             return 0;
    }
}

void cal_task_tick(void)
{
    if (s_cal_busy && cal_pipeline_idle()) {
        s_commit_counter++;      /* 先更新 counter，再清 busy，host 不會看到「不忙但沒生效」 */
        s_cal_busy = 0;
    }
}
```

DDC/CI 的 Set VCP 沒有回覆，所以 host 的規則是：寫之前先讀 busy，寫完看 counter 有沒有加一。`0xE0`／`0xE1` 只是示意，正式機種要跟 FW 團隊確認自家 vendor VCP 表，並確認要不要列進 capabilities string。重點在語意：**busy 讀得到、完成有證據**，host 就不需要用固定 sleep 去猜。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 ODM 廠的產線校正站，一個工位跑四台 DUT。流程很標準：2238 送全白 pattern，CA-410 量 xyY，ddcutil 寫 RGB gain，迭代到 ΔE 收斂，最後 Save Current Settings。白天試跑都順，夜班開始出現三種症狀。

第一種是偶發的「DDC communication failed」，同一台重跑就過。追下去發現工位上還有另一支排程在讀亮度做功耗記錄，兩支程式都對同一張顯示卡下的 `/dev/i2c-N` 下命令。ddcutil 的 cross-instance lock 幫不上忙，因為其中一支是自寫的 I2C 工具。

第二種是換班重開機後，第一台 DUT 的校正值寫到第二台。腳本把開機時抓到的 `--bus 7` 寫進工單設定檔，隔天 bus 變成 8；兩台又是同型機，`--display 1` 照樣指到「第一個被偵測到的」，資料就這樣記到錯的序號。

第三種最陰險：pattern 明明換了，量測值卻還是上一張圖。腳本送完 `RUN PTN` 固定睡 300 ms 就量，多數時候沒事，遇到 8K timing 或 signal module 剛切換就量到過渡幀。更糟的一次是 `RUN PTN` 參數打錯，2238 其實回了 `NG;`，但腳本從來不讀回覆，照樣量、照樣算出一個「合格」的 gain。整批 DUT 被調到同一個錯的白點。

客訴進來是「這批螢幕色溫偏綠，而且偏的位置都一樣」。第一線先懷疑面板批次，換了 panel 還是一樣，才回頭查校正資料。最後的結論很難看：不是面板問題，是校正資料本身被污染。而污染的原因，是三種不同性質的異常被同一支 `retry(3)` 蓋住。

## 新人避坑指南

- **先問「這是哪一類錯誤」，再問「重試幾次」**。分不出類，就代表你的錯誤處理還沒開始寫。
- **DDC/CI 的鎖要包整段交易**。寫入、讀回驗證、store 三段要在同一個鎖裡，不然別人會插在中間。
- **工單不要存 bus number，也不要存 display number**。存 EDID 序號，每次掛載重新解析；解析出 0 台或 2 台都停線，不要「取第一個」。
- **`--bus` 與 `--display` 不要同時下**。ddcutil 文件明講 `--bus` 不應與其他 selection option 併用。
- **看到 Null Message 先問語意**。是「還沒好」還是「不支援」？用 VCP 0x00 的探測結果當參考，不要一律重試。
- **序列埠 timeout 後先 drain 再重建**。原地重送會讓下一個命令讀到上一個回應的殘尾。
- **timeout 跟著量測條件走**。CA-410 低亮度一次要一秒以上，用全域 200 ms 會把「慢」當「斷」。
- **pattern 切換先讀 `OK;`／`NG;`，再用證據驗證**。數值範圍 gate 加收斂 gate，兩個都過才算換圖成功；固定 sleep 只是祈禱。
- **重試要留下紀錄**。attempt 次數、錯誤分類、當下 bus 與序號都要進報表，不然沒人知道重測率是被誰撐高的。

## 思考題

假設你的站上有兩支程式都會寫 DDC/CI：一支是校正主程式，一支是每 30 秒讀一次亮度的功耗記錄。你已經在兩支程式裡都加了同一把 flock，為什麼還是可能出錯？請從「鎖的粒度」與「程式沒有遵守鎖」兩個角度各舉一個情境。

<details>
<summary>提示</summary>

鎖的粒度：如果功耗記錄只鎖住「讀 VCP 0x10」這一行，校正主程式在「寫 gain 完、還沒驗證」的空檔仍可能被插隊，驗證讀到的值就不是自己寫的。

沒有遵守鎖：如果站上還有第三支自寫的 I2C 工具直接開 `/dev/i2c-N`，它根本不會去拿 flock，你的鎖對它無效。這時要靠站規（所有工具統一入口）或核心層的匯流排獨佔來解決，不是再加一層 retry。

</details>

## 參考資料

- ddcutil, Performance and Tuning Options（DDC/CI 40–200 ms 等待、`--maxtries` 預設 write-only 4／write-read 10／multi-part 8、上限 15）：https://www.ddcutil.com/performance_options/ （官方文件）
- ddcutil, Frequently Asked Questions（2.0 的 cross-instance locking、`flock()`、`--disable-cross-instance-locks`、`--bus` 不與其他 selection 併用、VCP 0x00 探測）：https://www.ddcutil.com/faq/ （官方文件）
- ddcutil, Display Selection（`--bus`／`--display`／`--sn`／`--edid`）：https://www.ddcutil.com/display_selection/ （官方文件）
- ddcutil, DDC Null Message（引用 DDC/CI Standard 1.1, 2004-10-29 §6.4；not ready 與 unsupported 的處置差異）：https://www.ddcutil.com/ddc_null_response/ （官方文件）
- Linux kernel documentation, Implementing I2C device drivers in userspace（adapter 編號動態指定、跨開機可能改變）：https://www.kernel.org/doc/html/latest/i2c/dev-interface.html （官方文件）
- PyVISA documentation, Communicating with your instrument（timeout、`query_delay`、termination、部分儀器通訊錯誤後需 restart）：https://pyvisa.readthedocs.io/en/latest/introduction/communication.html （官方文件）
- Chroma ATE, Model 2238 Video Pattern Generator 產品頁（8K@60Hz 換圖 < 0.2 秒、最多 4 張 signal module）：https://www.chromaate.com/en/product/video_pattern_generator_2238_287 （官方）
- Chroma ATE, Video Pattern Generator 2238 User's Manual（§3.1 RS-232 115200 8-N-1、§3.2 回覆 `OK;`／`NG;`（PDF p.65）、§3.2.2 `RUN TIM`／`RUN PTN`）：https://www.acquisys.fr/wp-content/uploads/2018/06/en_2238_usermanual_1709rv.pdf （官方文件之公開鏡像）
- Konica Minolta, CA-410 news release（2017-11-09；量測速度 1／5／20 次/秒、白點色度精度 ±0.003／±0.002、USB 2.0／RS-232C）：https://www.konicaminolta.com/newsroom/2017/1109-01-01.html （官方）
- Konica Minolta, CA-410 instruction manual（RS-232C 38,400 bps）：https://www.konicaminolta.com/instruments/download/instruction_manual/display/pdf/ca-410_instruction_probe-dp_eng.pdf （官方）
- The SCPI Consortium, SCPI 1999.0（`*OPC?` 等完成查詢的標準來源；本篇僅作對照，CA-410 不適用 SCPI）：https://www.ivifoundation.org/downloads/SCPI/scpi-99.pdf （官方標準 PDF）
